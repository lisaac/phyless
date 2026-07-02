import { Component, createSignal, onMount, onCleanup, Show } from "solid-js";
import { createResourceStore } from "../../stores/resource";
import { Table, type Column } from "../shared/Table";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { post, del } from "../../api/client";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import type { NetworkSummary } from "../../types";

export const NetworkListPage: Component = () => {
  const store = createResourceStore<NetworkSummary>("/api/networks");
  const [show, setShow] = createSignal(false);
  const [form, setForm] = createSignal({ name: "", driver: "bridge", subnet: "", gateway: "", parent: "" });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const needsParent = () => form().driver === "macvlan" || form().driver === "ipvlan";

  onMount(() => store.startPolling());
  onCleanup(() => store.stopPolling());

  const create = async () => {
    const f = form();
    const body: Record<string, unknown> = { name: f.name, driver: f.driver };
    if (f.subnet) body.subnet = f.subnet;
    if (f.gateway) body.gateway = f.gateway;
    if (f.parent) body.parent = f.parent;
    try {
      await post("/api/networks", body);
      setShow(false);
      setForm({ name: "", driver: "bridge", subnet: "", gateway: "", parent: "" });
      await store.refresh();
    } catch (e) { toast.error((e as Error).message); }
  };
  const remove = async (id: string) => {
    try { await del(`/api/networks/${id}`); await store.refresh(); }
    catch (e) { toast.error((e as Error).message); }
  };

  const columns: Column<NetworkSummary>[] = [
    { header: "名称", cell: (n) => <span class="font-medium">{n.Name}</span> },
    { header: "驱动", cell: (n) => <span>{n.Driver}</span> },
    { header: "范围", cell: (n) => <span class="text-zinc-400">{n.Scope}</span> },
    {
      header: "操作",
      cell: (n) => (
        <Show when={hasRole("operator")}>
          <Button variant="danger" onClick={() => remove(n.Id)}>删除</Button>
        </Show>
      ),
    },
  ];

  return (
    <div>
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-xl font-semibold">网络</h1>
        <Show when={hasRole("operator")}>
          <Button variant="primary" onClick={() => setShow(true)}>创建网络</Button>
        </Show>
      </div>
      <Show when={store.error()}><p class="mb-2 text-sm text-red-400">{store.error()}</p></Show>
      <Table rows={store.items()} columns={columns} rowKey={(n) => n.Id} />

      <Modal open={show()} onClose={() => setShow(false)} title="创建网络">
        <input class="mb-2 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="名称" value={form().name} onInput={(e) => set("name", e.currentTarget.value)} />
        <select class="mb-2 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" value={form().driver} onChange={(e) => set("driver", e.currentTarget.value)}>
          <option value="bridge">bridge</option>
          <option value="macvlan">macvlan</option>
          <option value="ipvlan">ipvlan</option>
        </select>
        <input class="mb-2 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="子网 192.168.1.0/24 (可选)" value={form().subnet} onInput={(e) => set("subnet", e.currentTarget.value)} />
        <input class="mb-2 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="网关 192.168.1.1 (可选)" value={form().gateway} onInput={(e) => set("gateway", e.currentTarget.value)} />
        <Show when={needsParent()}>
          <input class="mb-2 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="父接口 eth0" value={form().parent} onInput={(e) => set("parent", e.currentTarget.value)} />
        </Show>
        <div class="flex justify-end gap-2">
          <Button onClick={() => setShow(false)}>取消</Button>
          <Button variant="primary" onClick={create}>创建</Button>
        </div>
      </Modal>
    </div>
  );
};
