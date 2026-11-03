export {};

import type { Settings, StoredSettings, TabRecord, TabInfo, VideoPositionRecord } from "../types/index.js";
import { createVideoPositionId, DEFAULT_SETTINGS, normalizeSettings } from "../types/index.js";

// Keeps track of when each tab was last used.
// Stored in session storage so it survives service worker restarts.
const ACTIVITY_KEY = "tabActivity";
const TAB_MEMORY_KEY = "tabMemory";
const SETTINGS_KEY = "settings";
const LIFETIME_STATS_KEY = "lifetimeStats";
const VIDEO_POSITIONS_KEY = "savedVideoPositions";
const ALARM_NAME = "suspendCheck";
const CHECK_INTERVAL_MINUTES = 1;
const CACHE_WARM_ALARM = "cacheWarm";

// Used when we can't get real memory data (e.g. Firefox without COOP/COEP pages)
const MEM_PER_TAB_MB_FALLBACK = 70;
// Best-guess for how much data a suspended tab would have consumed if left running
const BW_PER_SUSPEND_MB = 2;

// Chrome exposes process-level memory through chrome.processes, but it's not in
// the standard type definitions, so we describe just the parts we actually use.
interface ChromeProcess {
  privateMemory?: number;
}
interface ChromeProcesses {
  getProcessIdForTab(tabId: number, cb: (pid: number) => void): void;
  getProcessInfo(
    pids: number[],
    includeMemory: boolean,
    cb: (info: Record<number, ChromeProcess>) => void
  ): void;
}

// This runs inside the tab itself to get its memory footprint.
// Returns bytes if the browser supports it, null if there's nothing we can do.
async function measureTabMemory(): Promise<number | null> {
  // The most accurate per-page method — requires COOP + COEP headers (most sites don't set them)
  if (typeof (performance as Performance & { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> }).measureUserAgentSpecificMemory === "function") {
    try {
      const r = await (performance as Performance & { measureUserAgentSpecificMemory: () => Promise<{ bytes: number }> }).measureUserAgentSpecificMemory();
      return r.bytes;
    } catch {
      // Page isn't cross-origin isolated, so this API throws — move on
    }
  }
  const perfMemory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  if (typeof perfMemory?.usedJSHeapSize === "number" && perfMemory.usedJSHeapSize > 0) {
    return perfMemory.usedJSHeapSize;
  }
  return null;
}

type TabMemoryCache = Record<string, number>;

async function loadTabMemoryCache(): Promise<Map<number, number>> {
  const result = await chrome.storage.session.get(TAB_MEMORY_KEY);
  const raw = (result[TAB_MEMORY_KEY] ?? {}) as TabMemoryCache;
  return new Map(Object.entries(raw).map(([k, v]) => [Number(k), v]));
}

async function saveTabMemoryCache(map: Map<number, number>): Promise<void> {
  const raw: TabMemoryCache = {};
  for (const [k, v] of map) raw[String(k)] = v;
  await chrome.storage.session.set({ [TAB_MEMORY_KEY]: raw });
}

async function captureTabMemory(tabId: number): Promise<number | null> {
  if (typeof chrome.scripting?.executeScript !== "function") return null;

  try {
    const results = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId },
        func: measureTabMemory,
      }),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 500)),
    ]);
    const bytes = results?.[0]?.result;
    return typeof bytes === "number" && bytes > 0 ? bytes : null;
  } catch {
    return null;
  }
}

async function recordTabMemory(tabId: number): Promise<void> {
  const bytes = await captureTabMemory(tabId);
  if (bytes == null) return;

  const cache = await loadTabMemoryCache();
  cache.set(tabId, bytes);
  await saveTabMemoryCache(cache);
}

