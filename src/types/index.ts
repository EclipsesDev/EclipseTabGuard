export type Settings = {
  enabled: boolean;
  /** Minutes a tab must be inactive before being suspended. Default: 30 */
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
  cacheWarm: boolean;  /** How often (in minutes) cache warming runs. Default: 10 */
  cacheWarmIntervalMinutes: number;  /** Domain patterns to never suspend */
  whitelist: string[];
  /** Domain patterns to always suspend immediately (ignores timeout) */
  blacklist: string[];
  /** Automatically close duplicate tabs, keeping the leftmost one */
  closeDuplicates: boolean;
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
  closeDuplicates: false,
  whitelist: [],
  blacklist: [],
};