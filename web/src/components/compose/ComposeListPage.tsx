import { Component, createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { createResourceStore } from "../../stores/resource";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { PullStatusWidget } from "../shared/PullStatusWidget";
import { post, del } from "../../api/client";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import { createContainerActions, fmtContainerStatus, fmtRelTime } from "../containers/containerActions";
import { ContainerRow } from "../containers/ContainerRow";
import { ViewCmdModal } from "../containers/ViewCmdModal";
import { ConsoleModal } from "../containers/ConsoleModal";
import { BulkRunModal } from "../containers/BulkRunModal";
import { containersOf, representative, ActBtn, ComposeIcon, type ComposeVerb, VERB_LABEL } from "./composeShared";
import type { ComposeProject, ContainerSummary } from "../../types";

export const ComposeListPage: Component = () => {
  const navigate = useNavigate();
  const store = createResourceStore<ComposeProject>("/api/compose");
  const containers = createResourceStore<ContainerSummary>("/api/containers");
  const { isP, act } = createContainerActions(containers.refresh);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [runTarget, setRunTarget] = createSignal<{ id: string; name: string } | null>(null);
  const [consoleTarget, setConsoleTarget] = createSignal<{ id: string; name: string } | null>(null);
  const [composeAction, setComposeAction] = createSignal<{ id: string; name: string; verb: ComposeVerb } | null>(null);
  const [bulkRunIds, setBulkRunIds] = createSignal<string[] | null>(null);
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
      toast.success("已注册");
    } catch (e) { toast.error((e as Error).message); }
  };
  const remove = async (id: string) => {
    try {
      await del(`/api/compose?id=${encodeURIComponent(id)}`);
      await store.refresh();
      toast.success("已删除");
    } catch (e) { toast.error((e as Error).message); }
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
            const rep = () => representative(cs());
            return (
              <div class="border border-zinc-800">
                <div
                  class={`flex items-start gap-3 px-3 py-2 cursor-pointer transition-colors ${
                    (p.running ?? 0) > 0 ? "bg-sky-500/[0.05] hover:bg-sky-500/[0.09]" : "hover:bg-white/[0.03]"
                  }`}
                  onClick={() => toggleExpand(p.id)}
                >
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5 font-medium">
                      <ComposeIcon size={14} />
                      {p.name}
                    </div>
                    <div class="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                      <Show when={p.discovered}>
                        <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400" title="根据容器上的 compose 标签自动发现，非手动注册">自动发现</span>
                      </Show>
                      <span class={(p.running ?? 0) > 0 ? "text-emerald-400" : "text-zinc-500"}>
                        {p.total ? `${p.running ?? 0}/${p.total} 运行中` : "未部署"}
                      </span>
                      <Show when={rep()}>
                        {(r) => <span class="text-zinc-400">{fmtContainerStatus(r().State, r().Status)}{" · 创建 "}{fmtRelTime(r().Created)}</span>}
                      </Show>
                    </div>
                    <div class="mt-0.5 text-[11px] text-zinc-400">{p.base_dir} · {p.compose_file}</div>
                  </div>
                  <div class="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                    <Show when={hasRole("operator")}>
                      <ActBtn title="docker compose up -d" onClick={() => setComposeAction({ id: p.id, name: p.name, verb: "up" })}>▶ Up</ActBtn>
                      <ActBtn title="docker compose stop" onClick={() => setComposeAction({ id: p.id, name: p.name, verb: "stop" })}>■ Stop</ActBtn>
                      <ActBtn title="docker compose down（停止并移除容器、网络）" onClick={() => setComposeAction({ id: p.id, name: p.name, verb: "down" })}>⊘ Down</ActBtn>
                      <ActBtn title="docker compose restart" onClick={() => setComposeAction({ id: p.id, name: p.name, verb: "restart" })}>↺ Restart</ActBtn>
                      <ActBtn title="docker compose pull" onClick={() => setComposeAction({ id: p.id, name: p.name, verb: "pull" })}>↓ Pull</ActBtn>
                      <span class="mx-0.5 text-zinc-600">│</span>
                    </Show>
                    <ActBtn
                      title="查看该项目容器的 docker run / compose 命令"
                      onClick={() => { const ids = cs().map((c) => c.Id); if (ids.length) setBulkRunIds(ids); }}
                    >⧉ Run/Compose</ActBtn>
                    <ActBtn title="查看详情" onClick={() => navigate(`/compose/${p.id}`, { replace: true })}>ⓘ 详情</ActBtn>
                    <Show when={hasRole("operator") && !p.discovered}>
                      <ActBtn danger title="删除项目" onClick={() => remove(p.id)}>删除</ActBtn>
                    </Show>
                  </div>
                </div>
                {/* CSS grid-rows 0fr→1fr animates height without knowing the
                    content's real height up front — <Show> would just snap
                    the content in/out with no transition to play. */}
                <div
                  class="grid transition-[grid-template-rows] duration-200 ease-out"
                  style={{ "grid-template-rows": isOpen() ? "1fr" : "0fr" }}
                >
                  <div class="overflow-hidden">
                    <div class="border-t border-zinc-800">
                      <Show when={cs().length > 0} fallback={<div class="px-8 py-3 text-xs text-zinc-500">无容器</div>}>
                        <div class="divide-y divide-zinc-800">
                          <For each={cs()}>
                            {(c) => (
                              <ContainerRow
                                c={c}
                                isP={isP}
                                act={act}
                                onViewCmd={setRunTarget}
                                onConsole={setConsoleTarget}
                              />
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  </div>
                </div>
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

      <ViewCmdModal target={runTarget()} onClose={() => setRunTarget(null)} />
      <ConsoleModal target={consoleTarget()} onClose={() => setConsoleTarget(null)} />
      <Show when={bulkRunIds()}>
        {(ids) => <BulkRunModal ids={ids()} onClose={() => setBulkRunIds(null)} />}
      </Show>

      <PullStatusWidget
        active={!!composeAction()}
        title={`${VERB_LABEL[composeAction()?.verb ?? "up"]} — ${composeAction()?.name ?? ""}`}
        url={`/api/compose/${composeAction()?.verb ?? "up"}?id=${encodeURIComponent(composeAction()?.id ?? "")}`}
        onDone={() => { void store.refresh(); void containers.refresh(); }}
        onClose={() => setComposeAction(null)}
      />
    </div>
  );
};
