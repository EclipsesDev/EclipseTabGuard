import type { Settings, TabInfo } from "../types/index.js";
import { DEFAULT_SETTINGS } from "../types/index.js";
import type { StatsResponse } from "../background/index.js";

const SETTINGS_KEY = "settings";

// Refs
const statTotal = document.getElementById("stat-total")!;
const statActive = document.getElementById("stat-active")!;
const statSuspended = document.getElementById("stat-suspended")!;
const toggleEnabled = document.getElementById("toggle-enabled")  as HTMLInputElement;
const togglePinned = document.getElementById("toggle-pinned")   as HTMLInputElement;
const toggleAudible = document.getElementById("toggle-audible")  as HTMLInputElement;
const toggleLoading = document.getElementById("toggle-loading")  as HTMLInputElement;const toggleStartup  = document.getElementById("toggle-startup")  as HTMLInputElement;const timeoutInput = document.getElementById("timeout-input")   as HTMLInputElement;
const whitelistInput = document.getElementById("whitelist-input") as HTMLInputElement;
const blacklistInput = document.getElementById("blacklist-input") as HTMLInputElement;
const whitelistListEl = document.getElementById("whitelist-list")!;
const blacklistListEl = document.getElementById("blacklist-list")!;
const whitelistEmpty = document.getElementById("whitelist-empty")!;
const blacklistEmpty = document.getElementById("blacklist-empty")!;
const btnSave = document.getElementById("btn-save")!;
const btnSuspendNow = document.getElementById("btn-suspend-now")!;
const toast = document.getElementById("toast")!;

let whitelist: string[] = [];
let blacklist: string[] = [];

// Animated counter (slot-roll effect)
function animateCounter(el: HTMLElement, target: number, duration = 650): void {
  const from = parseInt(el.textContent ?? "0") || 0;
  if (from === target) return;
  const start = performance.now();
  function step(now: number): void {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    el.textContent = String(Math.round(from + (target - from) * eased));
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = String(target);
  }
  requestAnimationFrame(step);
}

// Stats
function refreshStats(): void {
  chrome.runtime.sendMessage({ type: "getStats" }, (resp: StatsResponse | undefined) => {
    if (chrome.runtime.lastError || !resp) return;
    animateCounter(statTotal, resp.total);
    animateCounter(statActive, resp.active);
    animateCounter(statSuspended, resp.suspended);
  });
}

// Tab switching
document.querySelectorAll<HTMLButtonElement>(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`panel-${btn.dataset["tab"]!}`)?.classList.add("active");
  });
});

