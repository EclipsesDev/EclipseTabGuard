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
  /** Domain patterns to never suspend */
  whitelist: string[];
  /** Domain patterns to always suspend immediately (ignores timeout) */
  blacklist: string[];
};

export type TabRecord = {
  tabId: number;
  lastActiveAt: number; // epoch ms
};

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  timeoutMinutes: 30,
  skipPinned: true,
  skipAudible: true,
  skipActive: true,
  skipLoading: true,
  whitelist: [],
  blacklist: [],
};