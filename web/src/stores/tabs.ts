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

export function setTabLabel(path: string, label: string) {
  setTabs((t) => t.map((x) => (x.path === path ? { ...x, label } : x)));
}

// Returns the path to navigate to after closing (a neighboring tab, or
// "/overview" as the default landing page if none remain). Looks up the
// neighbor directly in the pre-removal list (list[idx+1] ?? list[idx-1])
// rather than re-deriving an index into the filtered list, so there's no
// arithmetic that could point at the wrong entry after removal.
export function closeTab(path: string): string {
  const list = tabs();
  const idx = list.findIndex((t) => t.path === path);
  const neighbor = list[idx + 1] ?? list[idx - 1];
  setTabs(list.filter((t) => t.path !== path));
  return neighbor ? neighbor.path : "/overview";
}
