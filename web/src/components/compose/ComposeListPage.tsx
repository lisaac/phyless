import { Component, createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { createResourceStore } from "../../stores/resource";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { PullStatusWidget } from "../shared/PullStatusWidget";
import { get, post, del } from "../../api/client";
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
  const [runProject, setRunProject] = createSignal<{ id: string; name: string } | null>(null);
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
  const remove = async (id: string, name: string) => {
    if (!confirm(`删除 Compose 项目 ${name}？`)) return;
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
            // 全部运行中 → 绿色, 部分运行中 → 蓝色, 未运行/退出 → 默认（无强调色）
            const nameColor = () => {
              const running = p.running ?? 0;
              const total = p.total ?? 0;
              if (total > 0 && running === total) return "text-emerald-400";
              if (running > 0) return "text-sky-400";
              return "";
            };
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
                      <a
                        href={`/compose/${p.id}`}
                        class={`hover:text-indigo-400 hover:underline transition-colors ${nameColor()}`}
                        onClick={(e) => { e.stopPropagation(); e.preventDefault(); navigate(`/compose/${p.id}`, { replace: true }); }}
                      >{p.name}</a>
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
                    <div class="mt-0.5 text-[11px] text-zinc-400">{p.compose_file}</div>
                  </div>
                  <div class="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                    <Show when={hasRole("operator")}>
                      <ActBtn title="docker compose up -d" onClick={() => setComposeAction({ id: p.id, name: p.name, verb: "up" })}>▶ Up</ActBtn>
                      <ActBtn title="docker compose restart" onClick={() => setComposeAction({ id: p.id, name: p.name, verb: "restart" })}>↺ Restart</ActBtn>
                      <ActBtn title="docker compose stop" onClick={() => setComposeAction({ id: p.id, name: p.name, verb: "stop" })}>■ Stop</ActBtn>
                      <ActBtn
                        danger
                        title="docker compose down（停止并移除容器、网络）"
                        onClick={() => { if (confirm(`停止并移除 ${p.name} 的所有容器和网络？`)) setComposeAction({ id: p.id, name: p.name, verb: "down" }); }}
                      >⊘ Down</ActBtn>
                      <ActBtn title="docker compose pull" onClick={() => setComposeAction({ id: p.id, name: p.name, verb: "pull" })}>↓ Pull</ActBtn>
                      <span class="mx-0.5 text-zinc-600">│</span>
                    </Show>
                    <ActBtn
                      title="查看 docker compose config 反推出的 docker run 命令"
                      onClick={() => setRunProject({ id: p.id, name: p.name })}
                    >⧉ Run/Compose</ActBtn>
                    <Show when={hasRole("operator") && !p.discovered}>
                      <ActBtn danger title="删除项目" onClick={() => remove(p.id, p.name)}>删除</ActBtn>
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
                  {/* overflow-hidden must carry NO padding/border of its own —
                      those add real box height on top of the "auto min-height
                      is 0 under overflow:hidden" trick that lets the grid row
                      actually reach 0px, which is why a p-2/border-t placed
                      directly here used to leave a sliver visible even when
                      collapsed. Padding/border live one level deeper instead. */}
                  <div class="overflow-hidden">
                    <div class="border-t border-zinc-800 p-2">
                      {/* Boxed the same way ComposeDetailPage's info-tab "容器"
                          section is (mt-1 border border-zinc-800) — this used
                          to be just a top border, which read differently from
                          the detail page's own container list. */}
                      <div class="border border-zinc-800">
                        <Show when={cs().length > 0} fallback={<div class="px-3 py-3 text-xs text-zinc-500">无容器</div>}>
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
      <Show when={runProject()}>
        {(p) => (
          <BulkRunModal
            reqKey={p().id}
            title={p().name}
            fetchCmds={async () => (await get<{ commands: string[] }>(`/api/compose/run-commands?id=${encodeURIComponent(p().id)}`)).commands}
            onClose={() => setRunProject(null)}
          />
        )}
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
