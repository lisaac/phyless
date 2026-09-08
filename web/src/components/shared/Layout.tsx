import { Component, JSX, createSignal, createEffect, onMount, onCleanup, startTransition, For, Show } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { Sidebar } from "./Sidebar";
import { theme, toggleTheme } from "../../stores/theme";
import { tabs, openOrActivate, leftNeighbor, removeTab, labelFor, markSeen, type PageTab } from "../../stores/tabs";
import { ComposeIcon } from "../compose/composeShared";
import { ContainerIcon } from "../containers/ContainerIcon";
import { TaskQueueWidget } from "./TaskQueueWidget";
import { tasks, panelHidden, setPanelHidden, isActive } from "../../stores/taskQueue";
import { autoRefresh, refreshSeconds, setAutoRefresh, setRefreshSeconds, refreshAll } from "../../stores/refresh";

const CLOSE_ANIM_MS = 200;

// Owns its own enter/exit animation so a tab visibly grows in the first time
// it's ever opened and shrinks out on close — switching between tabs that
// are already open must never animate. markSeen() makes that hold even if
// something remounts this component for an already-seen path (e.g. a <For>
// reconciliation quirk): a previously-seen path starts already "entered",
// skipping the grow-in outright instead of just racing to finish it fast.
const TabChip: Component<{ tab: PageTab; active: boolean; onActivate: () => void; onClose: () => void }> = (p) => {
  const alreadySeen = markSeen(p.tab.path);
  const [entered, setEntered] = createSignal(alreadySeen);
  const [closing, setClosing] = createSignal(false);
  onMount(() => {
    if (alreadySeen) return;
    // A single requestAnimationFrame can land in the same paint as the
    // initial (closed) render, so the browser never registers a "before"
    // state to transition from and the tab just snaps open instead of
    // growing in. Two nested rAFs guarantee one full frame has actually
    // painted the closed state first.
    requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
  });

  const startClose = (e: MouseEvent) => {
    e.stopPropagation();
    setClosing(true);
    setTimeout(p.onClose, CLOSE_ANIM_MS);
  };

  return (
    <div
      class={`group flex shrink-0 cursor-pointer items-center overflow-hidden whitespace-nowrap rounded-md border text-xs text-zinc-200 ease-out ${
        p.active ? "border-indigo-500/30 bg-indigo-500/15" : "border-transparent hover:bg-zinc-800/60"
      } ${
        entered() && !closing()
          ? "max-w-[12rem] gap-1.5 px-2.5 py-1 opacity-100 scale-100"
          : "max-w-0 gap-0 px-0 py-1 opacity-0 scale-90"
      }`}
      style={{
        "transition-duration": `${CLOSE_ANIM_MS}ms`,
        // Only animate the open/close (shape) properties — not border/background
        // color, so switching the active tab snaps instantly instead of fading.
        "transition-property": "max-width, opacity, transform, padding, gap",
      }}
      onClick={p.onActivate}
    >
      <Show when={p.tab.path.startsWith("/compose/")}>
        <ComposeIcon size={12} class="shrink-0 opacity-70" />
      </Show>
      <Show when={p.tab.path.startsWith("/containers/")}>
        <ContainerIcon size={12} class="shrink-0 opacity-70" />
      </Show>
      <span class="max-w-[9rem] truncate text-left">{p.tab.label}</span>
      <button
        class="shrink-0 text-zinc-500 transition-colors hover:text-zinc-200"
        onClick={startClose}
        aria-label={`关闭标签 ${p.tab.label}`}
      >✕</button>
    </div>
  );
};

