import { Component, JSX, createSignal, createEffect, For, Show } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { Sidebar } from "./Sidebar";
import { theme, toggleTheme } from "../../stores/theme";
import { tabs, openOrActivate, closeTab, labelFor } from "../../stores/tabs";

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

  const closeAndNavigate = (e: MouseEvent, path: string) => {
    e.stopPropagation();
    const dest = closeTab(path);
    if (location.pathname !== path) return;
    // navigate() is a no-op when dest === the current path (e.g. closing your
    // only tab, which happens to be the "/containers" fallback itself) — no
    // route change means the tab-sync effect above never re-fires, so the
    // fallback tab would never get recreated. Recreate it explicitly instead
    // of relying on a navigation event that may not actually occur.
    if (dest === location.pathname) openOrActivate(dest, labelFor(dest));
    else navigate(dest);
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
        {/* Top bar — always visible; hamburger+title are mobile-only, the tab
            strip (top-right) and theme toggle are shown at every width. */}
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
          <div class="ml-auto flex min-w-0 items-center gap-1 overflow-x-auto">
            <For each={tabs()}>
              {(t) => (
                <div
                  class={`group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ${
                    location.pathname === t.path
                      ? "border-indigo-500/30 bg-indigo-500/15 text-indigo-300"
                      : "border-transparent text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
                  }`}
                  onClick={() => navigate(t.path)}
                >
                  <span class="max-w-[9rem] truncate text-left">{t.label}</span>
                  <button
                    class="shrink-0 text-zinc-500 transition-colors hover:text-zinc-200"
                    onClick={(e) => closeAndNavigate(e, t.path)}
                    aria-label={`关闭标签 ${t.label}`}
                  >✕</button>
                </div>
              )}
            </For>
          </div>

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
    </div>
  );
};
