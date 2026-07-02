import { Component, createSignal, onMount, onCleanup, Show, For, JSX } from "solid-js";
import { createResourceStore } from "../../stores/resource";
import { Modal } from "../shared/Modal";
import { Button } from "../shared/Button";
import { StreamingLogModal } from "../shared/StreamingLogModal";
import { del, getToken, post } from "../../api/client";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import type { ImageSummary } from "../../types";

// Tiny icon SVG
const Ico = (p: { path: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="2" stroke-linecap="round"
       stroke-linejoin="round" width="14" height="14">
    <path d={p.path} />
  </svg>
);
const IBtn = (p: { title: string; onClick: () => void; loading?: boolean; danger?: boolean; children: JSX.Element }) => (
  <button
    title={p.title}
    disabled={p.loading}
    onClick={p.onClick}
    class={`inline-flex h-6 w-6 items-center justify-center transition-colors disabled:opacity-30 ${
      p.danger ? "text-zinc-400 hover:text-red-400"
                : "text-zinc-400 hover:text-zinc-100"}`}
  >
    {p.loading ? <span class="animate-spin text-xs">↺</span> : p.children}
  </button>
);

export const ImageListPage: Component = () => {
  const store = createResourceStore<ImageSummary>("/api/images");
  const [pullRef, setPullRef] = createSignal("");
  const [showPullInput, setShowPullInput] = createSignal(false);
  const [showPullLog, setShowPullLog] = createSignal(false);
  const [pullBody, setPullBody] = createSignal<{ image: string }>({ image: "" });
  const [tagFor, setTagFor] = createSignal<ImageSummary | null>(null);
  const [tagVal, setTagVal] = createSignal("");
  const [deletingId, setDeletingId] = createSignal("");
  const [confirmDelete, setConfirmDelete] = createSignal<ImageSummary | null>(null);

  onMount(() => store.startPolling());
  onCleanup(() => store.stopPolling());

  const startPull = () => {
    const ref = pullRef().trim();
    if (!ref) return;
    setPullBody({ image: ref });
    setShowPullInput(false);
    setShowPullLog(true);
  };

  const remove = async (id: string, force = false) => {
    setDeletingId(id);
    setConfirmDelete(null);
    try {
      await del(`/api/images/${encodeURIComponent(id)}${force ? "?force=true" : ""}`);
      await store.refresh();
      toast.success("已删除");
    } catch (e) {
      const msg = (e as Error).message;
      if (!force && (msg.includes("must be forced") || msg.includes("is being used") || msg.includes("referenced"))) {
        const img = store.items().find(i => i.Id === id) ?? null;
        setConfirmDelete(img ?? { Id: id, RepoTags: [], Size: 0, Created: 0 });
      } else {
        toast.error(msg);
      }
    }
    finally { setDeletingId(""); }
  };

  const addTag = async () => {
    const img = tagFor(); if (!img) return;
    try {
      await post(`/api/images/${encodeURIComponent(img.Id)}/tag`, { tag: tagVal() });
      toast.success("打标签成功");
      setTagFor(null); setTagVal("");
      await store.refresh();
    } catch (e) { toast.error((e as Error).message); }
  };

  const fmtSize = (b: number) => b >= 1e9
    ? `${(b / 1e9).toFixed(1)} GB`
    : `${(b / 1e6).toFixed(1)} MB`;

  return (
    <div>
      <div class="mb-3 flex items-center justify-between">
        <h1 class="text-xl font-semibold">镜像</h1>
        <Show when={hasRole("operator")}>
          <button
            class="border border-zinc-600 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-zinc-400 hover:text-zinc-100"
            onClick={() => setShowPullInput(true)}
          >
            + 拉取镜像
          </button>
        </Show>
      </div>

      <Show when={store.error()}><p class="mb-2 text-sm text-red-400">{store.error()}</p></Show>

      <table class="w-full text-left text-sm">
        <thead class="border-b border-zinc-800 text-xs uppercase text-zinc-500">
          <tr>
            <th class="px-2 py-2">标签</th>
            <th class="px-2 py-2">ID</th>
            <th class="px-2 py-2">大小</th>
            <th class="px-2 py-2">操作</th>
          </tr>
        </thead>
        <tbody>
          <For each={store.items()}>
            {(img) => (
              <tr class="border-b border-zinc-800/50 hover:bg-white/[0.03] transition-colors">
                <td class="px-2 py-2">
                  <For each={img.RepoTags ?? ["<none>"]}>
                    {(tag) => <div class="font-mono text-xs">{tag}</div>}
                  </For>
                </td>
                <td class="px-2 py-2 font-mono text-xs text-zinc-500">
                  {img.Id.replace("sha256:", "").slice(0, 12)}
                </td>
                <td class="px-2 py-2 text-xs text-zinc-400">{fmtSize(img.Size)}</td>
                <td class="px-2 py-2">
                  <div class="flex items-center gap-0.5">
                    {/* Export / Save */}
                    <a
                      title="导出 tar"
                      href={`/api/images/${encodeURIComponent(img.Id)}/save?token=${encodeURIComponent(getToken() ?? "")}`}
                      class="inline-flex h-6 w-6 items-center justify-center text-zinc-400 hover:text-zinc-100 transition-colors"
                    >
                      <Ico path="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                    </a>
                    <Show when={hasRole("operator")}>
                      {/* Tag */}
                      <IBtn title="打标签" onClick={() => { setTagFor(img); setTagVal(""); }}>
                        <Ico path="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01" />
                      </IBtn>
                      {/* Delete */}
                      <IBtn
                        title="删除"
                        danger
                        loading={deletingId() === img.Id}
                        onClick={() => void remove(img.Id)}
                      >
                        <Ico path="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
                      </IBtn>
                    </Show>
                  </div>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>

      <Show when={store.items().length === 0 && !store.error()}>
        <div class="py-12 text-center text-zinc-500">暂无镜像</div>
      </Show>

      {/* Pull input modal */}
      <Modal open={showPullInput()} onClose={() => setShowPullInput(false)} title="拉取镜像">
        <input
          class="mb-3 w-full border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-600 transition-colors"
          placeholder="nginx:latest"
          value={pullRef()}
          onInput={(e) => setPullRef(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && startPull()}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ref={(el: any) => setTimeout(() => el?.focus(), 50)}
        />
        <div class="flex justify-end gap-2">
          <Button onClick={() => setShowPullInput(false)}>取消</Button>
          <Button variant="primary" onClick={startPull}>拉取</Button>
        </div>
      </Modal>

      {/* Pull streaming log */}
      <StreamingLogModal
        open={showPullLog()}
        onClose={() => { setShowPullLog(false); setPullRef(""); }}
        title={`拉取 ${pullBody().image}`}
        url="/api/images/pull"
        body={pullBody()}
        onDone={() => void store.refresh()}
      />

      {/* Tag modal */}
      <Modal open={!!tagFor()} onClose={() => setTagFor(null)} title="添加标签">
        <p class="mb-2 text-xs text-zinc-500">
          当前：{tagFor()?.RepoTags?.[0] ?? tagFor()?.Id.replace("sha256:", "").slice(0, 12)}
        </p>
        <input
          class="mb-3 w-full border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-600 transition-colors"
          placeholder="myrepo/app:v2"
          value={tagVal()}
          onInput={(e) => setTagVal(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && addTag()}
          ref={(el: HTMLInputElement) => setTimeout(() => el?.focus(), 50)}
        />
        <div class="flex justify-end gap-2">
          <Button onClick={() => setTagFor(null)}>取消</Button>
          <Button variant="primary" onClick={addTag}>添加</Button>
        </div>
      </Modal>

      {/* Force-delete confirmation */}
      <Modal open={!!confirmDelete()} onClose={() => setConfirmDelete(null)} title="强制删除镜像">
        <p class="mb-1 text-sm text-zinc-300">该镜像正被容器使用，普通删除被拒绝。</p>
        <p class="mb-4 text-xs text-zinc-500">
          强制删除将移除镜像，已有容器会继续运行，但无法重新拉起该版本。
        </p>
        <div class="flex justify-end gap-2">
          <Button onClick={() => setConfirmDelete(null)}>取消</Button>
          <Button variant="danger" onClick={() => void remove(confirmDelete()!.Id, true)}>强制删除</Button>
        </div>
      </Modal>
    </div>
  );
};
