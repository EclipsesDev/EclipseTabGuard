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

  function sendDelete(id: string): void {
    chrome.runtime.sendMessage({ type: "deleteVideoPosition", id }, (response: { ok?: boolean } | undefined) => {
      if (chrome.runtime.lastError) {
        console.warn("EclipseTabGuard could not clear a saved video timestamp:", chrome.runtime.lastError.message);
      } else if (!response?.ok) {
        console.warn("EclipseTabGuard could not clear a saved video timestamp.");
      }
    });
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
    }, (response: { ok?: boolean } | undefined) => {
      if (chrome.runtime.lastError) {
        console.warn("EclipseTabGuard could not save a video timestamp:", chrome.runtime.lastError.message);
      } else if (!response?.ok) {
        console.warn("EclipseTabGuard could not save a video timestamp.");
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

  function setEnabled(value: boolean): void {
    if (enabled === value) return;
    enabled = value;
    restoreRequests = new WeakMap<HTMLVideoElement, string>();

    if (!enabled) {
      observer?.disconnect();
      observer = null;
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
    observer.observe(document.documentElement, { childList: true, subtree: true });
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
