import { Component, createSignal, createResource, onMount, onCleanup, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { createResourceStore } from "../../stores/resource";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { ComposeActionModal, isComposeRunning, requestComposeAction, type ComposeAction } from "./ComposeActionModal";
import { get, imageInspectUrl } from "../../api/client";
import { queued, isPending } from "../../stores/taskQueue";
import { inspectToRunCmd } from "../../api/inspect";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import { createContainerActions, fmtContainerStatus, fmtRelTime } from "../containers/containerActions";
import { ContainerRow } from "../containers/ContainerRow";
import { ViewCmdModal } from "../containers/ViewCmdModal";
import { ConsoleModal } from "../containers/ConsoleModal";
import { CreateContainerModal } from "../containers/CreateContainerModal";
import { RegisterComposeModal } from "./RegisterComposeModal";
import { createListView, SearchBox, LoadMore } from "../shared/ListView";
import { containersOf, representative, ActBtn, ComposeIcon } from "./composeShared";
import type { ComposeProject, ContainerSummary } from "../../types";

const DEFAULT_RUN = "docker run -d --name my-container nginx:latest";

export const ComposeListPage: Component = () => {
  const navigate = useNavigate();
  const store = createResourceStore<ComposeProject>("/api/compose");
  const containers = createResourceStore<ContainerSummary>("/api/containers");
  const { isP, act } = createContainerActions();
  const view = createListView(store.items, (p) =>
    `${p.name} ${p.id} ${p.base_dir} ${p.compose_file} ${containersOf(p, containers.items())
      .map((c) => `${c.Names.join(" ")} ${c.Image}`).join(" ")}`, { rowHeight: 72 });
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [runTarget, setRunTarget] = createSignal<{ id: string; name: string } | null>(null);
  const [consoleTarget, setConsoleTarget] = createSignal<{ id: string; name: string } | null>(null);
  const [composeTarget, setComposeTarget] = createSignal<ComposeAction | null>(null);
  const isRunning = isComposeRunning;
  const request = (a: ComposeAction) => requestComposeAction(a, setComposeTarget);
  // Run/Compose reuses the same flow as the container list's own Run/Compose
  // button: feed CreateContainerModal the merged run commands and let its
  // own single-vs-multi detection decide between "创建容器" and "注册
  // Compose", instead of a separate read-only viewer.
  const [runText, setRunText] = createSignal<string | null>(null);
  const [show, setShow] = createSignal(false);
  const [inspectFor, setInspectFor] = createSignal<ComposeProject | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [inspectData] = createResource(inspectFor, (p) => get<any>(`/api/compose/detail?id=${encodeURIComponent(p.id)}`));

  onMount(() => { store.startPolling(); containers.startPolling(); });
  onCleanup(() => { store.stopPolling(); containers.stopPolling(); });

  const toggleExpand = (id: string) =>
    setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const runProject = async (containerIds: string[]) => {
    if (containerIds.length === 0) { setRunText(DEFAULT_RUN); return; }
    const cmds = await Promise.all(containerIds.map(async (id) => {
      const container = await get<any>(`/api/containers/${id}/inspect`);
      let image: any = {};
      try { image = await get<any>(imageInspectUrl(container.Image)); } catch { /* ignore */ }
      return inspectToRunCmd(container, image);
    }));
    setRunText(cmds.join("\n\n"));
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(`删除 Compose 项目 ${name}？`)) return;
    try {
      await queued(`删除 Compose ${name}`, "DELETE", `/api/compose?id=${encodeURIComponent(id)}`, undefined, { key: `compose:${id}` });
      await store.refresh();
      toast.success("已删除");
    } catch (e) { toast.error((e as Error).message); }
  };

  // Discovered projects carry the raw compose labels (working_dir /
  // config_files / environment_file) — the create handler stores them
  // verbatim and splitComposePaths handles the comma-separated file list.
  const register = async (p: ComposeProject) => {
    const name = p.project_name || p.name;
    try {
      await queued(`注册 Compose ${name}`, "POST", "/api/compose",
        { name, base_dir: p.base_dir, compose_file: p.compose_file, env_file: p.env_file ?? "" }, { key: `compose:${p.id}` });
      await store.refresh();
      toast.success("已注册");
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
      <div class="mb-3">
        <SearchBox value={view.query()} onInput={view.setQuery} placeholder="搜索 Compose…" />
      </div>
      <Show when={store.error()}><p class="mb-2 text-sm text-red-400">{store.error()}</p></Show>

      <div class="flex flex-col gap-2">
        <For each={view.visible()}>
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
                  class={`flex flex-col gap-2 px-3 py-2 cursor-pointer transition-colors sm:flex-row sm:items-start sm:gap-3 ${
                    (p.running ?? 0) > 0 ? "bg-sky-500/[0.05] hover:bg-sky-500/[0.09]" : "hover:bg-white/[0.03]"
                  }`}
                  onClick={() => toggleExpand(p.id)}
                >
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5 font-medium">
                      <ComposeIcon size={14} />
                      <a
                        href={`/compose/${p.id}`}
                        class={`border-b border-dashed border-zinc-600 transition-colors hover:border-indigo-400 hover:text-indigo-400 ${nameColor()}`}
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
                    <Show when={p.base_dir}>
                      <div class="text-[11px] text-zinc-500" title={p.base_dir}>目录：{p.base_dir}</div>
                    </Show>
                  </div>
                  <div class="flex shrink-0 flex-wrap items-center gap-0.5 sm:ml-auto sm:justify-end" onClick={(e) => e.stopPropagation()}>
                    <Show when={hasRole("operator")}>
                      <Show when={p.discovered} fallback={
                        <>
                          <Show when={p.can_build}>
                            <ActBtn title="docker compose build" loading={isRunning(p.id, "build")} onClick={() => request({ id: p.id, name: p.name, verb: "build" })}>⚒︎ Build</ActBtn>
                          </Show>
                          <ActBtn danger title="删除项目" onClick={() => remove(p.id, p.name)}>⊖ 删除</ActBtn>
                        </>
                      }>
                        <ActBtn title="注册为项目" loading={isPending((t) => t.key === `compose:${p.id}`)} onClick={() => void register(p)}>⊕ 注册</ActBtn>
                      </Show>
                      <span class="mx-0.5 text-zinc-600">│</span>
                    </Show>
                    <Show when={hasRole("operator")}>
                      <ActBtn title="docker compose up -d" loading={isRunning(p.id, "up")} onClick={() => request({ id: p.id, name: p.name, verb: "up" })}>▶ Up</ActBtn>
                      <ActBtn title="docker compose restart" loading={isRunning(p.id, "restart")} onClick={() => request({ id: p.id, name: p.name, verb: "restart" })}>↺ Restart</ActBtn>
                      <ActBtn title="docker compose stop" loading={isRunning(p.id, "stop")} onClick={() => request({ id: p.id, name: p.name, verb: "stop" })}>■ Stop</ActBtn>
                      <ActBtn title="docker compose pause" loading={isRunning(p.id, "pause")} onClick={() => request({ id: p.id, name: p.name, verb: "pause" })}>⏸ Pause</ActBtn>
                      <ActBtn
                        danger
                        title="docker compose down（停止并移除容器、网络）"
                        loading={isRunning(p.id, "down")}
                        onClick={() => { if (confirm(`停止并移除 ${p.name} 的所有容器和网络？`)) request({ id: p.id, name: p.name, verb: "down" }); }}
                      >⊘ Down</ActBtn>
                      <ActBtn title="docker compose pull" loading={isRunning(p.id, "pull")} onClick={() => request({ id: p.id, name: p.name, verb: "pull" })}>↓ Pull</ActBtn>
                      <ActBtn
                        title="更新：build（若有）→ pull → down → up"
                        loading={isRunning(p.id, "update")}
                        onClick={() => request({ id: p.id, name: p.name, verb: "update", canBuild: p.can_build })}
                      >⬆ Update</ActBtn>
                      <span class="mx-0.5 text-zinc-600">│</span>
                    </Show>
                    <ActBtn title="inspect" onClick={() => setInspectFor(p)}>⌕ Inspect</ActBtn>
                    <ActBtn
                      title="基于项目下所有容器创建容器 / 注册 Compose"
                      onClick={() => void runProject(cs().map((c) => c.Id))}
                    >⧉ Run/Compose</ActBtn>
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
        <LoadMore when={view.hasMore()} onMore={view.loadMore} />
        <Show when={view.filtered().length === 0 && !store.error()}>
          <div class="border border-zinc-800 py-16 text-center text-zinc-400">
            {store.items().length === 0 ? "暂无 Compose 项目" : "无匹配结果"}
          </div>
        </Show>
      </div>

      <RegisterComposeModal
        open={show()}
        onClose={() => setShow(false)}
        onRegistered={() => { setShow(false); void store.refresh(); }}
      />

      <ViewCmdModal target={runTarget()} onClose={() => setRunTarget(null)} />
      <ConsoleModal target={consoleTarget()} onClose={() => setConsoleTarget(null)} />
      <CreateContainerModal
        open={runText() !== null}
        initialRun={runText() ?? undefined}
        onClose={() => setRunText(null)}
      />

      <ComposeActionModal target={composeTarget()} onClose={() => setComposeTarget(null)} />

      <Modal open={!!inspectFor()} onClose={() => setInspectFor(null)} title={`Inspect · ${inspectFor()?.name ?? ""}`} wide>
        <Show when={!inspectData.loading} fallback={<p class="text-xs text-zinc-500">加载中…</p>}>
          <pre class="max-h-[70vh] overflow-auto bg-zinc-950 p-4 font-mono text-xs leading-5 text-zinc-400">
            {JSON.stringify(inspectData(), null, 2)}
          </pre>
        </Show>
      </Modal>
    </div>
  );
};
