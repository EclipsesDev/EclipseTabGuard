export {};

import type { Settings, TabRecord, TabInfo } from "../types/index.js";
import { DEFAULT_SETTINGS } from "../types/index.js";

// In-memory tab activity map
// Persisted to storage.session so it survives service-worker restarts.
const ACTIVITY_KEY = "tabActivity";
const SETTINGS_KEY = "settings";
const LIFETIME_STATS_KEY = "lifetimeStats";
const ALARM_NAME = "suspendCheck";
const CHECK_INTERVAL_MINUTES = 1;

// Estimates used for savings display
const MEM_PER_TAB_MB = 100; // avg memory a background tab consumes
const BW_PER_SUSPEND_MB = 2; // avg page weight prevented from reloading

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

async function loadSettings(): Promise<Settings> {
  const result = await chrome.storage.sync.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] as Partial<Settings> | undefined) };
}

function matchesDomainList(url: string, patterns: string[]): boolean {
  try {
    const hostname = new URL(url).hostname;
    return patterns.some((p) => hostname === p || hostname.endsWith(`.${p}`));
  } catch {
    return false;
  }
}

async function runSuspensionCheck(): Promise<void> {
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

    // Whitelist: never suspend
    if (url && matchesDomainList(url, settings.whitelist)) continue;

    // Blacklist: always suspend immediately (ignore timeout)
    const forceDiscard = url && matchesDomainList(url, settings.blacklist ?? []);

    const lastActive = activity.get(tab.id) ?? tab.lastAccessed ?? 0;
    if (forceDiscard || now - lastActive >= thresholdMs) {
      try {
        await chrome.tabs.discard(tab.id);
        newSuspensions++;
      } catch {
        // Tab may have been closed or is not discardable — ignore.
      }
    }
  }

  if (newSuspensions > 0) {
    await incrementLifetimeStats({ totalSuspensions: newSuspensions });
  }
}

type LifetimeStats = { totalSuspensions: number; totalPageLoads: number };

async function incrementLifetimeStats(delta: Partial<LifetimeStats>): Promise<void> {
  const r = await chrome.storage.local.get(LIFETIME_STATS_KEY);
  const prev = (r[LIFETIME_STATS_KEY] ?? {}) as LifetimeStats;
  await chrome.storage.local.set({
    [LIFETIME_STATS_KEY]: {
      totalSuspensions: (prev.totalSuspensions ?? 0) + (delta.totalSuspensions ?? 0),
      totalPageLoads: (prev.totalPageLoads ?? 0) + (delta.totalPageLoads ?? 0),
    },
  });
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
});

// Track when a tab finishes loading (reset timer + count page load)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    void recordActivity(tabId);
    // Only count real navigations (not extension pages, new-tab, etc.)
    const url = tab.url ?? "";
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void incrementLifetimeStats({ totalPageLoads: 1 });
    }
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void runSuspensionCheck();
  }
});

async function init(): Promise<void> {
  const settings = await loadSettings();
  const existingActivity = await loadActivity();
  const isFreshStart = existingActivity.size === 0;

  const activity = existingActivity;
  const tabs = await chrome.tabs.query({});
  const now = Date.now();

  for (const tab of tabs) {
    if (tab.id == null) continue;
    if (!activity.has(tab.id)) {
      // On fresh browser start with suspendOnStartup: mark all non-active tabs as expired
      const isActive = tab.active;
      if (isFreshStart && settings.suspendOnStartup && !isActive) {
        activity.set(tab.id, 0);
      } else {
        activity.set(tab.id, tab.lastAccessed ?? now);
      }
    }
  }
  await saveActivity(activity);

  // If fresh start + suspendOnStartup, run a check immediately
  if (isFreshStart && settings.suspendOnStartup && settings.enabled) {
    await runSuspensionCheck();
  }

  // Ensure the periodic alarm is running
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_INTERVAL_MINUTES });
  }
}

// Handle messages from the popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "getStats") {
    (async () => {
      const tabs = await chrome.tabs.query({});
      const suspended = tabs.filter((t) => t.discarded).length;
      const active = tabs.length - suspended;
      const r = await chrome.storage.local.get(LIFETIME_STATS_KEY);
      const ls = (r[LIFETIME_STATS_KEY] ?? {}) as LifetimeStats;
      sendResponse({
        total: tabs.length,
        active,
        suspended,
        memoryUsedMB: active * MEM_PER_TAB_MB,
        memorySavedMB: suspended * MEM_PER_TAB_MB,
        bandwidthUsedMB: (ls.totalPageLoads ?? 0) * BW_PER_SUSPEND_MB,
        bandwidthSavedMB: (ls.totalSuspensions ?? 0) * BW_PER_SUSPEND_MB,
      } satisfies StatsResponse);
    })();
    return true;
  }

  if (msg.type === "suspendNow") {
    runSuspensionCheck().then(() => sendResponse({ ok: true }));
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
  bandwidthUsedMB: number;
  bandwidthSavedMB: number;
};

// Keep service worker alive while the popup is open
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "popup") {
    port.onDisconnect.addListener(() => { /* popup closed */ });
  }
});

void init();