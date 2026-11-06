import type { Settings, VideoTimestampRecord } from "../types/index.js";
import { createVideoTimestampId, normalizeSettings } from "../types/index.js";

const SETTINGS_KEY = "settings";
const globalState = window as Window & { __eclipseTabGuardVideoTimestampMonitor?: boolean };

if (!globalState.__eclipseTabGuardVideoTimestampMonitor) {
  globalState.__eclipseTabGuardVideoTimestampMonitor = true;
  initialize();
}

function initialize(): void {
  let settings = normalizeSettings();
  let enabled = false;
  let observer: MutationObserver | null = null;
  let observerPending = false;
  const attachedVideos = new WeakSet<HTMLVideoElement>();
  let restoreRequests = new WeakMap<HTMLVideoElement, string>();
  const undoCooldowns = new Map<string, number>();

  function getPageUrl(): string {
    const url = new URL(location.href);
    url.hash = "";
    return url.href;
  }

  function getVideoIdentity(video: HTMLVideoElement): { id: string; pageUrl: string; videoIndex: number } | null {
    const videoIndex = Array.from(document.querySelectorAll("video")).indexOf(video);
    if (videoIndex < 0) return null;

    const pageUrl = getPageUrl();
    return { id: createVideoTimestampId(pageUrl, videoIndex), pageUrl, videoIndex };
  }

  function sendDelete(id: string, onComplete?: (ok: boolean) => void): void {
    chrome.runtime.sendMessage({ type: "deleteVideoTimestamp", id }, (response: { ok?: boolean } | undefined) => {
      if (chrome.runtime.lastError) {
        console.warn("EclipseTabGuard could not clear a saved video timestamp:", chrome.runtime.lastError.message);
        onComplete?.(false);
      } else if (!response?.ok) {
        console.warn("EclipseTabGuard could not clear a saved video timestamp.");
        onComplete?.(false);
      } else {
        onComplete?.(true);
      }
    });
  }

  function showSaveNotice(
    id: string,
    previousRecord: VideoTimestampRecord | null,
    revision: string | null,
    timestampSeconds: number,
    error?: string
  ): void {
    const noticeId = "eclipse-tab-guard-video-save-notice";
    const existing = document.getElementById(noticeId);
    existing?.remove();

    const notice = document.createElement("div");
    notice.id = noticeId;
    notice.dataset["videoTimestampId"] = id;
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    Object.assign(notice.style, {
      alignItems: "stretch",
      background: "#16162a",
      border: "1px solid #2e2e50",
      borderLeft: "4px solid #7c3aed",
      borderRadius: "10px",
      bottom: "20px",
      boxShadow: "0 8px 28px rgba(0, 0, 0, 0.5)",
      color: "#e2e2f0",
      display: "flex",
      flexDirection: "column",
      font: "14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      left: "20px",
      maxWidth: "min(390px, calc(100vw - 40px))",
      minWidth: "280px",
      padding: "14px 16px",
      position: "fixed",
      zIndex: "2147483647",
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
      alignItems: "center",
      display: "flex",
      gap: "8px",
    });
    const icon = document.createElement("span");
    icon.textContent = error ? "!" : previousRecord ? "↻" : "✓";
    icon.setAttribute("aria-hidden", "true");
    icon.style.color = "#a78bfa";
    icon.style.fontSize = "20px";
    icon.style.fontWeight = "700";
    const message = document.createElement("strong");
    message.textContent = error ? "Could not save video timestamp" : previousRecord
      ? "Video timestamp updated"
      : "Video timestamp saved";
    header.append(icon, message);
    notice.append(header);

    const detail = document.createElement("span");
    detail.textContent = error ?? (previousRecord
      ? "The updated timestamp will be restored when you return to the video."
      : "This timestamp will be restored when you return to the video.");
    Object.assign(detail.style, {
      color: "#c0c0d8",
      fontSize: "12px",
      marginTop: "4px",
    });
    notice.append(detail);

    const actions = document.createElement("div");
    Object.assign(actions.style, {
      display: "flex",
      gap: "8px",
      marginTop: "12px",
    });

    const undo = document.createElement("button");
    undo.type = "button";
    undo.textContent = "Undo";
    Object.assign(undo.style, {
      background: "#7c3aed",
      border: "0",
      borderRadius: "5px",
      color: "#fff",
      cursor: "pointer",
      font: "inherit",
      fontSize: "12px",
      fontWeight: "700",
      padding: "7px 10px",
    });

    let entranceAnimation: Animation | null = null;
    let closing = false;
    let dismissTimer = window.setTimeout(closeNotice, 6000);

    function closeNotice(): void {
      if (closing) return;
      closing = true;
      window.clearTimeout(dismissTimer);
      if (!notice.isConnected) return;
      notice.style.pointerEvents = "none";
      entranceAnimation?.cancel();
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        notice.remove();
        return;
      }
      const animation = notice.animate(
        [{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(10px)" }],
        { duration: 180, easing: "ease-in", fill: "forwards" }
      );
      animation.onfinish = () => notice.remove();
    }

    undo.addEventListener("click", () => {
      window.clearTimeout(dismissTimer);
      undo.disabled = true;
      undo.textContent = "Undoing...";
      chrome.runtime.sendMessage(
        { type: "undoVideoTimestamp", id, revision, previousRecord },
        (response: { ok?: boolean; error?: string } | undefined) => {
          const error = chrome.runtime.lastError?.message ?? response?.error;
          if (error || !response?.ok) {
            console.warn("EclipseTabGuard could not undo the video timestamp:", error ?? "Unknown error");
          }
          if (closing || !notice.isConnected) return;
          if (error || !response?.ok) {
            detail.textContent = error ?? "Could not undo the timestamp.";
            undo.disabled = false;
            undo.textContent = "Try again";
            return;
          }
          const cooldownSeconds = settings.videoTimestampUndoCooldownSeconds;
          if (cooldownSeconds > 0) {
            undoCooldowns.set(id, Date.now() + cooldownSeconds * 1000);
          }
          message.textContent = "Timestamp save undone";
          detail.textContent = previousRecord
            ? "The previous timestamp has been restored."
            : "The timestamp has been removed.";
          actions.remove();
          dismissTimer = window.setTimeout(closeNotice, 2200);
        }
      );
    });
    if (revision) {
      actions.append(undo);
      notice.append(actions);
    }

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Dismiss timestamp notification");
    dismiss.textContent = "×";
    Object.assign(dismiss.style, {
      background: "transparent",
      border: "0",
      color: "#a78bfa",
      cursor: "pointer",
      font: "20px/1 system-ui, sans-serif",
      padding: "0",
      position: "absolute",
      right: "8px",
      top: "6px",
    });
    dismiss.addEventListener("click", closeNotice);
    notice.append(dismiss);

    document.documentElement.append(notice);
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      entranceAnimation = notice.animate(
        [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "translateY(0)" }],
        { duration: 240, easing: "cubic-bezier(0.4, 0, 0.2, 1)" }
      );
    }
  }

  function savePosition(video: HTMLVideoElement): void {
    if (!enabled) return;

    const identity = getVideoIdentity(video);
    if (!identity) return;

    if (video.ended || !Number.isFinite(video.currentTime) || video.currentTime < 0.5) {
      sendDelete(identity.id);
      return;
    }

    const saveSettings = settings;
    const timestampSeconds = video.currentTime;
    const undoCooldown = saveSettings.videoTimestampUndoCooldownSeconds > 0
      ? undoCooldowns.get(identity.id) : undefined;
    if (undoCooldown) {
      if (undoCooldown > Date.now()) {
        return;
      }
      undoCooldowns.delete(identity.id);
    } else {
      undoCooldowns.delete(identity.id);
    }
    chrome.runtime.sendMessage({
      type: "saveVideoTimestamp",
      minimumChangeSeconds: saveSettings.videoTimestampThresholdMode === "save"
        ? saveSettings.videoTimestampThresholdSeconds : 0,
      record: {
        ...identity,
        title: document.title || "Untitled video",
        timestampSeconds,
        durationSeconds: Number.isFinite(video.duration) ? video.duration : 0,
      },
    }, (response: {
      ok?: boolean;
      skipped?: boolean;
      previousRecord?: VideoTimestampRecord | null;
      revision?: string;
      error?: string;
    } | undefined) => {
      const error = chrome.runtime.lastError?.message ?? response?.error;
      if (error || !response?.ok || (!response.skipped && !response.revision)) {
        console.warn("EclipseTabGuard could not save a video timestamp:", error ?? "Unknown error");
        showSaveNotice(identity.id, null, null, timestampSeconds, error ?? "Please try pausing the video again.");
      } else if (!response.skipped && response.revision) {
        const previousRecord = response.previousRecord ?? null;
        const showAlert = saveSettings.showVideoTimestampAlerts &&
          (saveSettings.videoTimestampThresholdMode !== "alert" || !previousRecord ||
            Math.abs(timestampSeconds - previousRecord.timestampSeconds) >= saveSettings.videoTimestampThresholdSeconds);
        if (!showAlert) {
          const existing = document.getElementById("eclipse-tab-guard-video-save-notice");
          if (existing?.dataset["videoTimestampId"] === identity.id) existing.remove();
          return;
        }
        showSaveNotice(
          identity.id,
          previousRecord,
          response.revision,
          timestampSeconds
        );
      }
    });
  }

  function enforceSavedPosition(
    video: HTMLVideoElement,
    id: string,
    record: VideoTimestampRecord,
    attemptsRemaining: number
  ): void {
    if (!enabled || attemptsRemaining <= 0 || video.ended) return;

    const identity = getVideoIdentity(video);
    if (!identity || identity.id !== id) return;
    if (Number.isFinite(video.duration) && record.timestampSeconds >= video.duration) return;
    if (video.currentTime > record.timestampSeconds + 2) return;

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA && !video.seeking
      && video.currentTime < record.timestampSeconds - 2) {
      try {
        video.currentTime = record.timestampSeconds;
      } catch (error) {
        console.warn("EclipseTabGuard could not restore a video timestamp:", error);
      }
    }

    window.setTimeout(
      () => enforceSavedPosition(video, id, record, attemptsRemaining - 1),
      500
    );
  }

  function restorePosition(video: HTMLVideoElement): void {
    if (!enabled || video.readyState < HTMLMediaElement.HAVE_METADATA) return;

    const identity = getVideoIdentity(video);
    if (!identity || restoreRequests.get(video) === identity.id) return;
    restoreRequests.set(video, identity.id);

    chrome.runtime.sendMessage(
      { type: "getVideoTimestamp", id: identity.id },
      (response: { record?: VideoTimestampRecord | null } | undefined) => {
        if (chrome.runtime.lastError) {
          console.warn("EclipseTabGuard could not load a saved video timestamp:", chrome.runtime.lastError.message);
          return;
        }

        const record = response?.record;
        if (!enabled || !record || !Number.isFinite(record.timestampSeconds)) return;
        enforceSavedPosition(video, identity.id, record, 12);
      }
    );
  }

  function attachVideo(video: HTMLVideoElement): void {
    if (!attachedVideos.has(video)) {
      attachedVideos.add(video);
      video.addEventListener("pause", () => savePosition(video));
      video.addEventListener("ended", () => {
        const identity = getVideoIdentity(video);
        if (identity) sendDelete(identity.id);
      });
      video.addEventListener("loadedmetadata", () => restorePosition(video));
      video.addEventListener("canplay", () => restorePosition(video));
    }
    restorePosition(video);
  }

  function scanVideos(): void {
    document.querySelectorAll<HTMLVideoElement>("video").forEach(attachVideo);
  }

  function observeDocument(): void {
    if (!enabled || observer) return;

    const root = document.documentElement;
    if (!root) {
      if (!observerPending) {
        observerPending = true;
        document.addEventListener("DOMContentLoaded", () => {
          observerPending = false;
          observeDocument();
        }, { once: true });
      }
      return;
    }

    scanVideos();
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLVideoElement) attachVideo(node);
          if (node instanceof Element) {
            node.querySelectorAll<HTMLVideoElement>("video").forEach(attachVideo);
          }
        }
      }
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  function setEnabled(value: boolean): void {
    if (enabled === value) return;
    enabled = value;
    restoreRequests = new WeakMap<HTMLVideoElement, string>();

    if (!enabled) {
      observer?.disconnect();
      observer = null;
      undoCooldowns.clear();
      return;
    }

    observeDocument();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes[SETTINGS_KEY]) return;
    settings = normalizeSettings(changes[SETTINGS_KEY].newValue as Partial<Settings> & {
      saveVideoTimestamps?: boolean;
    } | undefined);
    setEnabled(settings.saveVideoTimestamps);
  });

  chrome.storage.sync.get(SETTINGS_KEY).then((result) => {
    settings = normalizeSettings(result[SETTINGS_KEY] as Partial<Settings> & {
      saveVideoTimestamps?: boolean;
    } | undefined);
    setEnabled(settings.saveVideoTimestamps);
  }).catch((error: unknown) => {
    console.error("EclipseTabGuard could not read video-timestamp settings:", error);
  });
}
