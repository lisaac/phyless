import { Component, For, Show, createResource, createSignal } from "solid-js";
import { get } from "../../api/client";
import { settled } from "../../stores/resource";
import { fmtBytes, fmtWhen } from "./Inspect";

// One row of `docker history` (GET /api/images/history), newest layer first.
interface HistoryItem { Id: string; Created: number; CreatedBy: string; Size: number; Comment?: string }

/** Strip builder noise from CreatedBy: "#(nop)" metadata steps, the
 *  "/bin/sh -c" of RUN lines and BuildKit's trailing "# buildkit". */
export function layerCmd(s: string): string {
  return s
    .replace(/\s*# buildkit$/, "")
    .replace(/^\/bin\/sh -c #\(nop\)\s*/, "")
    .replace(/^(RUN )?\/bin\/sh -c /, "RUN ")
    .trim();
}

const Row: Component<{ idx: string; size: number; max: number; when?: number; children: any }> = (p) => (
  <div class="flex flex-wrap items-start gap-x-3 gap-y-1 border-t border-zinc-800/60 px-3 py-2 text-xs first:border-t-0 sm:flex-nowrap">
    <span class="w-6 shrink-0 font-mono text-zinc-500">{p.idx}</span>
    <div class="w-20 shrink-0">
      <div class={p.size ? "text-zinc-200" : "text-zinc-600"}>{fmtBytes(p.size)}</div>
      <Show when={p.size > 0}>
        <div class="mt-1 h-0.5 bg-indigo-500/60" style={{ width: `${Math.max(4, (p.size / p.max) * 100)}%` }} />
      </Show>
    </div>
    <span class="shrink-0 text-zinc-500 sm:w-36">{p.when === undefined ? "" : fmtWhen(p.when)}</span>
    <div class="min-w-0 basis-full sm:basis-auto sm:flex-1">{p.children}</div>
  </div>
);

// A long command (apt-get chains, heredocs) folds to two lines; click unfolds.
const Cmd: Component<{ text: string; raw: string; dim: boolean }> = (p) => {
  const [open, setOpen] = createSignal(false);
  return (
    <button
      type="button"
      class={`w-full whitespace-pre-wrap break-all text-left font-mono ${open() ? "block" : "line-clamp-2"} ${p.dim ? "text-zinc-500" : "text-zinc-200"}`}
      title={open() ? undefined : p.raw}
      onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
    >{p.text || "—"}</button>
  );
};

/** Image layers with per-layer size and the command that built them. Shared
 *  by the image list's 层 modal and the container detail 层 tab; a container
 *  passes `writable` to add its own writable layer on top. */
export const LayerTable: Component<{
  image: string;
  writable?: { size?: number; loading?: boolean; onShow?: () => void };
}> = (p) => {
  const [res] = createResource(() => p.image, async (id) => {
    try { return { items: await get<HistoryItem[]>(`/api/images/history?id=${encodeURIComponent(id)}`) }; }
    catch (error) { return { error: error as Error }; }
  });
  const items = () => settled(res)?.items ?? [];
  const total = () => items().reduce((n, h) => n + h.Size, 0);
  const max = () => Math.max(1, p.writable?.size ?? 0, ...items().map((h) => h.Size));
  const fileLayers = () => items().filter((h) => h.Size > 0).length;

  return (
    <Show
      when={!res.loading && !settled(res)?.error}
      fallback={<p class={settled(res)?.error ? "text-xs text-red-400" : "text-xs text-zinc-500"}>{settled(res)?.error ? `加载失败：${settled(res)!.error!.message}` : "加载中…"}</p>}
    >
      <p class="mb-2 text-xs text-zinc-500">
        <Show when={p.writable}>可写层 {p.writable!.loading ? "计算中…" : fmtBytes(p.writable!.size)} · </Show>
        镜像 {items().length} 层（{fileLayers()} 层含文件，其余只改元数据），合计 {fmtBytes(total())}
      </p>
      <div class="border border-zinc-800">
        <div class="hidden gap-3 border-b border-zinc-800 px-3 py-1.5 text-[10px] uppercase tracking-widest text-zinc-500 sm:flex">
          <span class="w-6 shrink-0">#</span>
          <span class="w-20 shrink-0">大小</span>
          <span class="w-36 shrink-0">创建</span>
          <span class="flex-1">层命令</span>
        </div>
        <Show when={p.writable}>
          {(w) => (
            <Row idx="W" size={w().size ?? 0} max={max()}>
              <span class="text-zinc-200">容器可写层</span>
              <Show when={w().onShow}>
                <button type="button" class="ml-2 text-indigo-400 hover:text-indigo-300 hover:underline" onClick={() => w().onShow!()}>查看改动</button>
              </Show>
            </Row>
          )}
        </Show>
        <For each={items()}>
          {(h, i) => (
            <Row idx={String(items().length - i())} size={h.Size} max={max()} when={h.Created}>
              <Cmd text={layerCmd(h.CreatedBy)} raw={h.CreatedBy} dim={!h.Size} />
              <Show when={h.Comment}><div class="mt-0.5 text-zinc-500">{h.Comment}</div></Show>
            </Row>
          )}
        </For>
      </div>
    </Show>
  );
};