// Figures out how much RAM the given tabs are currently using.
// Tries the most accurate method first and falls back if something isn't available.
// Returns the MB value plus a flag indicating whether it is a rough estimate.
async function getTabsMemoryMB(tabs: chrome.tabs.Tab[]): Promise<{ mb: number; estimated: boolean }> {
  const tabIds = tabs.map((t) => t.id).filter((id): id is number => id != null);
  if (tabIds.length === 0) return { mb: 0, estimated: false };

  // Best option: Chrome's built-in process API gives us real private memory per process
  const procs: ChromeProcesses | undefined =
    typeof (chrome as unknown as Record<string, unknown>).processes === "object"
      ? (chrome as unknown as { processes: ChromeProcesses }).processes
      : undefined;

  if (procs?.getProcessIdForTab) {
    try {
      const pids = await Promise.all(
        tabIds.map(
          (id) => new Promise<number>((resolve) => procs.getProcessIdForTab(id, resolve))
        )
      );
      const uniquePids = [...new Set(pids.filter((p) => p >= 0))];
      if (uniquePids.length > 0) {
        const info = await new Promise<Record<number, ChromeProcess>>((resolve) =>
          procs.getProcessInfo(uniquePids, true, resolve)
        );
        const totalBytes = Object.values(info).reduce(
          (sum, p) => sum + (p.privateMemory ?? 0),
          0
        );
        return { mb: totalBytes / (1024 * 1024), estimated: false };
      }
    } catch {
      // Something went wrong with the processes API — try the next method
    }
  }

  // Last resort: just multiply by a fixed per-tab estimate
  return { mb: tabIds.length * MEM_PER_TAB_MB_FALLBACK, estimated: true };
}

async function loadActivity(): Promise<Map<number, number>> {
  const result = await chrome.storage.session.get(ACTIVITY_KEY);
  const raw = (result[ACTIVITY_KEY] ?? {}) as Record<string, number>;
  return new Map(Object.entries(raw).map(([k, v]) => [Number(k), v]));
}

async function saveActivity(map: Map<number, number>): Promise<void> {
  const raw: Record<string, number> = {};
  for (const [k, v] of map) raw[String(k)] = v;
  await chrome.storage.session.set({ [ACTIVITY_KEY]: raw });
}

type VideoPositionInput = Omit<VideoPositionRecord, "id" | "updatedAt">;

let videoPositionWriteQueue: Promise<void> = Promise.resolve();

async function loadVideoPositions(): Promise<Record<string, VideoPositionRecord>> {
  const result = await chrome.storage.local.get(VIDEO_POSITIONS_KEY);
  const raw = (result[VIDEO_POSITIONS_KEY] ?? {}) as Record<string, VideoPositionRecord>;
  const normalized: Record<string, VideoPositionRecord> = {};
  let needsPersistence = false;

  for (const [storedId, record] of Object.entries(raw)) {
    if (!record || typeof record.pageUrl !== "string" || !Number.isInteger(record.videoIndex)) {
      needsPersistence = true;
      console.warn("EclipseTabGuard ignored a malformed saved video timestamp record:", record);
      continue;
    }
    const id = createVideoPositionId(record.pageUrl, record.videoIndex);
    const existing = normalized[id];
    if (storedId !== id || record.id !== id || existing) needsPersistence = true;
    if (!existing || record.updatedAt >= existing.updatedAt) {
      normalized[id] = { ...record, id };
    }
  }

  if (needsPersistence) {
    await chrome.storage.local.set({ [VIDEO_POSITIONS_KEY]: normalized });
  }

  return normalized;
}

function updateVideoPositions(
  update: (positions: Record<string, VideoPositionRecord>) => void
): Promise<void> {
  const operation = videoPositionWriteQueue.then(async () => {
    const positions = await loadVideoPositions();
    update(positions);
    await chrome.storage.local.set({ [VIDEO_POSITIONS_KEY]: positions });
  });
  videoPositionWriteQueue = operation.catch((error: unknown) => {
    console.error("EclipseTabGuard could not update saved video timestamps:", error);
  });
  return operation;
}

function normalizeVideoPositionInput(value: unknown): VideoPositionInput | null {
  if (typeof value !== "object" || value == null) return null;
  const input = value as Partial<VideoPositionInput>;
  if (
    typeof input.pageUrl !== "string" ||
    typeof input.title !== "string" ||
    !Number.isInteger(input.videoIndex) ||
    typeof input.videoIndex !== "number" ||
    input.videoIndex < 0 ||
    typeof input.positionSeconds !== "number" ||
    !Number.isFinite(input.positionSeconds) ||
    input.positionSeconds <= 0 ||
    typeof input.durationSeconds !== "number" ||
    !Number.isFinite(input.durationSeconds) ||
    input.durationSeconds < 0
  ) {
    return null;
  }

  try {
    const pageUrl = new URL(input.pageUrl);
    if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") return null;
    pageUrl.hash = "";
    return {
      pageUrl: pageUrl.href,
      title: input.title.slice(0, 300),
      videoIndex: input.videoIndex,
      positionSeconds: input.positionSeconds,
      durationSeconds: input.durationSeconds,
    };
  } catch {
    return null;
  }
}

