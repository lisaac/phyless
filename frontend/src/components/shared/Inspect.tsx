import { Component, JSX, For, Show, createSignal, createResource, createEffect, on } from "solid-js";
import { A, useLocation } from "@solidjs/router";
import { get, imageInspectUrl } from "../../api/client";
import { displayImage } from "../../api/inspect";
import { settled } from "../../stores/resource";
import type { ContainerSummary } from "../../types";
import { JsonView } from "./JsonView";
import { Modal } from "./Modal";

export const shortId = (id: string | undefined) => (id ?? "").replace(/^sha256:/, "").slice(0, 12);
export const cname = (c: { Names?: string[] }) => (c.Names?.[0] ?? "").replace(/^\//, "");

export function fmtBytes(b: number | undefined): string {
  if (!b) return "—";
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${(b / 1e6).toFixed(1)} MB`;
}

/** Unix seconds or an ISO string → local "YYYY/MM/DD hh:mm". */
export function fmtWhen(t: number | string | undefined): string {
  const d = typeof t === "number" ? new Date(t * 1000) : new Date(t ?? 0);
  if (!t || Number.isNaN(d.getTime()) || d.getFullYear() < 1971) return "—";
  return d.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// Compact key-info strip at the top of the Inspect / 文件 modals: `kind`
// names what is being looked at (容器 / 镜像 / Compose), then short
// "label value" pairs wrapping inline — one or two lines, not a list.
export const InfoBar: Component<{ kind: string; children: JSX.Element }> = (p) => (
  <div class="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 border border-zinc-800 px-3 py-1.5 text-xs">
    <span class="border border-indigo-500/60 px-1.5 text-[10px] text-indigo-400">{p.kind}</span>
    {p.children}
  </div>
);

export const Info: Component<{ k: string; title?: string; children: JSX.Element }> = (p) => (
  <span class="inline-flex min-w-0 max-w-full items-baseline gap-1.5 sm:max-w-[22rem]" title={p.title}>
    <span class="shrink-0 text-[10px] text-zinc-500">{p.k}</span>
    <span class="min-w-0 truncate font-mono text-zinc-200">{p.children}</span>
  </span>
);

/** Comma-separated container name links → container detail tab. */
export const ContainerLinks: Component<{ items: { Id: string; Name: string }[] }> = (p) => (
  <Show when={p.items.length > 0} fallback={<span class="text-zinc-500">—</span>}>
    <For each={p.items}>
      {(c, i) => (
        <>
          <Show when={i() > 0}>{", "}</Show>
          <A href={`/containers/${c.Id}`} replace class="text-indigo-400 hover:text-indigo-300 hover:underline" onClick={(e) => e.stopPropagation()}>
            {c.Name || shortId(c.Id)}
          </A>
        </>
      )}
    </For>
  </Show>
);

// ── Image inspect: one app-wide modal (mounted in Layout), opened from any
// image name/id link — the image list, container rows, container details. ──
const [imageRef, setImageRef] = createSignal<string | null>(null);
export const openImageInspect = (ref: string) => setImageRef(ref);

/** Image name + short id, both opening the image inspect. */
export const ImageLink: Component<{ id?: string; label: string; class?: string }> = (p) => {
  const open = (e: MouseEvent) => { e.stopPropagation(); openImageInspect(p.id || p.label); };
  return (
    <span class={`inline-flex min-w-0 max-w-full items-baseline gap-1.5 ${p.class ?? ""}`}>
      <button type="button" class="min-w-0 truncate text-left transition-colors hover:text-indigo-400 hover:underline" title={`查看镜像 inspect：${p.label}`} onClick={open}>
        {p.label}
      </button>
      <Show when={p.id}>
        <button type="button" class="shrink-0 font-mono text-zinc-500 transition-colors hover:text-indigo-400 hover:underline" title={p.id} onClick={open}>
          {shortId(p.id)}
        </button>
      </Show>
    </span>
  );
};

/** Image info strip — the image inspect modal and the image 文件 modal. */
export const ImageInfo: Component<{
  img: { Id: string; RepoTags?: string[] | null; Size?: number; Created?: number | string; Platform?: string; UsedBy?: { Id: string; Name: string }[] };
}> = (p) => {
  const tags = () => (p.img.RepoTags ?? []).join(", ") || "<none>";
  return (
    <InfoBar kind="镜像">
      <Info k="标签" title={tags()}>{tags()}</Info>
      <Info k="ID" title={p.img.Id}><span class="select-all">{shortId(p.img.Id)}</span></Info>
      <Info k="大小">{fmtBytes(p.img.Size)}</Info>
      <Show when={p.img.Platform}><Info k="平台">{p.img.Platform}</Info></Show>
      <Info k="创建">{fmtWhen(p.img.Created)}</Info>
      <Info k="使用容器"><ContainerLinks items={p.img.UsedBy ?? []} /></Info>
    </InfoBar>
  );
};

/** Container info strip — the container row's Inspect and 文件 modals. */
export const ContainerInfo: Component<{ c: ContainerSummary }> = (p) => {
  const project = () => p.c.Labels?.["com.docker.compose.project"];
  return (
    <InfoBar kind="容器">
      <Info k="名称">{cname(p.c) || "—"}</Info>
      <Info k="ID" title={p.c.Id}><span class="select-all">{shortId(p.c.Id)}</span></Info>
      <Info k="镜像" title={p.c.Image}><ImageLink id={p.c.ImageID} label={displayImage(p.c.Image, p.c.Labels)} /></Info>
      <Info k="状态">{p.c.Status || p.c.State}</Info>
      <Info k="创建">{fmtWhen(p.c.Created)}</Info>
      <Show when={project()}><Info k="Compose">{project()}</Info></Show>
    </InfoBar>
  );
};

export const ImageInspectModal: Component = () => {
  // Global modal: following a "使用容器" link must not leave it covering the new page.
  const loc = useLocation();
  createEffect(on(() => loc.pathname, () => setImageRef(null), { defer: true }));
  const [res] = createResource(imageRef, async (ref) => {
    try {
      const [data, containers] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        get<any>(imageInspectUrl(ref)),
        get<ContainerSummary[]>("/api/containers").catch(() => [] as ContainerSummary[]),
      ]);
      const usedBy = containers.filter((c) => c.ImageID === data?.Id).map((c) => ({ Id: c.Id, Name: cname(c) }));
      return { data, usedBy };
    } catch (error) { return { error }; }
  });
  const r = () => settled(res);
  const d = () => r()?.data;
  const title = () => d()?.RepoTags?.[0] ?? shortId(d()?.Id ?? imageRef() ?? "");

  return (
    <Modal open={!!imageRef()} onClose={() => setImageRef(null)} title={`Inspect · ${title()}`} wide>
      <Show
        when={!res.loading && d()}
        fallback={<p class={r()?.error ? "text-xs text-red-400" : "text-xs text-zinc-500"}>{r()?.error ? `加载失败：${(r()!.error as Error).message}` : "加载中…"}</p>}
      >
        <ImageInfo img={{ ...d(), Platform: [d().Os, d().Architecture, d().Variant].filter(Boolean).join("/"), UsedBy: r()!.usedBy }} />
        <JsonView data={d()} />
      </Show>
    </Modal>
  );
};
