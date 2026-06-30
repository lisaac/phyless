import { Component, createSignal, onMount, onCleanup, Show } from "solid-js";
import { createResourceStore } from "../../stores/resource";
import { Table, type Column } from "../shared/Table";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { post, del, getToken } from "../../api/client";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import type { ImageSummary } from "../../types";

export const ImageListPage: Component = () => {
  const store = createResourceStore<ImageSummary>("/api/images");
  const [showPull, setShowPull] = createSignal(false);
  const [pullRef, setPullRef] = createSignal("");
  const [tagFor, setTagFor] = createSignal<ImageSummary | null>(null);
  const [tagVal, setTagVal] = createSignal("");

  onMount(() => store.startPolling());
  onCleanup(() => store.stopPolling());

  const pull = async () => {
    try {
      await post("/api/images/pull", { image: pullRef() });
      toast.info("pulled");
      setShowPull(false); setPullRef("");
      await store.refresh();
    } catch (e) { toast.error((e as Error).message); }
  };
  const remove = async (id: string) => {
    try { await del(`/api/images/${encodeURIComponent(id)}`); await store.refresh(); }
    catch (e) { toast.error((e as Error).message); }
  };
  const addTag = async () => {
    const img = tagFor(); if (!img) return;
    try {
      await post(`/api/images/${encodeURIComponent(img.Id)}/tag`, { tag: tagVal() });
      toast.info("tagged");
      setTagFor(null); setTagVal("");
      await store.refresh();
    } catch (e) { toast.error((e as Error).message); }
  };

  const columns: Column<ImageSummary>[] = [
    { header: "标签", cell: (i) => <span>{(i.RepoTags ?? ["<none>"]).join(", ")}</span> },
    { header: "ID", cell: (i) => <span class="text-xs text-zinc-500">{i.Id.replace("sha256:", "").slice(0, 12)}</span> },
    { header: "大小", cell: (i) => <span>{(i.Size / 1024 / 1024).toFixed(1)} MB</span> },
    {
      header: "操作",
      cell: (i) => (
        <div class="flex gap-1">
          <a class="rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700"
             href={`/api/images/${encodeURIComponent(i.Id)}/save?token=${encodeURIComponent(getToken() ?? "")}`}>导出</a>
          <Show when={hasRole("operator")}>
            <Button onClick={() => setTagFor(i)}>打标签</Button>
            <Button variant="danger" onClick={() => remove(i.Id)}>删除</Button>
          </Show>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-xl font-semibold">镜像</h1>
        <Show when={hasRole("operator")}>
          <Button variant="primary" onClick={() => setShowPull(true)}>拉取镜像</Button>
        </Show>
      </div>
      <Show when={store.error()}><p class="mb-2 text-sm text-red-400">{store.error()}</p></Show>
      <Table rows={store.items()} columns={columns} rowKey={(i) => i.Id} />

      <Modal open={showPull()} onClose={() => setShowPull(false)} title="拉取镜像">
        <input class="mb-3 w-full rounded bg-zinc-800 px-3 py-2" placeholder="nginx:latest"
               value={pullRef()} onInput={(e) => setPullRef(e.currentTarget.value)} />
        <div class="flex justify-end gap-2">
          <Button onClick={() => setShowPull(false)}>取消</Button>
          <Button variant="primary" onClick={pull}>拉取</Button>
        </div>
      </Modal>

      <Modal open={!!tagFor()} onClose={() => setTagFor(null)} title="添加标签">
        <input class="mb-3 w-full rounded bg-zinc-800 px-3 py-2" placeholder="myrepo/app:v2"
               value={tagVal()} onInput={(e) => setTagVal(e.currentTarget.value)} />
        <div class="flex justify-end gap-2">
          <Button onClick={() => setTagFor(null)}>取消</Button>
          <Button variant="primary" onClick={addTag}>添加</Button>
        </div>
      </Modal>
    </div>
  );
};
