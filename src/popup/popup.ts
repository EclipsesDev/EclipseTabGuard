import type { Settings } from "../types/index.js";
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
const toggleLoading = document.getElementById("toggle-loading")  as HTMLInputElement;
const timeoutInput = document.getElementById("timeout-input")   as HTMLInputElement;
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
    if (!resp) return;
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
  togglePinned.checked   = s.skipPinned;
  toggleAudible.checked  = s.skipAudible;
  toggleLoading.checked  = s.skipLoading;
  timeoutInput.value     = String(s.timeoutMinutes);
  whitelist = [...s.whitelist];
  blacklist = [...s.blacklist];
  renderWhitelist();
  renderBlacklist();
});

// Save
btnSave.addEventListener("click", () => {
  const timeout = Math.max(1, Math.min(1440, Number(timeoutInput.value) || 30));
  const s: Settings = {
    enabled:        toggleEnabled.checked,
    skipPinned:     togglePinned.checked,
    skipAudible:    toggleAudible.checked,
    skipLoading:    toggleLoading.checked,
    skipActive:     true,
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
  chrome.runtime.sendMessage({ type: "suspendNow" }, () => refreshStats());
});

// Init
refreshStats();