import type { Settings, VideoPositionRecord } from "../types/index.js";
import { createVideoPositionId, normalizeSettings } from "../types/index.js";

const SETTINGS_KEY = "settings";
const globalState = window as Window & { __eclipseTabGuardVideoPositionMonitor?: boolean };

if (!globalState.__eclipseTabGuardVideoPositionMonitor) {
  globalState.__eclipseTabGuardVideoPositionMonitor = true;
  initialize();
}

function initialize(): void {
  let enabled = false;
  let observer: MutationObserver | null = null;
  let observerPending = false;
  const attachedVideos = new WeakSet<HTMLVideoElement>();
  let restoreRequests = new WeakMap<HTMLVideoElement, string>();

  function getPageUrl(): string {
    const url = new URL(location.href);
    url.hash = "";
    return url.href;
  }

  function getVideoIdentity(video: HTMLVideoElement): { id: string; pageUrl: string; videoIndex: number } | null {
    const videoIndex = Array.from(document.querySelectorAll("video")).indexOf(video);
    if (videoIndex < 0) return null;

    const pageUrl = getPageUrl();
    return { id: createVideoPositionId(pageUrl, videoIndex), pageUrl, videoIndex };
  }

  function sendDelete(id: string, onComplete?: (ok: boolean) => void): void {
    chrome.runtime.sendMessage({ type: "deleteVideoPosition", id }, (response: { ok?: boolean } | undefined) => {
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
    previousRecord: VideoPositionRecord | null,
    pendingRecord: VideoPositionRecord | null
  ): void {
    const noticeId = "eclipse-tab-guard-video-save-notice";
    const existing = document.getElementById(noticeId);
    existing?.remove();

    const notice = document.createElement("div");
    notice.id = noticeId;
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    Object.assign(notice.style, {
      alignItems: "stretch",
      background: "linear-gradient(135deg, #202124 0%, #292b58 100%)",
      border: "1px solid rgba(138, 180, 248, 0.55)",
      borderLeft: "4px solid #8ab4f8",
      borderRadius: "10px",
      bottom: "20px",
      boxShadow: "0 8px 28px rgba(0, 0, 0, 0.5)",
      color: "#f1f3f4",
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
    icon.textContent = previousRecord ? "↻" : "✓";
    icon.setAttribute("aria-hidden", "true");
    icon.style.color = "#8ab4f8";
    icon.style.fontSize = "20px";
    icon.style.fontWeight = "700";
    const message = document.createElement("strong");
    message.textContent = previousRecord
      ? "Update saved timestamp?"
      : "Video timestamp saved";
    header.append(icon, message);
    notice.append(header);

    const detail = document.createElement("span");
    detail.textContent = previousRecord
      ? "A timestamp already exists for this video. Choose whether to replace it."
      : "This position will be restored when you return to the video.";
    Object.assign(detail.style, {
      color: "#d8dbe5",
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

    const update = document.createElement("button");
    update.type = "button";
    update.textContent = previousRecord ? "Update timestamp" : "Don't save";
    Object.assign(update.style, {
      background: "#8ab4f8",
      border: "0",
      borderRadius: "5px",
      color: "#17233d",
      cursor: "pointer",
      font: "inherit",
      fontSize: "12px",
      fontWeight: "700",
      padding: "7px 10px",
    });

    const finish = (ok: boolean, updating: boolean): void => {
      if (ok) {
        message.textContent = updating ? "Timestamp updated" : "Video timestamp not saved";
        detail.textContent = updating
          ? "The new position will be restored when you return to the video."
          : "The previous timestamp is still being kept.";
        actions.remove();
        window.setTimeout(() => notice.remove(), 2200);
      } else {
        update.disabled = false;
        update.textContent = "Try again";
        detail.textContent = updating
          ? "Could not update the timestamp."
          : "Could not remove the timestamp.";
      }
    };

    update.addEventListener("click", () => {
      update.disabled = true;
      update.textContent = previousRecord ? "Updating..." : "Removing...";

      if (previousRecord) {
        if (!pendingRecord) {
          finish(false, true);
          return;
        }
        chrome.runtime.sendMessage(
          { type: "updateVideoPosition", record: pendingRecord },
          (response: { ok?: boolean } | undefined) => {
            if (chrome.runtime.lastError) {
              console.warn("EclipseTabGuard could not update the video timestamp:", chrome.runtime.lastError.message);
              finish(false, true);
            } else {
              finish(response?.ok === true, true);
            }
          }
        );
      } else {
        sendDelete(id, (ok) => finish(ok, false));
      }
    });
    actions.append(update);

    if (previousRecord) {
      const keep = document.createElement("button");
      keep.type = "button";
      keep.textContent = "Keep previous";
      Object.assign(keep.style, {
        background: "rgba(255, 255, 255, 0.12)",
        border: "1px solid rgba(255, 255, 255, 0.3)",
        borderRadius: "5px",
        color: "#f1f3f4",
        cursor: "pointer",
        font: "inherit",
        fontSize: "12px",
        fontWeight: "600",
        padding: "7px 10px",
      });
      keep.addEventListener("click", () => {
        notice.remove();
      });
      actions.append(keep);
    }
    notice.append(actions);

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Dismiss timestamp notification");
    dismiss.textContent = "×";
    Object.assign(dismiss.style, {
      background: "transparent",
      border: "0",
      color: "#bdc1c6",
      cursor: "pointer",
      font: "20px/1 system-ui, sans-serif",
      padding: "0",
      position: "absolute",
      right: "8px",
      top: "6px",
    });
    dismiss.addEventListener("click", () => notice.remove());
    notice.append(dismiss);

    document.documentElement.append(notice);
    window.setTimeout(() => {
      if (notice.isConnected) notice.remove();
    }, previousRecord ? 10000 : 6000);
  }

  function savePosition(video: HTMLVideoElement): void {
    if (!enabled) return;

    const identity = getVideoIdentity(video);
    if (!identity) return;

    if (video.ended || !Number.isFinite(video.currentTime) || video.currentTime < 0.5) {
      sendDelete(identity.id);
      return;
    }

    chrome.runtime.sendMessage({
      type: "saveVideoPosition",
      record: {
        ...identity,
        title: document.title || "Untitled video",
        positionSeconds: video.currentTime,
        durationSeconds: Number.isFinite(video.duration) ? video.duration : 0,
      },
    }, (response: {
      ok?: boolean;
      previousRecord?: VideoPositionRecord | null;
      pendingRecord?: VideoPositionRecord | null;
    } | undefined) => {
      if (chrome.runtime.lastError) {
        console.warn("EclipseTabGuard could not save a video timestamp:", chrome.runtime.lastError.message);
      } else if (!response?.ok) {
        console.warn("EclipseTabGuard could not save a video timestamp.");
      } else {
        showSaveNotice(
          identity.id,
          response.previousRecord ?? null,
          response.pendingRecord ?? null
        );
      }
    });
  }

  function enforceSavedPosition(
    video: HTMLVideoElement,
    id: string,
    record: VideoPositionRecord,
    attemptsRemaining: number
  ): void {
    if (!enabled || attemptsRemaining <= 0 || video.ended) return;

    const identity = getVideoIdentity(video);
    if (!identity || identity.id !== id) return;
    if (Number.isFinite(video.duration) && record.positionSeconds >= video.duration) return;
    if (video.currentTime > record.positionSeconds + 2) return;

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA && !video.seeking
      && video.currentTime < record.positionSeconds - 2) {
      try {
        video.currentTime = record.positionSeconds;
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
      { type: "getVideoPosition", id: identity.id },
      (response: { record?: VideoPositionRecord | null } | undefined) => {
        if (chrome.runtime.lastError) {
          console.warn("EclipseTabGuard could not load a saved video timestamp:", chrome.runtime.lastError.message);
          return;
        }

        const record = response?.record;
        if (!enabled || !record || !Number.isFinite(record.positionSeconds)) return;
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
      return;
    }

    observeDocument();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes[SETTINGS_KEY]) return;
    setEnabled(normalizeSettings(changes[SETTINGS_KEY].newValue as Partial<Settings> & {
      saveVideoPositions?: boolean;
    } | undefined).saveVideoPositions);
  });

  chrome.storage.sync.get(SETTINGS_KEY).then((result) => {
    setEnabled(normalizeSettings(result[SETTINGS_KEY] as Partial<Settings> & {
      saveVideoPositions?: boolean;
    } | undefined).saveVideoPositions);
  }).catch((error: unknown) => {
    console.error("EclipseTabGuard could not read video-timestamp settings:", error);
  });
}
