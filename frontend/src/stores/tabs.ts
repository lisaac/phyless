import { createSignal, type Accessor } from "solid-js";
import { createStore } from "solid-js/store";
import { useLocation } from "@solidjs/router";
import { mainLinks, adminLinks } from "../components/shared/Sidebar";

export interface PageTab { path: string; label: string; }

// In-memory only, not persisted to localStorage — this is a per-origin store
// shared by ALL same-origin browser tabs/windows via localStorage last-write-
// wins, so having the app open in more than one real browser tab (easy to do
// once there's an in-app tab strip to click "open in new tab" from) corrupted
// each other's tab lists on reload. Session-scoped (resets on full reload) is
// simpler and avoids that entirely.
export const [tabs, setTabs] = createSignal<PageTab[]>([]);

const STATIC_LABELS: Record<string, string> = Object.fromEntries(
  [...mainLinks, ...adminLinks].map((l) => [l.to, l.label]),
);

// Best-effort label for a path that isn't open yet. Detail pages (container,
// compose) refine this once they know the real name — see setTabLabel.
export function labelFor(path: string): string {
  if (STATIC_LABELS[path]) return STATIC_LABELS[path];
  const containerMatch = path.match(/^\/containers\/(.+)$/);
  if (containerMatch) return `容器 ${containerMatch[1].slice(0, 8)}`;
  const composeMatch = path.match(/^\/compose\/(.+)$/);
  if (composeMatch) return `Compose ${decodeURIComponent(composeMatch[1]).replace(/^auto:/, "")}`;
  return path;
}

// Opens a tab for `path` if one isn't already open; otherwise a no-op —
// activation itself is just "the current route equals this tab's path",
// so navigating there is all a caller needs to do. Sidebar pages never get
// a tab — the sidebar already is their switcher; only detail pages do.
export function openOrActivate(path: string, label: string) {
  if (STATIC_LABELS[path] || tabs().some((t) => t.path === path)) return;
  setTabs((t) => [...t, { path, label }]);
}

// `<For>` in Layout.tsx reconciles by object identity, not by `path` — so
// replacing a tab with a new object (even one with an identical label)
// makes it remount the tab's chip, replaying its entrance animation. Detail
// pages call this every time their data (re)loads, including when you just
// switch back to an already-resolved tab, so this must be a genuine no-op —
// same array, same objects — whenever the label hasn't actually changed.
export function setTabLabel(path: string, label: string) {
  setTabs((t) => {
    const idx = t.findIndex((x) => x.path === path);
    if (idx === -1 || t[idx].label === label) return t;
    const next = [...t];
    next[idx] = { ...next[idx], label };
    return next;
  });
}

// Drag-reorder: put `path` at index `to` (counted without it).
export function moveTab(path: string, to: number) {
  setTabs((t) => {
    const from = t.findIndex((x) => x.path === path);
    if (from === -1 || from === to) return t;
    const next = [...t];
    next.splice(to, 0, ...next.splice(from, 1));
    return next;
  });
}

// The tab immediately to the left of `path`, or undefined if it's leftmost.
// Callers must navigate() to this (or the fallback) BEFORE calling removeTab
// — swap the displayed page first, drop the old tab second. Doing it in the
// other order (remove, then navigate) left a brief window where the route
// still pointed at the tab being closed while it no longer existed in the
// list, which is what caused the tab strip to misbehave.
export function leftNeighbor(path: string): PageTab | undefined {
  const list = tabs();
  const idx = list.findIndex((t) => t.path === path);
  return list[idx - 1];
}

export function removeTab(path: string) {
  setTabs((t) => t.filter((x) => x.path !== path));
  seenPaths.delete(path);
  savedSearch.delete(path);
  setViewState(path, undefined!);
}

// ── Per-tab view state (not data) ─────────────────────────────────────────
// Switching tabs unmounts the page, so anything it held is lost. Two kinds
// of state survive a switch, both keyed by the tab's path and dropped when
// the tab closes:
//  1. The query string (?tab=…&path=…) — sub-tabs and similar already live
//     there; Layout saves it on leave and restores it on return.
//  2. createTabState — a drop-in for createSignal for view state that isn't
//     in the URL (search box text, filters, selected file…).
// Kept out of PageTab itself: replacing tab objects remounts their chips
// (see setTabLabel).
const savedSearch = new Map<string, string>();
export const tabSearch = (path: string) => savedSearch.get(path) ?? "";
export const setTabSearch = (path: string, search: string) => { savedSearch.set(path, search); };

const [viewState, setViewState] = createStore<Record<string, Record<string, unknown>>>({});

// Reads/writes under the CURRENT route's path, reactively — Solid Router
// reuses one page instance across e.g. /compose/a → /compose/b, so the key
// must follow the route, not be captured once at creation.
export function createTabState<T>(key: string, init: T): [Accessor<T>, (v: T | ((prev: T) => T)) => void] {
  let location: ReturnType<typeof useLocation> | undefined;
  try { location = useLocation(); } catch { /* outside a Route (popup window, tests) */ }
  if (!location) {
    const [get, set] = createSignal(init);
    return [get, (v) => set(() => (typeof v === "function" ? (v as (prev: T) => T)(get()) : v))];
  }
  const loc = location;
  const get = () => {
    const bag = viewState[loc.pathname];
    return (bag && key in bag ? bag[key] : init) as T;
  };
  const set = (v: T | ((prev: T) => T)) => {
    const value = typeof v === "function" ? (v as (prev: T) => T)(get()) : v;
    setViewState(loc.pathname, (bag) => ({ ...bag, [key]: value }));
  };
  return [get, set];
}

// Tracks which paths have had their chip shown until that tab closes, so
// remounts do not replay an entrance animation while a tab is open.
const seenPaths = new Set<string>();
export function markSeen(path: string): boolean {
  const already = seenPaths.has(path);
  seenPaths.add(path);
  return already;
}
