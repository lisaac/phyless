import { Component, createSignal, onMount, onCleanup, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { createResourceStore } from "../../stores/resource";
import { Table, type Column } from "../shared/Table";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { post, del } from "../../api/client";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import type { ComposeProject } from "../../types";

export const ComposeListPage: Component = () => {
  const navigate = useNavigate();
  const store = createResourceStore<ComposeProject>("/api/compose");
  const [show, setShow] = createSignal(false);
  const [form, setForm] = createSignal({ name: "", base_dir: "", compose_file: "", env_file: "" });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  onMount(() => store.startPolling());
  onCleanup(() => store.stopPolling());

  const create = async () => {
    try {
      await post("/api/compose", form());
      setShow(false); setForm({ name: "", base_dir: "", compose_file: "", env_file: "" });
      await store.refresh();
    } catch (e) { toast.error((e as Error).message); }
  };
  const remove = async (id: string) => {
    try { await del(`/api/compose/${id}`); await store.refresh(); }
    catch (e) { toast.error((e as Error).message); }
  };

  const columns: Column<ComposeProject>[] = [
    { header: "名称", cell: (p) => <span class="font-medium">{p.name}</span> },
    { header: "目录", cell: (p) => <span class="text-xs text-zinc-400">{p.base_dir}</span> },
    { header: "文件", cell: (p) => <span class="text-xs text-zinc-400">{p.compose_file}</span> },
    {
      header: "操作",
      cell: (p) => (
        <div class="flex gap-1">
          <Button onClick={() => navigate(`/compose/${p.id}`)}>详情</Button>
          <Show when={hasRole("operator")}>
            <Button variant="danger" onClick={() => remove(p.id)}>删除</Button>
          </Show>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-xl font-semibold">Compose</h1>
        <Show when={hasRole("operator")}>
          <Button variant="primary" onClick={() => setShow(true)}>注册项目</Button>
        </Show>
      </div>
      <Show when={store.error()}><p class="mb-2 text-sm text-red-400">{store.error()}</p></Show>
      <Table rows={store.items()} columns={columns} rowKey={(p) => p.id} />

      <Modal open={show()} onClose={() => setShow(false)} title="注册 Compose 项目">
        <input class="mb-2 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="名称" value={form().name} onInput={(e) => set("name", e.currentTarget.value)} />
        <input class="mb-2 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="base 目录 /opt/stacks/app" value={form().base_dir} onInput={(e) => set("base_dir", e.currentTarget.value)} />
        <input class="mb-2 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="compose 文件 /opt/stacks/app/compose.yaml" value={form().compose_file} onInput={(e) => set("compose_file", e.currentTarget.value)} />
        <input class="mb-3 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="env 文件 (可选)" value={form().env_file} onInput={(e) => set("env_file", e.currentTarget.value)} />
        <div class="flex justify-end gap-2">
          <Button onClick={() => setShow(false)}>取消</Button>
          <Button variant="primary" onClick={create}>注册</Button>
        </div>
      </Modal>
    </div>
  );
};
