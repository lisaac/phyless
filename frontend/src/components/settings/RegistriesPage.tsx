import { Component, createSignal, onMount, Show } from "solid-js";
import { createResourceStore } from "../../stores/resource";
import { Table, type Column } from "../shared/Table";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { request } from "../../api/client";
import { queued } from "../../stores/taskQueue";
import { toast } from "../shared/Toast";
import type { Registry } from "../../types";

export const RegistriesPage: Component = () => {
  const store = createResourceStore<Registry>("/api/registries", "id");
  const [show, setShow] = createSignal(false);
  const [form, setForm] = createSignal({ url: "", username: "", password: "" });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  onMount(() => store.refresh());

  const create = async () => {
    try { await queued(`添加仓库 ${form().url}`, "POST", "/api/registries", form()); setShow(false); setForm({ url: "", username: "", password: "" }); await store.refresh(); }
    catch (e) { toast.error((e as Error).message); }
  };
  const remove = async (id: string) => {
    try { await queued("删除仓库", "DELETE", `/api/registries/${id}`); await store.refresh(); }
    catch (e) { toast.error((e as Error).message); }
  };
  const test = async (id: string) => {
    try { // Connectivity probe, not a state change — stays a direct request.
      const r = await request<{ status: string }>("POST", `/api/registries/${id}/test`); toast.success(r.status); }
    catch (e) { toast.error((e as Error).message); }
  };

  const columns: Column<Registry>[] = [
    { header: "URL", cell: (r) => <span class="font-medium">{r.url}</span> },
    { header: "用户名", cell: (r) => <span>{r.username}</span> },
    {
      header: "操作",
      cell: (r) => (
        <div class="flex gap-1">
          <Button onClick={() => test(r.id)}>测试</Button>
          <Button variant="danger" onClick={() => remove(r.id)}>删除</Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-xl font-semibold">镜像仓库</h1>
        <Button variant="primary" onClick={() => setShow(true)}>添加仓库</Button>
      </div>
      <Show when={store.error()}><p class="mb-2 text-sm text-red-400">{store.error()}</p></Show>
      <Table rows={store.items()} columns={columns} rowKey={(r) => r.id} />

      <Modal open={show()} onClose={() => setShow(false)} title="添加镜像仓库">
        <input class="mb-2 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="https://registry.example.com" value={form().url} onInput={(e) => set("url", e.currentTarget.value)} />
        <input class="mb-2 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="用户名" value={form().username} onInput={(e) => set("username", e.currentTarget.value)} />
        <input class="mb-3 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" type="password" placeholder="密码" value={form().password} onInput={(e) => set("password", e.currentTarget.value)} />
        <div class="flex justify-end gap-2">
          <Button onClick={() => setShow(false)}>取消</Button>
          <Button variant="primary" onClick={create}>添加</Button>
        </div>
      </Modal>
    </div>
  );
};
