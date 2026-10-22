import { Component, JSX, createSignal, createEffect, onMount, onCleanup, startTransition, For, Show } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { Sidebar } from "./Sidebar";
import { tabs, openOrActivate, leftNeighbor, removeTab, moveTab, labelFor, markSeen, tabSearch, setTabSearch, type PageTab } from "../../stores/tabs";
import { ComposeIcon } from "../compose/composeShared";
import { ContainerIcon } from "../containers/ContainerIcon";
import { TaskQueueWidget } from "./TaskQueueWidget";
import { ImageInspectModal } from "./Inspect";
import { panelHidden, setPanelHidden, ENQUEUED_EVENT, runningCount, showTaskPanel, unseenFailureCount } from "../../stores/taskQueue";
import { autoRefresh, refreshSeconds, setAutoRefresh, setRefreshSeconds, refreshAll } from "../../stores/refresh";

const CLOSE_ANIM_MS = 200;
// Pinned first chip: sidebar pages get no tab, except 总览 as the home tab.
const OVERVIEW_TAB: PageTab = { path: "/overview", label: "总览" };
const TASK_FLIGHT_ORIGIN_MAX_AGE_MS = 1_000;
const REFRESH_PRESETS = [3, 5, 10, 30, 60];

interface TaskFlight {
  id: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

// Owns its own enter/exit animation so a tab visibly grows in the first time
// it's ever opened and shrinks out on close — switching between tabs that
// are already open must never animate. markSeen() makes that hold even if
// something remounts this component for an already-seen path (e.g. a <For>
// reconciliation quirk): a previously-seen path starts already "entered",
// skipping the grow-in outright instead of just racing to finish it fast.
// No onClose = pinned (总览): never closes. onDragStart = draggable.
const TabChip: Component<{ tab: PageTab; active: boolean; dragX?: number | null; onActivate: () => void; onClose?: () => void; onDragStart?: (e: PointerEvent) => void }> = (p) => {
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
    setTimeout(p.onClose!, CLOSE_ANIM_MS);
  };