async function injectVideoPositionScript(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id == null || tab.discarded || !/^https?:\/\//i.test(tab.url ?? "")) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/video-timestamp.js"],
    });
  } catch (error) {
    console.warn(`EclipseTabGuard could not monitor videos on ${tab.url}:`, error);
  }
}

async function loadSettings(): Promise<Settings> {
  const result = await chrome.storage.sync.get(SETTINGS_KEY);
  return normalizeSettings(result[SETTINGS_KEY] as StoredSettings | undefined);
}

type PatternMatch =
  | { kind: "url"; value: URL }
  | { kind: "domain"; value: string };

function normalizePattern(pattern: string): PatternMatch | null {
  const raw = pattern.trim();
  if (!raw) return null;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const looksLikeUrl = hasScheme || /[/?#]/.test(raw);

  if (looksLikeUrl) {
    try {
      const value = new URL(hasScheme ? raw : `https://${raw}`);
      value.hash = "";
      if (value.pathname !== "/") value.pathname = value.pathname.replace(/\/+$/, "");
      return { kind: "url", value };
    } catch {
      // Fall back to treating the input as a domain pattern.
    }
  }

  return { kind: "domain", value: raw.toLowerCase() };
}

function matchesPattern(url: string, pattern: string): boolean {
  const resolvedPattern = normalizePattern(pattern);
  if (!resolvedPattern) return false;

  try {
    const current = new URL(url);

    if (resolvedPattern.kind === "url") {
      current.hash = "";
      if (current.pathname !== "/") current.pathname = current.pathname.replace(/\/+$/, "");
      return (
        current.origin === resolvedPattern.value.origin &&
        current.pathname === resolvedPattern.value.pathname &&
        current.search === resolvedPattern.value.search
      );
    }

    const hostname = current.hostname.toLowerCase();
    return hostname === resolvedPattern.value || hostname.endsWith(`.${resolvedPattern.value}`);
  } catch {
    return false;
  }
}

function matchesDomainList(url: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(url, pattern));
}

async function runSuspensionCheck(force = false): Promise<void> {
  const settings = await loadSettings();
  if (!settings.enabled) return;

  const activity = await loadActivity();
  const now = Date.now();
  const thresholdMs = settings.timeoutMinutes * 60 * 1000;

  const tabs = await chrome.tabs.query({});
  const activeTabIds = new Set(
    (await chrome.tabs.query({ active: true })).map((t) => t.id)
  );

  let newSuspensions = 0;
  for (const tab of tabs) {
    if (tab.id == null || tab.discarded) continue;
    if (settings.skipPinned && tab.pinned) continue;
    if (settings.skipAudible && tab.audible) continue;
    if (settings.skipActive && activeTabIds.has(tab.id)) continue;
    if (settings.skipLoading && tab.status === "loading") continue;

    const url = tab.url ?? "";

    // This tab is on the whitelist — never touch it
    if (url && matchesDomainList(url, settings.whitelist)) continue;

    // This tab is blacklisted — suspend it right away regardless of how recently it was used
    const forceDiscard = url && matchesDomainList(url, settings.blacklist ?? []);

    const lastActive = activity.get(tab.id) ?? tab.lastAccessed ?? 0;
    if (forceDiscard || force || now - lastActive >= thresholdMs) {
      try {
        await chrome.tabs.discard(tab.id);
        void recordTabMemory(tab.id);
        newSuspensions++;
      } catch {
        // Tab was probably closed or already gone — nothing to do
      }
    }
  }

  if (newSuspensions > 0) {
    await incrementLifetimeStats({ totalSuspensions: newSuspensions });
  }
}

type LifetimeStats = {
  totalSuspensions: number;
  totalPageLoads: number;
  totalBandwidthBytes: number;
};

async function incrementLifetimeStats(delta: Partial<LifetimeStats>): Promise<void> {
  const r = await chrome.storage.local.get(LIFETIME_STATS_KEY);
  const prev = (r[LIFETIME_STATS_KEY] ?? {}) as LifetimeStats;
  await chrome.storage.local.set({
    [LIFETIME_STATS_KEY]: {
      totalSuspensions: (prev.totalSuspensions ?? 0) + (delta.totalSuspensions ?? 0),
      totalPageLoads: (prev.totalPageLoads ?? 0) + (delta.totalPageLoads ?? 0),
      totalBandwidthBytes: (prev.totalBandwidthBytes ?? 0) + (delta.totalBandwidthBytes ?? 0),
    },
  });
}

