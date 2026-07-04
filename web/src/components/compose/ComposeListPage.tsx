import { Component, createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { createResourceStore } from "../../stores/resource";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { post, del } from "../../api/client";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import { containerName, STATE_DOT, fmtContainerStatus } from "../containers/containerActions";
import type { ComposeProject, ContainerSummary } from "../../types";

const LABEL_PROJECT = "com.docker.compose.project";
const LABEL_CONFIG_FILES = "com.docker.compose.project.config_files";

// Mirrors the matching handleListCompose (internal/api/compose.go) does
// server-side: discovered projects match by the project label directly, but
// registered ones match by compose_file — a registered project's `name` is
// user-typed and may not equal the actual docker compose project name.
function containersOf(p: ComposeProject, all: ContainerSummary[]): ContainerSummary[] {
  if (p.discovered) return all.filter((c) => c.Labels?.[LABEL_PROJECT] === p.name);
  return all.filter((c) => c.Labels?.[LABEL_CONFIG_FILES]?.split(",")[0] === p.compose_file);
}

export const ComposeListPage: Component = () => {
  const navigate = useNavigate();
  const store = createResourceStore<ComposeProject>("/api/compose");
  const containers = createResourceStore<ContainerSummary>("/api/containers");
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [show, setShow] = createSignal(false);
  const [form, setForm] = createSignal({ name: "", base_dir: "", compose_file: "", env_file: "" });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  onMount(() => { store.startPolling(); containers.startPolling(); });
  onCleanup(() => { store.stopPolling(); containers.stopPolling(); });

  const toggleExpand = (id: string) =>
    setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const create = async () => {
    try {
      await post("/api/compose", form());
      setShow(false); setForm({ name: "", base_dir: "", compose_file: "", env_file: "" });
      await store.refresh();
    } catch (e) { toast.error((e as Error).message); }
  };
  const remove = async (id: string) => {
    try { await del(`/api/compose?id=${encodeURIComponent(id)}`); await store.refresh(); }
    catch (e) { toast.error((e as Error).message); }
  };

  return (
    <div>
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-xl font-semibold">Compose</h1>
        <Show when={hasRole("operator")}>
          <Button variant="primary" onClick={() => setShow(true)}>注册项目</Button>
        </Show>
      </div>
      <Show when={store.error()}><p class="mb-2 text-sm text-red-400">{store.error()}</p></Show>

      <div class="flex flex-col gap-2">
        <For each={store.items()}>
          {(p) => {
            const isOpen = () => expanded().has(p.id);
            const cs = () => containersOf(p, containers.items());
            return (
              <div class="border border-zinc-800">
                <div
                  class="flex flex-wrap items-center gap-3 px-3 py-2 cursor-pointer hover:bg-white/[0.03] transition-colors"
                  onClick={() => toggleExpand(p.id)}
                >
                  <span class={`text-zinc-500 transition-transform ${isOpen() ? "rotate-90" : ""}`}>▸</span>
                  <span class="font-medium">{p.name}</span>
                  <Show when={p.discovered}>
                    <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400" title="根据容器上的 compose 标签自动发现，非手动注册">自动发现</span>
                  </Show>
                  <span class={`text-xs ${(p.running ?? 0) > 0 ? "text-emerald-400" : "text-zinc-500"}`}>
                    {p.total ? `${p.running ?? 0}/${p.total} 运行中` : "未部署"}
                  </span>
                  <span class="text-xs text-zinc-400">{p.base_dir}</span>
                  <span class="text-xs text-zinc-400">{p.compose_file}</span>
                  <div class="ml-auto flex gap-1" onClick={(e) => e.stopPropagation()}>
                    <Button onClick={() => navigate(`/compose/${p.id}`, { replace: true })}>详情</Button>
                    <Show when={hasRole("operator") && !p.discovered}>
                      <Button variant="danger" onClick={() => remove(p.id)}>删除</Button>
                    </Show>
                  </div>
                </div>
                <Show when={isOpen()}>
                  <div class="divide-y divide-zinc-800/60 border-t border-zinc-800 bg-zinc-950/40">
                    <For each={cs()} fallback={<div class="px-8 py-3 text-xs text-zinc-500">无容器</div>}>
                      {(c) => (
                        <a
                          href={`/containers/${c.Id}`}
                          class="flex items-center gap-2 px-8 py-1.5 text-xs hover:bg-white/[0.03] transition-colors"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(`/containers/${c.Id}`, { replace: true }); }}
                        >
                          <span class={`h-2 w-2 shrink-0 rounded-full ${STATE_DOT[c.State] ?? "bg-zinc-600"}`} />
                          <span class="font-medium text-zinc-200">{containerName(c) || c.Id.slice(0, 12)}</span>
                          <span class="text-zinc-500">{fmtContainerStatus(c.State, c.Status)}</span>
                          <span class="ml-auto max-w-[16rem] truncate text-zinc-400">{c.Image}</span>
                        </a>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
        <Show when={store.items().length === 0 && !store.error()}>
          <div class="border border-zinc-800 py-16 text-center text-zinc-400">暂无 Compose 项目</div>
        </Show>
      </div>

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
