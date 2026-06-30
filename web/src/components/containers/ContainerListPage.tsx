import { Component, createSignal, onMount, onCleanup, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { createResourceStore } from "../../stores/resource";
import { Table, type Column } from "../shared/Table";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { RunComposeEditor } from "../shared/RunComposeEditor";
import { post, del } from "../../api/client";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import { containerName, containerRunCommand } from "./containerActions";
import { CreateContainerModal } from "./CreateContainerModal";
import type { ContainerSummary } from "../../types";

export const ContainerListPage: Component = () => {
  const navigate = useNavigate();
  const store = createResourceStore<ContainerSummary>("/api/containers");
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [showCmd, setShowCmd] = createSignal<ContainerSummary | null>(null);
  const [showCreate, setShowCreate] = createSignal(false);

  onMount(() => store.startPolling());
  onCleanup(() => store.stopPolling());

  const toggle = (key: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  const toggleAll = (checked: boolean) =>
    setSelected(checked ? new Set(store.items().map((c) => c.Id)) : new Set());

  const act = async (id: string, verb: string) => {
    try {
      await post(`/api/containers/${id}/${verb}`);
      toast.info(`${verb} ok`);
      await store.refresh();
    } catch (e) {
      toast.error(`${verb} failed: ${(e as Error).message}`);
    }
  };
  const removeOne = async (id: string) => {
    try {
      await del(`/api/containers/${id}`);
      await store.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const bulk = async (verb: "start" | "stop" | "kill" | "delete") => {
    for (const id of selected()) {
      if (verb === "delete") await removeOne(id);
      else await act(id, verb);
    }
    setSelected(new Set());
  };

  const columns: Column<ContainerSummary>[] = [
    {
      header: "名称 / ID",
      cell: (c) => (
        <div>
          <div class="font-medium">{containerName(c)}</div>
          <div class="text-xs text-zinc-500">{c.Id.slice(0, 12)}</div>
        </div>
      ),
    },
    { header: "镜像", cell: (c) => <span class="text-zinc-300">{c.Image}</span> },
    {
      header: "状态",
      cell: (c) => (
        <span class={c.State === "running" ? "text-green-400" : "text-zinc-400"}>{c.Status}</span>
      ),
    },
    {
      header: "端口",
      cell: (c) => (
        <span class="text-xs">
          {c.Ports.filter((p) => p.PublicPort).map((p) => `${p.PublicPort}:${p.PrivatePort}`).join(", ")}
        </span>
      ),
    },
    {
      header: "操作",
      cell: (c) => (
        <div class="flex gap-1" onClick={(e) => e.stopPropagation()}>
          <Show when={hasRole("operator")}>
            <Show
              when={c.State === "running"}
              fallback={<Button variant="primary" onClick={() => act(c.Id, "start")}>启动</Button>}
            >
              <Button onClick={() => act(c.Id, "stop")}>停止</Button>
            </Show>
          </Show>
          <Button onClick={() => navigate(`/containers/${c.Id}`)}>详情</Button>
          <Button onClick={() => setShowCmd(c)}>命令</Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-xl font-semibold">容器</h1>
        <Show when={hasRole("operator")}>
          <Button variant="primary" onClick={() => setShowCreate(true)}>新建容器</Button>
        </Show>
      </div>

      <Show when={selected().size > 0 && hasRole("operator")}>
        <div class="mb-2 flex gap-2 rounded bg-zinc-900 p-2">
          <span class="px-2 py-1 text-sm text-zinc-400">{selected().size} 选中</span>
          <Button variant="primary" onClick={() => bulk("start")}>启动</Button>
          <Button onClick={() => bulk("stop")}>停止</Button>
          <Button variant="danger" onClick={() => bulk("kill")}>强制关闭</Button>
          <Button variant="danger" onClick={() => bulk("delete")}>删除</Button>
        </div>
      </Show>

      <Show when={store.error()}><p class="mb-2 text-sm text-red-400">{store.error()}</p></Show>

      <Table
        rows={store.items()}
        columns={columns}
        rowKey={(c) => c.Id}
        selectable={hasRole("operator")}
        selected={selected()}
        onToggle={toggle}
        onToggleAll={toggleAll}
      />

      <Modal open={!!showCmd()} onClose={() => setShowCmd(null)} title="启动命令" wide>
        <Show when={showCmd()}>
          {(c) => (
            <div class="h-[60vh]">
              <RunComposeEditor
                initialRun={containerRunCommand(c())}
                actions={(s) => (
                  <div class="flex gap-2">
                    <Button onClick={() => navigator.clipboard.writeText(s.run)}>复制 docker run</Button>
                    <Button onClick={() => navigator.clipboard.writeText(s.compose)}>复制 compose</Button>
                    <Button onClick={() => setShowCmd(null)}>关闭</Button>
                  </div>
                )}
              />
            </div>
          )}
        </Show>
      </Modal>

      <CreateContainerModal
        open={showCreate()}
        onClose={() => setShowCreate(false)}
        onCreated={() => { setShowCreate(false); void store.refresh(); }}
      />
    </div>
  );
};