// Ripple effect
function attachRipple(el: HTMLElement): void {
  el.addEventListener("click", (e: MouseEvent) => {
    const rect = el.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const span = document.createElement("span");
    span.className = "ripple";
    span.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - rect.left - size / 2}px;top:${e.clientY - rect.top - size / 2}px`;
    el.appendChild(span);
    span.addEventListener("animationend", () => span.remove());
  });
}
[btnSave, btnSuspendNow].forEach(attachRipple);

// Domain list rendering
function renderDomainList(
  items: string[],
  listEl: HTMLElement,
  emptyEl: HTMLElement,
  itemClass: string,
  onRemove: (d: string) => void,
): void {
  listEl.innerHTML = "";
  emptyEl.style.display = items.length ? "none" : "block";
  for (const domain of items) {
    const li = document.createElement("li");
    li.className = itemClass;
    li.textContent = domain;
    const btn = document.createElement("button");
    btn.textContent = "x";
    btn.title = "Remove";
    btn.addEventListener("click", () => onRemove(domain));
    li.appendChild(btn);
    listEl.appendChild(li);
  }
}

function renderWhitelist(): void {
  renderDomainList(whitelist, whitelistListEl, whitelistEmpty, "whitelist-item", (d) => {
    whitelist = whitelist.filter((x) => x !== d);
    renderWhitelist();
  });
}

function renderBlacklist(): void {
  renderDomainList(blacklist, blacklistListEl, blacklistEmpty, "blacklist-item", (d) => {
    blacklist = blacklist.filter((x) => x !== d);
    renderBlacklist();
  });
}

function addDomainEntry(input: HTMLInputElement, list: string[], render: () => void): void {
  const value = input.value.trim().toLowerCase().replace(/^https?:\/\//, "");
  if (!value || list.includes(value)) { input.value = ""; return; }
  list.push(value);
  render();
  input.value = "";
}

document.getElementById("add-whitelist")!.addEventListener("click", () =>
  addDomainEntry(whitelistInput, whitelist, renderWhitelist));
whitelistInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addDomainEntry(whitelistInput, whitelist, renderWhitelist);
});

document.getElementById("add-blacklist")!.addEventListener("click", () =>
  addDomainEntry(blacklistInput, blacklist, renderBlacklist));
blacklistInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addDomainEntry(blacklistInput, blacklist, renderBlacklist);
});

// Load settings
chrome.storage.sync.get(SETTINGS_KEY, (result) => {
  const s: Settings = { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] as Partial<Settings> | undefined) };
  toggleEnabled.checked = s.enabled;
  togglePinned.checked = s.skipPinned;
  toggleAudible.checked = s.skipAudible;
  toggleLoading.checked = s.skipLoading;
  toggleStartup.checked = s.suspendOnStartup ?? false;
  timeoutInput.value = String(s.timeoutMinutes);
  whitelist = [...s.whitelist];
  blacklist = [...s.blacklist];
  renderWhitelist();
  renderBlacklist();
});

// Save
btnSave.addEventListener("click", () => {
  const timeout = Math.max(1, Math.min(1440, Number(timeoutInput.value) || 30));
  const s: Settings = {
    enabled: toggleEnabled.checked,
    skipPinned: togglePinned.checked,
    skipAudible: toggleAudible.checked,
    skipLoading: toggleLoading.checked,
    suspendOnStartup: toggleStartup.checked,
    skipActive: true,
    timeoutMinutes: timeout,
    whitelist,
    blacklist,
  };
  chrome.storage.sync.set({ [SETTINGS_KEY]: s }, () => {
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2000);
  });
});

// Suspend Now
btnSuspendNow.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "suspendNow" }, () => {
    if (chrome.runtime.lastError) return;
    refreshStats();
  });
});

// Tab list
function renderTabList(tabs: TabInfo[]): void {
  const listEl = document.getElementById("tab-list")!;
  const emptyEl = document.getElementById("tab-list-empty")!;
  listEl.innerHTML = "";
  emptyEl.style.display = tabs.length ? "none" : "block";

  for (const tab of tabs) {
    const li = document.createElement("li");
    li.className = "tab-item";

    // Favicon
    if (tab.favIconUrl) {
      const img = document.createElement("img");
      img.className = "tab-favicon";
      img.src = tab.favIconUrl;
      img.onerror = () => img.replaceWith(placeholder());
      li.appendChild(img);
    } else {
      li.appendChild(placeholder());
    }

    // Info
    const info = document.createElement("div");
    info.className = "tab-info";
    const titleEl = document.createElement("div");
    titleEl.className = "tab-title";
    titleEl.textContent = tab.title || tab.url || "(no title)";
    const domainEl = document.createElement("div");
    domainEl.className = "tab-domain";
    try { domainEl.textContent = new URL(tab.url).hostname; } catch { domainEl.textContent = ""; }
    info.appendChild(titleEl);
    info.appendChild(domainEl);
    li.appendChild(info);

    // Badge
    const badge = document.createElement("span");
    badge.className = "tab-badge " + (tab.pinned ? "badge-pinned" : tab.discarded ? "badge-suspended" : "badge-active");
    badge.textContent = tab.pinned ? "Pinned" : tab.discarded ? "Suspended" : "Active";
    li.appendChild(badge);

    li.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "focusTab", tabId: tab.id, windowId: tab.windowId }, () => {
        void chrome.runtime.lastError;
      });
    });

    listEl.appendChild(li);
  }
}

function placeholder(): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "tab-favicon-placeholder";
  return d;
}

function refreshTabList(): void {
  chrome.runtime.sendMessage({ type: "getTabs" }, (tabs: TabInfo[] | undefined) => {
    if (chrome.runtime.lastError || !tabs) return;
    renderTabList(tabs);
  });
}

// Refresh tab list when Tabs panel is opened
document.querySelectorAll<HTMLButtonElement>(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset["tab"] === "tabs") refreshTabList();
  });
});

// Connect to wake + keep service worker alive for the popup's lifetime
const _port = chrome.runtime.connect({ name: "popup" });

// Init
refreshStats();