// Asks the tab how many bytes it actually downloaded and saves that to our running total.
// We use the browser's resource timing data, which tracks every request the page made.
// Cache hits count as 0 bytes, so we don't inflate the numbers with repeated visits.
async function measureAndRecordBandwidth(tabId: number): Promise<void> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
        const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
        return (navigation?.transferSize ?? 0) + entries.reduce((sum, e) => sum + (e.transferSize ?? 0), 0);
      },
    });
    const bytes = results?.[0]?.result;
    if (typeof bytes === "number" && bytes > 0) {
      await incrementLifetimeStats({ totalBandwidthBytes: bytes });
    }
  } catch {
    // Can't inject here (PDF viewer, extension page, etc.) — just skip it
  }
}

// Closes any tabs that share the same URL as an existing tab.
// Mode: keep leftmost (1) or keep latest (2).
async function closeDuplicateTabs(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.enabled || !settings.closeDuplicates) return;

  const tabs = await chrome.tabs.query({});
  const activity = await loadActivity();

  const groups = new Map<string, chrome.tabs.Tab[]>();

  for (const tab of tabs) {
    const url = tab.url ?? "";
    if (!url || url.startsWith("chrome:")
      || url.startsWith("about:")
      || url.startsWith("chrome-extension:")
      || url.startsWith("moz-extension:")) continue;

    // Normalize: strip hash so #section differences don't count as separate pages
    let normalized: string;
    try {
      const u = new URL(url);
      u.hash = "";
      normalized = u.toString().replace(/\/$/, "");
    } catch {
      normalized = url;
    }

    const arr = groups.get(normalized) ?? [];
    arr.push(tab);
    groups.set(normalized, arr);
  }

  const toClose: number[] = [];

  for (const [, group] of groups) {
    if (group.length < 2) continue;

    let keepId: number | null = null;

    if (settings.closeDuplicatesMode === 2) {
      // Keep the most recently used/created tab. Prefer our activity map,
      // then the browser's lastAccessed, then fallback to index ordering.
      let bestScore = -Infinity;
      for (const t of group) {
        const id = t.id ?? -1;
        const score = (id >= 0 ? (activity.get(id) ?? t.lastAccessed ?? 0) : 0) as number;
        if (score > bestScore) { bestScore = score; keepId = t.id ?? null; }
      }
    } else {
      // Default / mode 1: keep the leftmost (smallest index) tab
      let bestIndex = Infinity;
      for (const t of group) {
        const id = t.id ?? -1;
        const idx = typeof t.index === "number" ? t.index : Infinity;
        if (idx < bestIndex) { bestIndex = idx; keepId = id >= 0 ? id : keepId; }
      }
    }

    for (const t of group) {
      if (t.id == null) continue;
      if (keepId != null && t.id === keepId) continue;
      toClose.push(t.id);
    }
  }

  for (const tabId of toClose) {
    try { await chrome.tabs.remove(tabId); } catch { /* already closed */ }
  }
}

async function recordActivity(tabId: number): Promise<void> {
  const activity = await loadActivity();
  activity.set(tabId, Date.now());
  await saveActivity(activity);
}

async function removeTabRecord(tabId: number): Promise<void> {
  const activity = await loadActivity();
  activity.delete(tabId);
  await saveActivity(activity);
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void recordActivity(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void removeTabRecord(tabId);
  void (async () => {
    const cache = await loadTabMemoryCache();
    if (!cache.delete(tabId)) return;
    await saveTabMemoryCache(cache);
  })();
});

// Whenever a tab finishes loading, reset its idle timer and record the bandwidth it used.
// We only care about real web pages — not new tabs, about: pages, or extension UIs.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    void recordActivity(tabId);
    void recordTabMemory(tabId);
    void loadSettings().then((settings) => {
      if (settings.saveVideoPositions) return injectVideoPositionScript(tab);
    }).catch((error: unknown) => {
      console.error("EclipseTabGuard could not load video-timestamp settings:", error);
    });
    const url = tab.url ?? "";
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void incrementLifetimeStats({ totalPageLoads: 1 });
      void measureAndRecordBandwidth(tabId);
    }
    void closeDuplicateTabs();
  }
});

chrome.tabs.onCreated.addListener(() => {
  void closeDuplicateTabs();
});

