import { createSignal } from "solid-js";
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
// so navigating there is all a caller needs to do.
export function openOrActivate(path: string, label: string) {
  if (tabs().some((t) => t.path === path)) return;
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
}
