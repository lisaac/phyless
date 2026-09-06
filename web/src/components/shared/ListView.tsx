import {
  createEffect, createMemo, createSignal, on, onCleanup, Show,
  type Accessor, type Component,
} from "solid-js";

const MIN_PAGE = 20;

/** Shared search + lazy-load for every list page. */
export function createListView<T>(
  items: Accessor<T[]>,
  text: (item: T) => string,
  opts?: { rowHeight?: number },
) {
  // ponytail: page size fixed at init — a resize/rotate keeps the old page, which only
  // changes how many rows one loadMore adds. Recompute in an effect if that ever matters.
  const page = Math.max(MIN_PAGE, Math.ceil((window.innerHeight * 1.5) / (opts?.rowHeight ?? 48)));
  const [query, setQuery] = createSignal("");
  const [limit, setLimit] = createSignal(page);

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (!q) return items();
    return items().filter((i) => text(i).toLowerCase().includes(q));
  });
  const visible = createMemo(() => filtered().slice(0, limit()));
  const hasMore = createMemo(() => filtered().length > limit());

  createEffect(on(query, () => setLimit(page), { defer: true }));

  return { query, setQuery, filtered, visible, hasMore, loadMore: () => setLimit((l) => l + page) };
}

export const SearchBox: Component<{
  value: string;
  onInput: (v: string) => void;
  placeholder?: string;
}> = (p) => (
  <div class="relative w-full sm:max-w-xs">
    <input
      class="w-full bg-zinc-900 border border-zinc-800 px-3 py-2 pr-8 text-sm text-zinc-200 placeholder-zinc-500 outline-none focus:border-indigo-500"
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