// Periodically fetch the URLs of suspended tabs so their content is fresh in the
// browser's HTTP cache. When the user clicks one, DNS/TCP/TLS are already warm
// and the HTML document may already be cached, cutting load time noticeably.
async function runCacheWarm(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.enabled || !settings.cacheWarm) return;

  const tabs = await chrome.tabs.query({ discarded: true });
  const activity = await loadActivity();

  // Pick up to 5 suspended tabs, prioritising the most recently used ones
  const candidates = tabs
    .filter(t => { const u = t.url ?? ""; return u.startsWith("https://") || u.startsWith("http://"); })
    .sort((a, b) => {
      const aLast = a.id != null ? (activity.get(a.id) ?? 0) : 0;
      const bLast = b.id != null ? (activity.get(b.id) ?? 0) : 0;
      return bLast - aLast;
    })
    .slice(0, 5);

  await Promise.allSettled(
    candidates.map(async tab => {
      const url = tab.url!;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        const r = await fetch(url, { cache: "default", signal: controller.signal });
        clearTimeout(timer);
        // Consuming the body stores it in the HTTP cache for the next navigation
        if (r.ok) await r.blob();
      } catch {
        // Network error, timeout, or blocked — skip silently
      }
    })
  );
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void runSuspensionCheck().catch(() => undefined);
  }
  if (alarm.name === CACHE_WARM_ALARM) {
    void runCacheWarm().catch(() => undefined);
  }
});

async function ensureAlarms(cacheWarmIntervalMinutes: number): Promise<void> {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_INTERVAL_MINUTES });
  }

  await chrome.alarms.clear(CACHE_WARM_ALARM);
  await chrome.alarms.create(CACHE_WARM_ALARM, { periodInMinutes: cacheWarmIntervalMinutes });
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  await ensureAlarms(settings.cacheWarmIntervalMinutes);
  const existingActivity = await loadActivity();
  const isFreshStart = existingActivity.size === 0;

  const activity = existingActivity;
  const tabs = await chrome.tabs.query({});
  const now = Date.now();

  if (settings.saveVideoPositions) {
    await Promise.all(tabs.map(injectVideoPositionScript));
  }

  for (const tab of tabs) {
    if (tab.id == null) continue;
    if (!activity.has(tab.id)) {
      // If the browser just started and suspendOnStartup is on, treat background tabs
      // as already expired so they get suspended on the first check
      const isActive = tab.active;
      if (isFreshStart && settings.suspendOnStartup && !isActive) {
        activity.set(tab.id, 0);
      } else {
        activity.set(tab.id, tab.lastAccessed ?? now);
      }
    }
  }
  await saveActivity(activity);

  // If this is a fresh start with suspendOnStartup enabled, don't wait for the first alarm
  if (isFreshStart && settings.suspendOnStartup && settings.enabled) {
    await runSuspensionCheck();
  }

  // If requested, run a duplicate re-scan on startup to remove duplicates already open
  if (settings.closeDuplicates && settings.closeDuplicatesRescanOnStartup) {
    try { await closeDuplicateTabs(); } catch { /* ignore errors */ }
  }

}

