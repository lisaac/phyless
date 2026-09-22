import { createSignal } from "solid-js";

// Global list auto-refresh setting, honoured by every createResourceStore
// (stores/resource.ts). Persisted in localStorage; one window event covers
// both "settings changed" (restart timers) and "refresh now".
export const REFRESH_EVENT = "phyless:refresh";
const STORAGE_KEY = "phyless_refresh";

function clampSeconds(n: unknown): number {
  const value = Number(n);
  // setInterval uses signed 32-bit milliseconds; overflow otherwise becomes a tight loop.
  return Number.isFinite(value) ? Math.min(2_147_483, Math.max(1, Math.floor(value) || 5)) : 5;
}

function load(): { on: boolean; seconds: number } {
  try {
    const j = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return { on: j.on !== false, seconds: clampSeconds(j.seconds) };
  } catch { return { on: true, seconds: 5 }; }
}

const initial = load();
export const [autoRefresh, setAutoRefreshSignal] = createSignal(initial.on);
export const [refreshSeconds, setRefreshSecondsSignal] = createSignal(initial.seconds);

export const refreshAll = () => window.dispatchEvent(new Event(REFRESH_EVENT));

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ on: autoRefresh(), seconds: refreshSeconds() })); } catch { /* private mode */ }
  refreshAll();
}

export function setAutoRefresh(on: boolean) { setAutoRefreshSignal(on); persist(); }
export function setRefreshSeconds(n: number) { setRefreshSecondsSignal(clampSeconds(n)); persist(); }
