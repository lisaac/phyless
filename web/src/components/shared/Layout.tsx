import { Component, JSX, createSignal, createEffect, onMount, For, Show } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { Sidebar } from "./Sidebar";
import { theme, toggleTheme } from "../../stores/theme";
import { tabs, openOrActivate, leftNeighbor, removeTab, labelFor, type PageTab } from "../../stores/tabs";

const CLOSE_ANIM_MS = 150;

// Owns its own enter/exit animation so a tab visibly grows in on open and
// shrinks out on close, instead of the strip instantly reflowing — a fast
// second click right after closing one tab used to land on whatever tab had
// just snapped into that same spot. `onClose` (the real navigate+removeTab
// logic) only fires after the shrink animation finishes.
const TabChip: Component<{ tab: PageTab; active: boolean; onActivate: () => void; onClose: () => void }> = (p) => {
  const [entered, setEntered] = createSignal(false);
  const [closing, setClosing] = createSignal(false);
  onMount(() => requestAnimationFrame(() => setEntered(true)));

  const startClose = (e: MouseEvent) => {
    e.stopPropagation();
    setClosing(true);
    setTimeout(p.onClose, CLOSE_ANIM_MS);
  };

  return (
    <div
      class={`group flex shrink-0 cursor-pointer items-center overflow-hidden whitespace-nowrap rounded-md border text-xs text-zinc-200 transition-all ease-out ${
        p.active ? "border-indigo-500/30 bg-indigo-500/15" : "border-transparent hover:bg-zinc-800/60"
      } ${
        entered() && !closing()
          ? "max-w-[12rem] gap-1.5 px-2.5 py-1 opacity-100 scale-100"
          : "max-w-0 gap-0 px-0 py-1 opacity-0 scale-90"
      }`}
      style={{ "transition-duration": `${CLOSE_ANIM_MS}ms` }}
      onClick={p.onActivate}
    >
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
    // around. Removing the tab before navigating left a window where the
    // route still pointed at a path with no matching tab entry, which is
    // what caused the strip to misbehave.
    const dest = leftNeighbor(path)?.path ?? "/overview";
    openOrActivate(dest, labelFor(dest)); // no-op if dest's tab (the left neighbor) already exists
    // replace, not push: switching/closing tabs is tab management, not
    // "forward" navigation. Pushing here left a history entry for the tab
    // that's closing — hitting the browser Back button would then land back
    // on that now-closed page's path and silently recreate its tab.
    navigate(dest, { replace: true });
    removeTab(path);
  };

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

          <button
            class="ml-auto shrink-0 text-zinc-400 hover:text-zinc-100"
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
    </div>
  );
};
