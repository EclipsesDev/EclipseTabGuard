export type VideoTimestampThresholdMode = "none" | "alert" | "save";

export type Settings = {
  enabled: boolean;
  /** Minutes a tab must be inactive before being suspended. Default: 3 */
  timeoutMinutes: number;
  /** Never suspend pinned tabs */
  skipPinned: boolean;
  /** Never suspend tabs currently playing audio */
  skipAudible: boolean;
  /** Never suspend the currently active tab */
  skipActive: boolean;
  /** Never suspend tabs that are still loading */
  skipLoading: boolean;
  /** Suspend all background tabs immediately when the browser starts */
  suspendOnStartup: boolean;
  /** Periodically pre-fetch suspended tab URLs to warm the HTTP cache (BETA) */
  cacheWarm: boolean;
  /** How often (in minutes) cache warming runs. Default: 10 */
  cacheWarmIntervalMinutes: number;
  /** Save and restore video timestamps when a video is paused */
  saveVideoTimestamps: boolean;
  /** Show a notification after a video timestamp is saved */
  showVideoTimestampAlerts: boolean;
  /** Apply the minimum change to alerts, saves, or neither */
  videoTimestampThresholdMode: VideoTimestampThresholdMode;
  /** Minimum change in seconds for the selected threshold mode */
  videoTimestampThresholdSeconds: number;
  /** Suppress re-saving the same timestamp after an Undo */
  videoTimestampUndoCooldownSeconds: number;
  /** Domain or URL patterns to never suspend */
  whitelist: string[];
  /** Domain or URL patterns to always suspend immediately (ignores timeout) */
  blacklist: string[];
  /** Automatically close duplicate tabs, keeping the leftmost one */
  closeDuplicates: boolean;
  /** Duplicate-closing mode: 1 = keep leftmost, 2 = keep latest (most recently used/created) */
  closeDuplicatesMode: 1 | 2;
  /** When true, re-scan existing tabs when duplicate-closing is re-enabled so newly-created duplicates while disabled get cleaned up */
  closeDuplicatesKeepChecking: boolean;
  /** When true, run a duplicate re-scan on extension startup */
  closeDuplicatesRescanOnStartup: boolean;
};

export type TabRecord = {
  tabId: number;
  lastActiveAt: number; // epoch ms
};

export type TabInfo = {
  id: number;
  title: string;
  url: string;
  favIconUrl: string;
  discarded: boolean;
  active: boolean;
  pinned: boolean;
  windowId: number;
};

export type VideoTimestampRecord = {
  id: string;
  pageUrl: string;
  title: string;
  videoIndex: number;
  timestampSeconds: number;
  durationSeconds: number;
  updatedAt: number;
  revision?: string;
};

export function createVideoTimestampId(pageUrl: string, videoIndex: number): string {
  let canonicalUrl = pageUrl;
  let isYouTubeVideo = false;
  try {
    const url = new URL(pageUrl);
    url.hash = "";
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    let videoId: string | null = null;

    if (hostname === "youtu.be") {
      videoId = url.pathname.split("/").filter(Boolean)[0] ?? null;
    } else if (hostname === "youtube.com" || hostname.endsWith(".youtube.com") || hostname === "youtube-nocookie.com") {
      if (url.pathname === "/watch") {
        videoId = url.searchParams.get("v");
      } else {
        videoId = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1] ?? null;
      }
    }

    canonicalUrl = videoId
      ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
      : url.href;
    isYouTubeVideo = videoId != null;
  } catch {
    canonicalUrl = pageUrl;
  }

  return JSON.stringify([canonicalUrl, isYouTubeVideo ? 0 : videoIndex]);
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  timeoutMinutes: 3,
  skipPinned: false,
  skipAudible: true,
  skipActive: true,
  skipLoading: false,
  suspendOnStartup: true,
  cacheWarm: false,
  cacheWarmIntervalMinutes: 10,
  saveVideoTimestamps: false,
  showVideoTimestampAlerts: true,
  videoTimestampThresholdMode: "save",
  videoTimestampThresholdSeconds: 30,
  videoTimestampUndoCooldownSeconds: 10,
  closeDuplicates: false,
  closeDuplicatesMode: 2,
  closeDuplicatesKeepChecking: true,
  closeDuplicatesRescanOnStartup: true,
  whitelist: [],
  blacklist: [],
};

export type StoredSettings = Partial<Settings> & {
  saveVideoPositions?: boolean;
  showVideoPositionAlerts?: boolean;
  videoPositionThresholdMode?: VideoTimestampThresholdMode;
  videoPositionThresholdSeconds?: number;
  videoPositionUndoCooldownSeconds?: number;
  rememberVideoTimestamps?: boolean;
  rememberVideoPositions?: boolean;
};

export function normalizeSettings(settings?: StoredSettings): Settings {
  if (!settings) return { ...DEFAULT_SETTINGS };

  const {
    rememberVideoTimestamps,
    rememberVideoPositions,
    saveVideoPositions,
    showVideoPositionAlerts,
    videoPositionThresholdMode,
    videoPositionThresholdSeconds,
    videoPositionUndoCooldownSeconds,
    ...currentSettings
  } = settings;
  const mode = currentSettings.videoTimestampThresholdMode ?? videoPositionThresholdMode;
  const seconds = currentSettings.videoTimestampThresholdSeconds ?? videoPositionThresholdSeconds;
  const undoCooldownSeconds = currentSettings.videoTimestampUndoCooldownSeconds ?? videoPositionUndoCooldownSeconds;
  const alerts = currentSettings.showVideoTimestampAlerts ?? showVideoPositionAlerts;
  if (mode !== undefined && mode !== "none" && mode !== "alert" && mode !== "save") {
    console.warn("EclipseTabGuard ignored an invalid video timestamp threshold mode:", mode);
  }
  if (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400)) {
    console.warn("EclipseTabGuard ignored an invalid video timestamp threshold:", seconds);
  }
  if (undoCooldownSeconds !== undefined &&
    (!Number.isInteger(undoCooldownSeconds) || undoCooldownSeconds < 0 || undoCooldownSeconds > 86400)) {
    console.warn("EclipseTabGuard ignored an invalid video timestamp undo cooldown:", undoCooldownSeconds);
  }
  if (alerts !== undefined && typeof alerts !== "boolean") {
    console.warn("EclipseTabGuard ignored an invalid video timestamp alert setting:", alerts);
  }
  return {
    ...DEFAULT_SETTINGS,
    ...currentSettings,
    saveVideoTimestamps:
      currentSettings.saveVideoTimestamps ??
      saveVideoPositions ??
      rememberVideoTimestamps ??
      rememberVideoPositions ??
      DEFAULT_SETTINGS.saveVideoTimestamps,
    showVideoTimestampAlerts: typeof alerts === "boolean" ? alerts : DEFAULT_SETTINGS.showVideoTimestampAlerts,
    videoTimestampThresholdMode:
      mode === "none" || mode === "alert" || mode === "save" ? mode : DEFAULT_SETTINGS.videoTimestampThresholdMode,
    videoTimestampThresholdSeconds:
      typeof seconds === "number" && Number.isInteger(seconds) && seconds >= 1 && seconds <= 86400
        ? seconds : DEFAULT_SETTINGS.videoTimestampThresholdSeconds,
    videoTimestampUndoCooldownSeconds:
      typeof undoCooldownSeconds === "number" && Number.isInteger(undoCooldownSeconds) &&
        undoCooldownSeconds >= 0 && undoCooldownSeconds <= 86400
        ? undoCooldownSeconds : DEFAULT_SETTINGS.videoTimestampUndoCooldownSeconds,
  };
}