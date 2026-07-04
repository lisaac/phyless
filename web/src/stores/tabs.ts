import { createSignal } from "solid-js";
import { mainLinks, adminLinks } from "../components/shared/Sidebar";

export interface PageTab { path: string; label: string; }

const STORAGE_KEY = "phyless_tabs";
const stored = (() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PageTab[]) : [];
  } catch {
    return [];
  }
})();

export const [tabs, setTabs] = createSignal<PageTab[]>(stored);

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs()));
}

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
  persist();
}

export function setTabLabel(path: string, label: string) {
  setTabs((t) => t.map((x) => (x.path === path ? { ...x, label } : x)));
  persist();
}

// Returns the path to navigate to after closing (a neighboring tab, or
// "/containers" as the default landing page if none remain).
export function closeTab(path: string): string {
  const list = tabs();
  const idx = list.findIndex((t) => t.path === path);
  const next = list.filter((t) => t.path !== path);
  setTabs(next);
  persist();
  if (next.length === 0) return "/containers";
  return next[Math.min(idx, next.length - 1)].path;
}