  return (
    <div
      data-tab-path={p.onDragStart ? p.tab.path : undefined}
      class={`group flex shrink-0 cursor-pointer select-none items-center overflow-hidden whitespace-nowrap rounded-md border text-xs text-zinc-200 ease-out [-webkit-touch-callout:none] ${p.dragX != null ? "relative z-10 cursor-grabbing shadow-lg shadow-black/40" : ""} ${
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
        // While dragged, transform tracks the pointer 1:1 (no transition); on
        // drop it's cleared and transitions back into its slot.
        "transition-property": p.dragX != null ? "max-width, opacity, padding, gap" : "max-width, opacity, transform, padding, gap",
        transform: p.dragX != null ? `translateX(${p.dragX}px) scale(1.06)` : undefined,
      }}
      onClick={p.onActivate}
      onPointerDown={(e) => p.onDragStart?.(e)}
      onContextMenu={(e) => p.onDragStart && e.pointerType !== "mouse" && e.preventDefault()}
    >
      <Show when={p.tab.path.startsWith("/compose/")}>
        <ComposeIcon size={12} class="shrink-0 opacity-70" />
      </Show>
      <Show when={p.tab.path.startsWith("/containers/")}>
        <ContainerIcon size={12} class="shrink-0 opacity-70" />
      </Show>
      <span class="max-w-[9rem] truncate text-left">{p.tab.label}</span>
      <Show when={p.onClose}>
        <button
          class="shrink-0 text-zinc-500 transition-colors hover:text-zinc-200"
          onClick={startClose}
          aria-label={`关闭标签 ${p.tab.label}`}
        >✕</button>
      </Show>
    </div>
  );
};

export const Layout: Component<{ children?: JSX.Element }> = (props) => {
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const [taskFlights, setTaskFlights] = createSignal<TaskFlight[]>([]);
  const location = useLocation();
  const navigate = useNavigate();
  let refreshMenu!: HTMLDetailsElement;
  let taskButton!: HTMLButtonElement;

  onMount(() => {
    const closeRefreshMenu = (e: PointerEvent) => {
      if (!refreshMenu.contains(e.target as Node)) refreshMenu.open = false;
    };
    document.addEventListener("pointerdown", closeRefreshMenu);
    onCleanup(() => document.removeEventListener("pointerdown", closeRefreshMenu));
  });

  onMount(() => {
    let lastPointer: { x: number; y: number; at: number } | undefined;
    const rememberPointer = (e: PointerEvent) => {
      lastPointer = { x: e.clientX, y: e.clientY, at: Date.now() };
    };
    const flyToTaskButton = (e: Event) => {
      const origin = lastPointer;
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (!id || !origin || Date.now() - origin.at > TASK_FLIGHT_ORIGIN_MAX_AGE_MS || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
      const target = taskButton.getBoundingClientRect();
      setTaskFlights((flights) => [...flights, {
        id, fromX: origin.x, fromY: origin.y,
        toX: target.left + target.width / 2, toY: target.top + target.height / 2,
      }]);
    };
    document.addEventListener("pointerdown", rememberPointer, true);
    window.addEventListener(ENQUEUED_EVENT, flyToTaskButton);
    onCleanup(() => {
      document.removeEventListener("pointerdown", rememberPointer, true);
      window.removeEventListener(ENQUEUED_EVENT, flyToTaskButton);
    });
  });

  createEffect(() => {
    if (!drawerOpen()) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawerOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  // Every navigation (sidebar click, clicking into a row, back/forward) flows
  // through here — the single integration point that keeps the tab strip in
  // sync with the actual route, without touching individual navigate() calls.
  //
  // It also carries each tab's query string (sub-tab, file path…) across
  // switches: arriving at a tab's path with no query (tab chip, sidebar,
  // closing a neighbor) restores the one it had when you left; any other
  // query change is recorded as the tab's latest.
  let lastPath: string | undefined;
  createEffect(() => {
    const path = location.pathname, search = location.search;
    openOrActivate(path, labelFor(path));
    const arrived = path !== lastPath;
    lastPath = path;
    const saved = tabSearch(path);
    if (arrived && !search && saved) navigate(path + saved, { replace: true });
    else setTabSearch(path, search);
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
    // No neighbor left → back to the detail page's own list (/containers/x → /containers).
    const dest = leftNeighbor(path)?.path ?? path.replace(/\/[^/]+$/, "");
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

  // Drag-to-reorder over pointer events (HTML5 DnD has no touch support).
  // Mouse drags after 5px; touch needs a 300ms hold first so a plain swipe
  // still scrolls the strip. Reorders live: the target slot is how many
  // other chips' midpoints lie left of the pointer. The dragged chip follows
  // the pointer; the others FLIP-slide into their new slots. All geometry is
  // layout-based (offsetLeft within the `relative` strip), so in-flight
  // slide animations never feed back into the slot calculation.
  let strip!: HTMLDivElement;
  let dragged = false;
  const [drag, setDrag] = createSignal<{ path: string; x: number } | null>(null);
  const startDrag = (path: string, e: PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const mouse = e.pointerType === "mouse", x0 = e.clientX;
    const chips = () => [...strip.querySelectorAll<HTMLElement>("[data-tab-path]")];
    const self = (e.target as HTMLElement).closest<HTMLElement>("[data-tab-path]")!;
    const pos0 = self.offsetLeft - strip.scrollLeft;
    let active = false;
    const activate = () => { active = true; setDrag({ path, x: 0 }); };
    const hold = mouse ? undefined : setTimeout(activate, 300);
    const move = (ev: PointerEvent) => {
      if (!active) {
        if (Math.abs(ev.clientX - x0) < 5) return;
        if (!mouse) return end(); // swipe before the hold: let it scroll
        activate();
      }
      const px = ev.clientX - strip.getBoundingClientRect().left + strip.scrollLeft;
      const others = chips().filter((c) => c !== self);
      const to = others.filter((c) => px > c.offsetLeft + c.offsetWidth / 2).length;
      if (tabs().findIndex((t) => t.path === path) !== to) {
        const before = new Map(others.map((c) => [c, c.offsetLeft]));
        moveTab(path, to);
        for (const [c, x] of before) {
          const dx = x - c.offsetLeft;
          if (dx) c.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration: 180, easing: "ease-out" });
        }
      }
      setDrag({ path, x: ev.clientX - x0 - (self.offsetLeft - strip.scrollLeft - pos0) });
    };
    const noScroll = (ev: TouchEvent) => { if (active) ev.preventDefault(); };
    const end = () => {
      clearTimeout(hold);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("touchmove", noScroll);
      if (!active) return;
      setDrag(null);
      dragged = true; // swallow the click that follows the drop
      setTimeout(() => (dragged = false));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("touchmove", noScroll, { passive: false });
  };

  const taskBadgeCount = () => unseenFailureCount() || runningCount();
  const taskButtonLabel = () => {
    const failed = unseenFailureCount();
    return `${panelHidden() ? "显示" : "隐藏"}任务面板${failed ? `，${failed} 个任务失败` : runningCount() ? `，${runningCount()} 个任务运行中` : ""}`;
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
            <span aria-hidden="true" class="text-xl leading-none">☰</span>
          </button>
          {/* Phones need the room for the tab strip; the drawer shows the name. */}
          <span class="hidden font-bold text-zinc-100 sm:inline lg:hidden">phyless</span>

          {/* Tab strip */}
          <div ref={strip} class="relative flex min-w-0 items-center gap-1 overflow-x-auto">
            <TabChip
              tab={OVERVIEW_TAB}
              active={location.pathname === OVERVIEW_TAB.path}
              onActivate={() => navigate(OVERVIEW_TAB.path)}
            />
            <For each={tabs()}>
              {(t) => (
                <TabChip
                  tab={t}
                  active={location.pathname === t.path}
                  dragX={drag()?.path === t.path ? drag()!.x : null}
                  onActivate={() => !dragged && navigate(t.path, { replace: true })}
                  onClose={() => closeAndNavigate(t.path)}
                  onDragStart={(e) => startDrag(t.path, e)}
                />
              )}
            </For>
          </div>

          {/* Right group: task panel toggle, refresh now + settings, theme. */}
          <button
            ref={taskButton}
            class={`ml-auto flex h-6 shrink-0 items-center gap-1 rounded p-1 text-sm hover:bg-zinc-800 ${panelHidden() ? "text-zinc-400 hover:text-zinc-100" : "bg-zinc-800 text-zinc-100"}`}
            onClick={() => panelHidden() ? showTaskPanel() : setPanelHidden(true)}
            title={taskButtonLabel()}
            aria-label={taskButtonLabel()}
          >
            <span class="relative flex">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" aria-hidden="true" class={unseenFailureCount() ? "text-red-400" : runningCount() ? "text-indigo-400" : ""}>
                <path d="M9 11l3 3 8-8" /><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
              </svg>
              <Show when={taskBadgeCount()}>
                <span class={`absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full ${unseenFailureCount() ? "bg-red-500" : "animate-pulse bg-indigo-500"}`} />
              </Show>
            </span>
            <Show when={taskBadgeCount() > 0}>
              <span aria-hidden="true" class={`rounded-full px-1.5 text-xs ${unseenFailureCount() ? "bg-red-500/20 text-red-300" : "bg-indigo-500/20 text-indigo-300"}`}>{taskBadgeCount()}</span>
            </Show>
          </button>
          {/* Refresh: one split control — left half refreshes now, the arrow opens
              the settings popover. Indigo = auto-refresh on, grey = off. */}
          <div class="relative flex h-6 shrink-0 items-stretch rounded border border-zinc-800">
            <button
              class={`inline-flex w-6 items-center justify-center rounded-l hover:bg-zinc-800 hover:text-zinc-100 ${autoRefresh() ? "text-indigo-400" : "text-zinc-400"}`}
              onClick={refreshAll}
              title="立即刷新"
              aria-label="立即刷新"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
              </svg>
            </button>
            <details ref={refreshMenu} class="group flex">
              <summary
                class={`flex cursor-pointer list-none items-center rounded-r border-l border-zinc-800 px-1 hover:bg-zinc-800 hover:text-zinc-100 group-open:bg-zinc-800 group-open:text-zinc-100 ${autoRefresh() ? "text-indigo-400" : "text-zinc-400"}`}
                title={autoRefresh() ? `刷新设置（自动刷新：每 ${refreshSeconds()} 秒）` : "刷新设置（自动刷新已关闭）"}
                aria-label="刷新设置"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="10" height="10" aria-hidden="true" class="transition-transform group-open:rotate-180">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </summary>
              <div class="absolute right-0 top-full z-50 mt-2 w-64 rounded-lg border border-zinc-700/50 bg-zinc-900 p-3 text-sm text-zinc-200 shadow-2xl">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <div class="font-medium text-zinc-100">自动刷新</div>
                    <div class="text-xs text-zinc-500">{autoRefresh() ? `每 ${refreshSeconds()} 秒更新列表` : "已关闭，仅手动刷新"}</div>
                  </div>
                  <button
                    role="switch"
                    aria-checked={autoRefresh()}
                    aria-label="自动刷新"
                    class={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${autoRefresh() ? "bg-indigo-600" : "bg-zinc-700"}`}
                    onClick={() => setAutoRefresh(!autoRefresh())}
                  >
                    <span class={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${autoRefresh() ? "left-[1.125rem]" : "left-0.5"}`} />
                  </button>
                </div>
                <div class="mt-3 border-t border-zinc-800 pt-3 transition-opacity" classList={{ "pointer-events-none opacity-40": !autoRefresh() }}>
                  <div class="mb-1.5 text-xs text-zinc-500">刷新间隔</div>
                  <div class="grid grid-cols-5 gap-1">
                    <For each={REFRESH_PRESETS}>
                      {(sec) => (
                        <button
                          class={`border py-0.5 font-mono text-xs transition-colors ${refreshSeconds() === sec ? "border-indigo-500 bg-indigo-500/15 text-indigo-300" : "border-zinc-700 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"}`}
                          onClick={() => setRefreshSeconds(sec)}
                        >{sec}s</button>
                      )}
                    </For>
                  </div>
                  <label class="mt-2 flex items-center justify-between text-xs text-zinc-500">
                    自定义
                    <span class="flex items-center gap-1">
                      <input
                        type="number" min="1" step="1" value={refreshSeconds()}
                        class="w-16 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-right font-mono text-zinc-200"
                        onChange={(e) => setRefreshSeconds(Number(e.currentTarget.value))}
                      />
                      秒
                    </span>
                  </label>
                </div>
              </div>
            </details>
          </div>
        </header>

        <main class="flex-1 overflow-auto p-4 lg:p-6">
          {props.children}
        </main>
      </div>
      {/* Global task queue panel — mounted once here (inside the Router, so
          it can navigate) and never remounted by route changes. */}
      <TaskQueueWidget />
      <ImageInspectModal />
      <For each={taskFlights()}>
        {(flight) => (
          <span
            aria-hidden="true"
            class="task-launch-flight"
            style={`left:${flight.fromX}px;top:${flight.fromY}px;--task-flight-x:${flight.toX - flight.fromX}px;--task-flight-y:${flight.toY - flight.fromY}px`}
            onAnimationEnd={(e) => e.target === e.currentTarget && setTaskFlights((flights) => flights.filter((item) => item.id !== flight.id))}
          >
            <span><span>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12l4 4L19 6" />
              </svg>
            </span></span>
          </span>
        )}
      </For>
    </div>
  );
};
