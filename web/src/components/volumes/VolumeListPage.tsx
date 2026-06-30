import { Component, createSignal, onMount, onCleanup, Show } from "solid-js";
import { createResourceStore } from "../../stores/resource";
import { Table, type Column } from "../shared/Table";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { FileBrowser } from "../shared/FileBrowser";
import { get, post, del } from "../../api/client";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import type { VolumeSummary, FileEntry } from "../../types";

export const VolumeListPage: Component = () => {
  const store = createResourceStore<VolumeSummary>("/api/volumes");
  const [show, setShow] = createSignal(false);
  const [name, setName] = createSignal("");
  const [browse, setBrowse] = createSignal<VolumeSummary | null>(null);

  onMount(() => store.startPolling());
  onCleanup(() => store.stopPolling());

  const create = async () => {
    try { await post("/api/volumes", { name: name() }); setShow(false); setName(""); await store.refresh(); }
    catch (e) { toast.error((e as Error).message); }
  };
  const remove = async (n: string) => {
    try { await del(`/api/volumes/${encodeURIComponent(n)}`); await store.refresh(); }
    catch (e) { toast.error((e as Error).message); }
  };
  const listFiles = (sub: string) =>
    get<FileEntry[]>(`/api/volumes/${encodeURIComponent(browse()!.Name)}/files?path=${encodeURIComponent(sub)}`);

  const columns: Column<VolumeSummary>[] = [
    { header: "名称", cell: (v) => <span class="font-medium">{v.Name}</span> },
    { header: "驱动", cell: (v) => <span>{v.Driver}</span> },
    { header: "挂载点", cell: (v) => <span class="text-xs text-zinc-400">{v.Mountpoint}</span> },
    {
      header: "操作",
      cell: (v) => (
        <div class="flex gap-1">
          <Button onClick={() => setBrowse(v)}>浏览</Button>
          <Show when={hasRole("operator")}>
            <Button variant="danger" onClick={() => remove(v.Name)}>删除</Button>
          </Show>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-xl font-semibold">存储卷</h1>
        <Show when={hasRole("operator")}>
          <Button variant="primary" onClick={() => setShow(true)}>创建卷</Button>
        </Show>
      </div>
      <Show when={store.error()}><p class="mb-2 text-sm text-red-400">{store.error()}</p></Show>
      <Table rows={store.items()} columns={columns} rowKey={(v) => v.Name} />

      <Modal open={show()} onClose={() => setShow(false)} title="创建存储卷">
        <input class="mb-3 w-full rounded bg-zinc-800 px-3 py-2" placeholder="卷名" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
        <div class="flex justify-end gap-2">
          <Button onClick={() => setShow(false)}>取消</Button>
          <Button variant="primary" onClick={create}>创建</Button>
        </div>
      </Modal>

      <Modal open={!!browse()} onClose={() => setBrowse(null)} title={`浏览 ${browse()?.Name ?? ""}`} wide>
        <Show when={browse()}>
          <FileBrowser listPath={listFiles} />
        </Show>
      </Modal>
    </div>
  );
};
