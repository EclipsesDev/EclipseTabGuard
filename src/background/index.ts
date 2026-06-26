export {};

import type { Settings, TabRecord, TabInfo } from "../types/index.js";
import { DEFAULT_SETTINGS } from "../types/index.js";

// Keeps track of when each tab was last used.
// Stored in session storage so it survives service worker restarts.
const ACTIVITY_KEY = "tabActivity";
const SETTINGS_KEY = "settings";
const LIFETIME_STATS_KEY = "lifetimeStats";
const ALARM_NAME = "suspendCheck";
const CHECK_INTERVAL_MINUTES = 1;

// Used when we can't get real memory data (e.g. Firefox without COOP/COEP pages)
const MEM_PER_TAB_MB_FALLBACK = 100;
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
  // The modern way — gives accurate per-page memory, but only works if the
  // page has COOP + COEP headers set (most sites don't bother)
  if (typeof (performance as Performance & { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> }).measureUserAgentSpecificMemory === "function") {
    try {
      const r = await (performance as Performance & { measureUserAgentSpecificMemory: () => Promise<{ bytes: number }> }).measureUserAgentSpecificMemory();
      return r.bytes;
    } catch {
      // Page isn't cross-origin isolated, so this API throws — move on
    }
  }
  // Older Chrome-only shortcut — shared across all tabs in the same process,
  // so it can overcount when multiple tabs run in one renderer
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  if (mem) return mem.usedJSHeapSize;
  return null;
}

// Figures out how much RAM the given tabs are currently using.
// Tries the most accurate method first and falls back if something isn't available.
async function getTabsMemoryMB(tabs: chrome.tabs.Tab[]): Promise<number> {
  const tabIds = tabs.map((t) => t.id).filter((id): id is number => id != null);
  if (tabIds.length === 0) return 0;

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
        return totalBytes / (1024 * 1024);
      }
    } catch {
      // Something went wrong with the processes API — try the next method
    }
  }

  // Second option: inject a small script into each tab and ask it directly.
  // Works on both Chrome and Firefox for normal web pages.
  if (typeof chrome.scripting?.executeScript === "function") {
    try {
      let totalBytes = 0;
      let measuredCount = 0;

      await Promise.all(
        tabs.map(async (tab) => {
          if (tab.id == null) return;
          const url = tab.url ?? "";
          // We can't inject into browser-internal pages, so skip those
          if (url.startsWith("about:") || url.startsWith("chrome:") || url.startsWith("moz-extension:") || url.startsWith("chrome-extension:") || url === "") return;
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: measureTabMemory,
            });
            const bytes = results?.[0]?.result;
            if (typeof bytes === "number") {
              totalBytes += bytes;
              measuredCount++;
            }
          } catch {
            // Some tabs can't be injected into (PDFs, file:// pages, etc.) — just skip them
          }
        })
      );

      if (measuredCount > 0) {
        const avgBytes = totalBytes / measuredCount;
        // For tabs we couldn't measure, use the average of the ones we could
        const estimatedBytes = avgBytes * (tabIds.length - measuredCount);
        return (totalBytes + estimatedBytes) / (1024 * 1024);
      }
    } catch {
      // Scripting API not available — fall through to the rough estimate
    }
  }

  // Last resort: just multiply by a fixed number per tab
  return tabIds.length * MEM_PER_TAB_MB_FALLBACK;
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

    // This tab is on the whitelist — never touch it
    if (url && matchesDomainList(url, settings.whitelist)) continue;

    // This tab is blacklisted — suspend it right away regardless of how recently it was used
    const forceDiscard = url && matchesDomainList(url, settings.blacklist ?? []);

    const lastActive = activity.get(tab.id) ?? tab.lastAccessed ?? 0;
    if (forceDiscard || now - lastActive >= thresholdMs) {
      try {
        await chrome.tabs.discard(tab.id);
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
        const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
        return entries.reduce((sum, e) => sum + (e.transferSize ?? 0), 0);
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

// Whenever a tab finishes loading, reset its idle timer and record the bandwidth it used.
// We only care about real web pages — not new tabs, about: pages, or extension UIs.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    void recordActivity(tabId);
    const url = tab.url ?? "";
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void incrementLifetimeStats({ totalPageLoads: 1 });
      void measureAndRecordBandwidth(tabId);
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

  // Make sure our periodic check alarm is running — create it if it somehow got cleared
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_INTERVAL_MINUTES });
  }
}

// The popup talks to us through message passing — handle whatever it needs
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "getStats") {
    (async () => {
      const tabs = await chrome.tabs.query({});
      const suspendedTabs = tabs.filter((t) => t.discarded);
      const activeTabs = tabs.filter((t) => !t.discarded);
      const suspended = suspendedTabs.length;
      const active = activeTabs.length;
      const r = await chrome.storage.local.get(LIFETIME_STATS_KEY);
      const ls = (r[LIFETIME_STATS_KEY] ?? {}) as LifetimeStats;

      const memoryUsedMB = await getTabsMemoryMB(activeTabs);
      // For saved memory, we use the average cost of an active tab as the estimate per suspended one
      const avgMemPerTab = active > 0 ? memoryUsedMB / active : MEM_PER_TAB_MB_FALLBACK;
      const memorySavedMB = suspended * avgMemPerTab;

      sendResponse({
        total: tabs.length,
        active,
        suspended,
        memoryUsedMB,
        memorySavedMB,
        bandwidthUsedMB: (ls.totalBandwidthBytes ?? 0) / (1024 * 1024),
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

// Holding an open port to the popup prevents the service worker from going idle
// while the user has it open
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "popup") {
    port.onDisconnect.addListener(() => { /* popup closed, port released */ });
  }
});

void init();