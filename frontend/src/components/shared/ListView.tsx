import {
  createEffect, createMemo, createSignal, on, onCleanup, For, Show,
  type Accessor, type Component, type JSX,
} from "solid-js";
import { createTabState } from "../../stores/tabs";

const MIN_PAGE = 20;

export type Cmp<T> = (a: T, b: T) => number;
/** Comparator on one field: numbers numerically, strings in natural (zh/numeric) order. */
export const by = <T,>(f: (t: T) => string | number | undefined): Cmp<T> => (a, b) => {
  const x = f(a) ?? "", y = f(b) ?? "";
  return typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "zh-CN", { numeric: true });
};

export type Tone = "emerald" | "amber" | "sky" | "zinc" | "red" | "violet" | "teal";
/** Chips in the same `group` OR together; different groups AND (e.g. 运行中|暂停 ∧ 可升级). */
export interface ListFilter<T> { key: string; label: string; tone: Tone; title?: string; group?: string; match: (t: T) => boolean; }
export interface SortState { key: string; desc: boolean; }

/** Shared search + filter chip + header sort + lazy-load for every list page. */
export function createListView<T>(
  items: Accessor<T[]>,
  text: (item: T) => string,
  opts?: { rowHeight?: number; sort?: Record<string, Cmp<T>>; filters?: ListFilter<T>[] },
) {
  // ponytail: page size fixed at init — a resize/rotate keeps the old page, which only
  // changes how many rows one loadMore adds. Recompute in an effect if that ever matters.
  const page = Math.max(MIN_PAGE, Math.ceil((window.innerHeight * 1.5) / (opts?.rowHeight ?? 48)));
  const [query, setQuery] = createTabState("listQuery", "");
  const [filter, setFilter] = createTabState<string[]>("listFilter", []);
  const [sort, setSort] = createTabState<SortState | null>("listSort", null);
  const [limit, setLimit] = createSignal(page);

  const filters = opts?.filters ?? [];
  const count = (key: string) => items().filter(filters.find((f) => f.key === key)!.match).length;
  const filtered = createMemo(() => {
    const groups = new Map<string, ListFilter<T>[]>();
    for (const f of filters) if (filter().includes(f.key)) groups.set(f.group ?? "", [...(groups.get(f.group ?? "") ?? []), f]);
    const pool = groups.size ? items().filter((i) => [...groups.values()].every((fs) => fs.some((f) => f.match(i)))) : items();
    const q = query().trim().toLowerCase();
    const hits = q ? pool.filter((i) => text(i).toLowerCase().includes(q)) : pool;
    const s = sort();
    const cmp = s && opts?.sort?.[s.key];
    return cmp ? [...hits].sort((a, b) => (s.desc ? cmp(b, a) : cmp(a, b))) : hits;
  });
  const visible = createMemo(() => filtered().slice(0, limit()));
  const hasMore = createMemo(() => filtered().length > limit());
  // Click cycle per column: ascending → descending → original order.
  const toggleSort = (key: string) =>
    setSort((s) => (s?.key !== key ? { key, desc: false } : !s.desc ? { key, desc: true } : null));

  createEffect(on([query, filter], () => setLimit(page), { defer: true }));

  return {
    query, setQuery, filter, setFilter, filters, count, sort, toggleSort,
    filtered, visible, hasMore, loadMore: () => setLimit((l) => l + page),
  };
}

/** Clickable column header; `k` is a key of createListView's `sort` map. */
export const SortHead: Component<{
  view: { sort: Accessor<SortState | null>; toggleSort: (k: string) => void };
  k: string;
  class: string;
  children: JSX.Element;
}> = (p) => {
  const dir = () => (p.view.sort()?.key === p.k ? (p.view.sort()!.desc ? "desc" : "asc") : undefined);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-sort={dir() === "asc" ? "ascending" : dir() === "desc" ? "descending" : "none"}
      class={`${p.class} cursor-pointer select-none transition-colors hover:text-zinc-300 ${dir() ? "text-zinc-300" : ""}`}
      onClick={() => p.view.toggleSort(p.k)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.view.toggleSort(p.k); } }}
    >
      {p.children}<span class="ml-1 inline-block w-2">{dir() === "asc" ? "↑" : dir() === "desc" ? "↓" : ""}</span>
    </div>
  );
};