export const Layout: Component<{ children?: JSX.Element }> = (props) => {
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const location = useLocation();
  const navigate = useNavigate();

  createEffect(() => {
    if (!drawerOpen()) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawerOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  // Every navigation (sidebar click, clicking into a row, back/forward) flows
  // through here — the single integration point that keeps the tab strip in
  // sync with the actual route, without touching individual navigate() calls.
  createEffect(() => {
    openOrActivate(location.pathname, labelFor(location.pathname));
  });

  const closeAndNavigate = (path: string) => {
    if (location.pathname !== path) {
      // Closing a background tab — nothing on screen needs to change.
      removeTab(path);
      return;
    }
    // Closing the tab you're currently looking at: swap the displayed page
    // to its left neighbor FIRST, then drop the old tab — not the other way
    // around.
    const dest = leftNeighbor(path)?.path ?? "/overview";
    if (dest === path) {
      // Closing your only remaining tab, which is already the "/overview"
      // fallback itself — there's nowhere left to switch to. navigate() to
      // the same path is a no-op in solid-router (location.pathname never
      // actually changes), so nothing would ever re-fire the tab-sync effect
      // to recreate it — removeTab would leave a genuinely empty strip with
      // no way back. Leave this last tab in place instead of closing it.
      return;
    }
    openOrActivate(dest, labelFor(dest)); // no-op if dest's tab (the left neighbor) already exists
    // replace, not push: switching/closing tabs is tab management, not
    // "forward" navigation. Pushing here left a history entry for the tab
    // that's closing — hitting the browser Back button would then land back
    // on that now-closed page's path and silently recreate its tab.
    //
    // navigate() runs inside solid-router's own startTransition internally —
    // location.pathname does NOT update synchronously when navigate() returns,
    // it updates once that transition commits. Calling removeTab(path) right
    // after navigate() ran it while location.pathname was STILL `path`: the
    // header effect above (which reacts to location.pathname) would see
    // "displaying `path`, but no tab for it" mid-transition and recreate one
    // — which is exactly the "tab reappears after closing" bug. Wrapping our
    // own navigate() in startTransition and awaiting it guarantees
    // location.pathname has actually become `dest` before we remove `path`'s tab.
    void startTransition(() => navigate(dest, { replace: true })).then(() => removeTab(path));
  };

  const activeCount = () => tasks.list.filter((t) => isActive(t.status)).length;
  const running = () => tasks.list.some((t) => t.status === "running");

  return (
    <div class="flex h-full overflow-hidden">
      {/* ── Desktop sidebar (lg+) ─────────────────────────────────────── */}
      <div class="hidden lg:flex lg:flex-shrink-0">
        <Sidebar />
      </div>

      {/* ── Mobile drawer overlay ─────────────────────────────────────── */}
      <Show when={drawerOpen()}>
        <div
          class="fixed inset-0 z-50 lg:hidden"
          onClick={() => setDrawerOpen(false)}
        >
          <div class="absolute inset-0 bg-black/60" />
          <div
            class="absolute left-0 top-0 h-full w-56"
            onClick={(e) => e.stopPropagation()}
          >
            <Sidebar onClose={() => setDrawerOpen(false)} />
          </div>
        </div>
      </Show>

      {/* ── Main area ─────────────────────────────────────────────────── */}
      <div class="flex min-w-0 flex-1 flex-col">
        {/* Top bar — always visible; hamburger+title are mobile-only. Tab strip
            sits left (after the mobile hamburger/title), theme toggle is
            pushed to the far right via ml-auto. */}
        <header class="flex items-center gap-3 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
          <button
            class="text-zinc-400 hover:text-zinc-100 lg:hidden"
            onClick={() => setDrawerOpen(true)}
            aria-label="打开菜单"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" width="20" height="20">
              <path d="M3 12h18M3 6h18M3 18h18" />
            </svg>
          </button>
          <span class="font-bold text-zinc-100 lg:hidden">phyless</span>

          {/* Tab strip */}
          <div class="flex min-w-0 items-center gap-1 overflow-x-auto">
            <For each={tabs()}>
              {(t) => (
                <TabChip
                  tab={t}
                  active={location.pathname === t.path}
                  onActivate={() => navigate(t.path, { replace: true })}
                  onClose={() => closeAndNavigate(t.path)}
                />
              )}
            </For>
          </div>

          {/* Right group: task panel toggle, refresh now + settings, theme. */}
          <button
            class={`ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-sm hover:bg-zinc-800 ${panelHidden() ? "text-zinc-400 hover:text-zinc-100" : "bg-zinc-800 text-zinc-100"}`}
            onClick={() => setPanelHidden(!panelHidden())}
            title={panelHidden() ? "显示任务面板" : "隐藏任务面板"}
          >
            <span class="relative flex">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" class={running() ? "text-indigo-400" : ""}>
                <path d="M9 11l3 3 8-8" /><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
              </svg>
              <Show when={running()}>
                <span class="absolute -right-1 -top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500" />
              </Show>
            </span>
            <Show when={activeCount() > 0}>
              <span class="rounded-full bg-indigo-500/20 px-1.5 text-xs text-indigo-300">{activeCount()}</span>
            </Show>
          </button>
          {/* Refresh now — plain icon button, no dropdown arrow beside it. */}
          <button
            class={`shrink-0 rounded p-1 hover:bg-zinc-800 hover:text-zinc-100 ${autoRefresh() ? "text-indigo-400" : "text-zinc-400"}`}
            onClick={refreshAll}
            title="立即刷新"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
            </svg>
          </button>
          {/* Refresh settings — gear, replaces the old ▾ arrow. */}
          <details class="group relative shrink-0">
            <summary class="flex cursor-pointer list-none items-center rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 group-open:bg-zinc-800 group-open:text-zinc-100" title="刷新设置">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15">
                <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </summary>
            <div class="absolute right-0 z-50 mt-2 flex w-48 flex-col gap-2 rounded-lg border border-zinc-700/50 bg-zinc-900 p-3 text-sm text-zinc-200 shadow-2xl">
              <label class="flex items-center gap-2">
                <input type="checkbox" checked={autoRefresh()} onChange={(e) => setAutoRefresh(e.currentTarget.checked)} />
                自动刷新
              </label>
              <label class="flex items-center justify-between gap-2">
                刷新间隔（秒）
                <input
                  type="number" min="1" step="1" value={refreshSeconds()}
                  class="w-16 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-right"
                  onChange={(e) => setRefreshSeconds(Number(e.currentTarget.value))}
                />
              </label>
            </div>
          </details>
          <button
            class="shrink-0 text-zinc-400 hover:text-zinc-100"
            onClick={toggleTheme}
            title={theme() === "dark" ? "切换日间模式" : "切换夜间模式"}
          >
            {theme() === "dark" ? "☀" : "☽"}
          </button>
        </header>

        <main class="flex-1 overflow-auto p-4 lg:p-6">
          {props.children}
        </main>
      </div>
      {/* Global task queue panel — mounted once here (inside the Router, so
          it can navigate) and never remounted by route changes. */}
      <TaskQueueWidget />
    </div>
  );
};