// The popup talks to us through message passing — handle whatever it needs
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "saveVideoPosition") {
    const input = normalizeVideoPositionInput(msg.record);
    if (!input) {
      sendResponse({ ok: false, error: "Invalid video timestamp." });
      return;
    }

    const id = createVideoPositionId(input.pageUrl, input.videoIndex);
    let previousRecord: VideoPositionRecord | null = null;
    void updateVideoPositions((positions) => {
      previousRecord = positions[id] ?? null;
      if (!previousRecord) {
        positions[id] = { ...input, id, updatedAt: Date.now() };
      }
    }).then(
      () => sendResponse({
        ok: true,
        previousRecord,
        pendingRecord: previousRecord ? { ...input, id } : null,
      }),
      (error: unknown) => {
        console.error("EclipseTabGuard could not save a video timestamp:", error);
        sendResponse({ ok: false, error: "Could not save this video timestamp." });
      }
    );
    return true;
  }

  if (msg.type === "updateVideoPosition") {
    const record = msg.record as Partial<VideoPositionRecord> | undefined;
    const input = normalizeVideoPositionInput(record);
    if (
      !input ||
      typeof record?.id !== "string" ||
      record.id !== createVideoPositionId(input.pageUrl, input.videoIndex)
    ) {
      sendResponse({ ok: false, error: "Invalid previous video timestamp." });
      return;
    }

    void updateVideoPositions((positions) => {
      positions[record.id!] = { ...input, id: record.id!, updatedAt: Date.now() };
    }).then(
      () => sendResponse({ ok: true }),
      (error: unknown) => {
        console.error("EclipseTabGuard could not update the video timestamp:", error);
        sendResponse({ ok: false, error: "Could not update the video timestamp." });
      }
    );
    return true;
  }

  if (msg.type === "getVideoPosition") {
    const id = typeof msg.id === "string" ? msg.id : "";
    void videoPositionWriteQueue.then(loadVideoPositions).then(
      (positions) => sendResponse({ record: id ? positions[id] ?? null : null }),
      (error: unknown) => {
        console.error("EclipseTabGuard could not load a video timestamp:", error);
        sendResponse({ record: null, error: "Could not load this video timestamp." });
      }
    );
    return true;
  }

  if (msg.type === "getVideoPositions") {
    void videoPositionWriteQueue.then(loadVideoPositions).then(
      (positions) => sendResponse({
        records: Object.values(positions).sort((a, b) => b.updatedAt - a.updatedAt),
      }),
      (error: unknown) => {
        console.error("EclipseTabGuard could not load saved video timestamps:", error);
        sendResponse({ records: [], error: "Could not load saved video timestamps." });
      }
    );
    return true;
  }

  if (msg.type === "deleteVideoPosition") {
    const id = msg.id;
    if (typeof id !== "string") {
      sendResponse({ ok: false, error: "Invalid video timestamp ID." });
      return;
    }

    void updateVideoPositions((positions) => {
      delete positions[id];
    }).then(
      () => sendResponse({ ok: true }),
      (error: unknown) => {
        console.error("EclipseTabGuard could not delete a video timestamp:", error);
        sendResponse({ ok: false, error: "Could not delete this video timestamp." });
      }
    );
    return true;
  }

  if (msg.type === "clearVideoPositions") {
    void updateVideoPositions((positions) => {
      for (const id of Object.keys(positions)) delete positions[id];
    }).then(
      () => sendResponse({ ok: true }),
      (error: unknown) => {
        console.error("EclipseTabGuard could not clear saved video timestamps:", error);
        sendResponse({ ok: false, error: "Could not clear saved video timestamps." });
      }
    );
    return true;
  }

  if (msg.type === "openVideoPosition") {
    const record = msg.record as Partial<VideoPositionRecord> | undefined;
    if (
      !record ||
      typeof record.id !== "string" ||
      typeof record.pageUrl !== "string" ||
      typeof record.videoIndex !== "number" ||
      !Number.isInteger(record.videoIndex) ||
      record.videoIndex < 0
    ) {
      sendResponse({ ok: false, error: "Invalid saved video." });
      return;
    }

    void (async () => {
      const tabs = await chrome.tabs.query({});
      const existingTab = tabs.find((tab) =>
        tab.id != null &&
        typeof tab.url === "string" &&
        createVideoPositionId(tab.url, record.videoIndex!) === record.id
      );

      if (existingTab?.id != null) {
        await chrome.tabs.update(existingTab.id, { active: true });
        await chrome.windows.update(existingTab.windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url: record.pageUrl });
      }
      sendResponse({ ok: true });
    })().catch((error: unknown) => {
      console.error("EclipseTabGuard could not open a saved video:", error);
      sendResponse({ ok: false, error: "Could not open this video." });
    });
    return true;
  }

  if (msg.type === "getStats") {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({});
        const suspendedTabs = tabs.filter((t) => t.discarded);
        const activeTabs = tabs.filter((t) => !t.discarded);
        const r = await chrome.storage.local.get(LIFETIME_STATS_KEY);
        const ls = (r[LIFETIME_STATS_KEY] ?? {}) as LifetimeStats;
        const memoryCache = await loadTabMemoryCache();

        const memoryResult = await Promise.race([
          getTabsMemoryMB(activeTabs),
          new Promise<{ mb: number; estimated: boolean }>((resolve) =>
            setTimeout(() => resolve({ mb: activeTabs.length * MEM_PER_TAB_MB_FALLBACK, estimated: true }), 2500)
          ),
        ]);
        let memorySavedBytes = 0;
        let memorySavedIsEstimated = false;

        for (const tab of suspendedTabs) {
          if (tab.id == null) continue;
          const cachedBytes = memoryCache.get(tab.id);
          if (typeof cachedBytes === "number" && cachedBytes > 0) {
            memorySavedBytes += cachedBytes;
            continue;
          }

          memorySavedBytes += MEM_PER_TAB_MB_FALLBACK * 1024 * 1024;
          memorySavedIsEstimated = true;
        }

        sendResponse({
          total: tabs.length,
          active: activeTabs.length,
          suspended: suspendedTabs.length,
          memoryUsedMB: memoryResult.mb,
          memorySavedMB: memorySavedBytes / (1024 * 1024),
          memoryIsEstimated: memoryResult.estimated || memorySavedIsEstimated,
          bandwidthUsedMB: (ls.totalBandwidthBytes ?? 0) / (1024 * 1024),
          bandwidthSavedMB: (ls.totalSuspensions ?? 0) * BW_PER_SUSPEND_MB,
        } satisfies StatsResponse);
      } catch {
        sendResponse({
          total: 0,
          active: 0,
          suspended: 0,
          memoryUsedMB: 0,
          memorySavedMB: 0,
          memoryIsEstimated: true,
          bandwidthUsedMB: 0,
          bandwidthSavedMB: 0,
        } satisfies StatsResponse);
      }
    })();
    return true;
  }

  if (msg.type === "suspendNow") {
    runSuspensionCheck(true).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "resumeTab") {
    const tabId = msg.tabId as number;
    chrome.tabs.reload(tabId, {}, () => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "getTabs") {
    (async () => {
      const tabs = await chrome.tabs.query({});
      const result: TabInfo[] = tabs.map((t) => ({
        id: t.id ?? -1,
        title: t.title ?? "",
        url: t.url ?? "",
        favIconUrl: t.favIconUrl ?? "",
        discarded: t.discarded ?? false,
        active: t.active ?? false,
        pinned: t.pinned ?? false,
        windowId: t.windowId,
      }));
      sendResponse(result);
    })();
    return true;
  }

  if (msg.type === "focusTab") {
    const tabId = msg.tabId as number;
    const windowId = msg.windowId as number;
    chrome.tabs.update(tabId, { active: true }, () => {
      chrome.windows.update(windowId, { focused: true }, () => sendResponse({ ok: true }));
    });
    return true;
  }
});