const TONE: Record<Tone, [idle: string, active: string]> = {
  emerald: ["border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20", "border-emerald-500 bg-emerald-500/20 text-emerald-300"],
  amber: ["border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20", "border-amber-500 bg-amber-500/20 text-amber-300"],
  sky: ["border-sky-500/40 bg-sky-500/10 text-sky-400 hover:bg-sky-500/20", "border-sky-500 bg-sky-500/20 text-sky-300"],
  zinc: ["border-zinc-500/40 bg-zinc-500/10 text-zinc-400 hover:bg-zinc-500/20", "border-zinc-400 bg-zinc-500/25 text-zinc-300"],
  red: ["border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20", "border-red-500 bg-red-500/20 text-red-300"],
  violet: ["border-violet-500/40 bg-violet-500/10 text-violet-400 hover:bg-violet-500/20", "border-violet-500 bg-violet-500/20 text-violet-300"],
  teal: ["border-teal-500/40 bg-teal-500/10 text-teal-400 hover:bg-teal-500/20", "border-teal-500 bg-teal-500/20 text-teal-400"],
};

/** Multi-select filter chips for a list toolbar; a chip with no matches hides unless active. */
export const FilterChips: Component<{
  view: { filters: ListFilter<never>[]; filter: Accessor<string[]>; setFilter: (k: string[]) => void; count: (k: string) => number };
  onChange?: () => void;
}> = (p) => (
  <For each={p.view.filters}>
    {(f) => {
      const on = () => p.view.filter().includes(f.key);
      return (
        <Show when={on() || p.view.count(f.key) > 0}>
          <button
            class={`border px-1.5 py-0.5 text-[11px] transition-colors ${TONE[f.tone][on() ? 1 : 0]}`}
            title={on() ? `取消筛选${f.label}` : f.title ?? `筛选${f.label}`}
            onClick={() => { p.view.setFilter(on() ? p.view.filter().filter((k) => k !== f.key) : [...p.view.filter(), f.key]); p.onChange?.(); }}
          >
            {f.label} {p.view.count(f.key)}{on() ? " ✕" : ""}
          </button>
        </Show>
      );
    }}
  </For>
);

export const SearchBox: Component<{
  value: string;
  onInput: (v: string) => void;
  placeholder?: string;
}> = (p) => (
  <div class="relative w-full sm:max-w-xs">
    <svg
      xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"
      class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500"
    >
      <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
    </svg>
    <input
      class="w-full border border-zinc-800 bg-zinc-900/60 py-1.5 pl-8 pr-8 text-sm text-zinc-200 placeholder-zinc-500 outline-none focus:border-indigo-500 focus:bg-zinc-900"
      placeholder={p.placeholder}
      value={p.value}
      onInput={(e) => p.onInput(e.currentTarget.value)}
    />
    <Show when={p.value}>
      <button
        class="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
        aria-label="清除搜索"
        onClick={() => p.onInput("")}
      >
        ×
      </button>
    </Show>
  </div>
);

export const LoadMore: Component<{ when: boolean; onMore: () => void }> = (p) => {
  let el: HTMLDivElement | undefined;
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    p.onMore();
    // One callback per intersection; re-arm so a sentinel still on screen after
    // growing loads the next page instead of going silent.
    if (el) { io.unobserve(el); io.observe(el); }
  }, { rootMargin: "200px" });
  onCleanup(() => io.disconnect());
  return (
    <Show when={p.when}>
      <div ref={(e) => { el = e; io.observe(e); }} class="h-px" />
    </Show>
  );
};