export type StatsResponse = {
  total: number;
  active: number;
  suspended: number;
  memoryUsedMB: number;
  memorySavedMB: number;
  /** True when the value is a rough per-tab estimate rather than a real measurement */
  memoryIsEstimated: boolean;
  bandwidthUsedMB: number;
  bandwidthSavedMB: number;
};

// When the user saves settings, recreate the cache-warm alarm with the updated interval
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[SETTINGS_KEY]) {
    const updated = normalizeSettings(changes[SETTINGS_KEY].newValue as StoredSettings | undefined);
    void ensureAlarms(updated.cacheWarmIntervalMinutes);
    const oldSettings = changes[SETTINGS_KEY].oldValue as StoredSettings | undefined;
    const oldSaveVideoTimestamps = normalizeSettings(oldSettings).saveVideoPositions;
    if (!oldSaveVideoTimestamps && updated.saveVideoPositions) {
      void chrome.tabs.query({}).then((tabs) => Promise.all(tabs.map(injectVideoPositionScript))).catch((error: unknown) => {
        console.error("EclipseTabGuard could not prepare open tabs for video-timestamp saving:", error);
      });
    }

    // If duplicate-closing was just enabled (or the extension was enabled) and
    // the user wants us to re-scan existing tabs, run the duplicate closer once.
    const oldClose = oldSettings?.closeDuplicates ?? DEFAULT_SETTINGS.closeDuplicates;
    const oldEnabled = oldSettings?.enabled ?? DEFAULT_SETTINGS.enabled;
    const newClose = updated.closeDuplicates;
    const newEnabled = updated.enabled;
    const wantRescan = updated.closeDuplicatesKeepChecking ?? DEFAULT_SETTINGS.closeDuplicatesKeepChecking;
    if (wantRescan && (!oldClose && newClose || !oldEnabled && newEnabled)) {
      void closeDuplicateTabs();
    }
  }
});

// Holding an open port to the popup prevents the service worker from going idle
// while the user has it open
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "popup") {
    port.onDisconnect.addListener(() => { /* popup closed, port released */ });
  }
});

void init();