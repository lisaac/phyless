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
import { composeActionAvailability, composeProjectState, containersOf, representative, ComposeIcon } from "./composeShared";
import { IBtn, Ico } from "../shared/ActionButton";
import { confirmAction } from "../shared/ConfirmModal";
import type { ComposeProject, ContainerSummary } from "../../types";

const DEFAULT_RUN = "docker run -d --name my-container nginx:latest";

export const ComposeListPage: Component = () => {
  const navigate = useNavigate();
  const store = createResourceStore<ComposeProject>("/api/compose", "id");
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
    if (!await confirmAction(`注销 Compose 项目 ${name}？`, { title: "注销 Compose 项目", confirmText: "注销", danger: true })) return;
    try {
      await queued(`注销 Compose ${name}`, "DELETE", `/api/compose?id=${encodeURIComponent(id)}`, undefined, { key: `compose:${id}` });
      await store.refresh();
      toast.success("已注销");
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
  const down = async (p: ComposeProject) => {
    if (await confirmAction(`停止并移除 ${p.name} 的所有容器和网络？`, { title: "停止并移除 Compose", confirmText: "继续", danger: true })) {
      request({ id: p.id, name: p.name, verb: "down" });
    }
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

      <div class="overflow-x-auto border border-zinc-800">
        <div class="hidden border-b border-zinc-800 text-xs text-zinc-500 sm:flex">
          <div class="w-96 shrink-0 px-3 py-2">项目</div>
          <div class="w-32 shrink-0 px-3 py-2">运行状态</div>
          <div class="min-w-0 flex-1 px-3 py-2">Compose 文件</div>
        </div>
        <div class="divide-y divide-zinc-800">
          <For each={view.visible()}>
            {(p) => {
              const isOpen = () => expanded().has(p.id);
              const cs = () => containersOf(p, containers.items());
              const hasContainers = () => cs().length > 0;
              const rep = () => representative(cs());
              const state = () => composeProjectState(p);
              const available = () => composeActionAvailability(p);
              // 全部运行中 → 绿色, 部分运行中 → 蓝色, 未运行/退出 → 默认（无强调色）
              const statusColor = () => {
                if (state() === "running") return "text-emerald-400";
                if (state() === "partial") return "text-sky-400";
                return "";
              };
              const rowBg = () => state() === "running"
                ? "bg-emerald-500/[0.08] hover:bg-emerald-500/[0.13]"
                : state() === "partial"
                  ? "bg-sky-500/[0.04] hover:bg-sky-500/[0.08]"
                  : state() === "empty"
                    ? "bg-slate-500/[0.06] hover:bg-slate-500/[0.11]"
                    : "hover:bg-white/[0.03]";
              const actionButtons = () => (
                <>
                  <Show when={hasRole("operator")}>
                    <IBtn title={available().up ? "docker compose up -d" : "项目中的容器均已运行"} disabled={!available().up} loading={isRunning(p.id, "up")} onClick={() => request({ id: p.id, name: p.name, verb: "up" })}>▶</IBtn>
                    <IBtn title={available().pause ? "docker compose pause" : "没有运行中的容器可暂停"} disabled={!available().pause} loading={isRunning(p.id, "pause")} onClick={() => request({ id: p.id, name: p.name, verb: "pause" })}>⏸</IBtn>
                    <IBtn title={available().restart ? "docker compose restart" : "没有运行中的容器可重启"} disabled={!available().restart} loading={isRunning(p.id, "restart")} onClick={() => request({ id: p.id, name: p.name, verb: "restart" })}>↺</IBtn>
                    <IBtn title={available().stop ? "docker compose stop" : "没有运行中的容器可停止"} disabled={!available().stop} loading={isRunning(p.id, "stop")} onClick={() => request({ id: p.id, name: p.name, verb: "stop" })}>■</IBtn>
                    <span class="mx-0.5 text-zinc-400">│</span>
                    <IBtn title="Pull/Build：拉取镜像并构建；不执行 down/up" loading={isRunning(p.id, "pull")} onClick={() => request({ id: p.id, name: p.name, verb: "pull", canBuild: p.can_build })}>↓</IBtn>
                    <IBtn title="Update：Pull/Build → down → up" loading={isRunning(p.id, "update")} onClick={() => request({ id: p.id, name: p.name, verb: "update", canBuild: p.can_build })}>↑</IBtn>
                    <span class="mx-0.5 text-zinc-400">│</span>
                  </Show>
                  <IBtn title="inspect" onClick={() => setInspectFor(p)}>
                    <Ico path="M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM21 21l-4.35-4.35" />
                  </IBtn>
                  <IBtn title="基于项目下所有容器创建容器 / 注册 Compose" onClick={() => void runProject(cs().map((c) => c.Id))}>
                    <ComposeIcon size={14} />
                  </IBtn>
                  <Show when={hasRole("operator")}>
                    <span class="mx-0.5 text-zinc-400">│</span>
                    <Show when={p.discovered} fallback={<IBtn danger title="注销项目" onClick={() => remove(p.id, p.name)}>⊖</IBtn>}>
                      <IBtn title="注册为项目" loading={isPending((t) => t.key === `compose:${p.id}`)} onClick={() => void register(p)}>⊕</IBtn>
                    </Show>
                    <IBtn
                      danger
                      title={available().down ? "docker compose down（停止并移除容器、网络）" : "没有已部署的容器可移除"}
                      disabled={!available().down}
                      loading={isRunning(p.id, "down")}
                      onClick={() => void down(p)}
                    >
                      <Ico path="M12 2v10M18.4 6.4a8 8 0 1 1-12.8 0" />
                    </IBtn>
                  </Show>
                </>
              );
              return (
                <div>
                  <div
                    class={`flex flex-col text-sm transition-colors sm:flex-row sm:items-start ${rowBg()} ${hasContainers() ? "cursor-pointer" : ""}`}
                    onClick={() => { if (hasContainers()) toggleExpand(p.id); }}
                  >
                    <div class="w-full px-3 py-2 sm:w-96 sm:shrink-0">
                      <div class="flex min-w-0 gap-2.5">
                        <ComposeIcon size={16} class="mt-0.5 shrink-0 text-indigo-400" />
                        <div class="min-w-0">
                          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <a
                              href={`/compose/${p.id}`}
                              class="border-b border-dashed border-indigo-400/60 font-medium text-indigo-400 transition-colors hover:border-indigo-300 hover:text-indigo-300"
                              onClick={(e) => { e.stopPropagation(); e.preventDefault(); navigate(`/compose/${p.id}`, { replace: true }); }}
                            >{p.name}</a>
                            <Show when={p.discovered}>
                              <span class="bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400" title="根据容器上的 compose 标签自动发现，非手动注册">自动发现</span>
                            </Show>
                            <span class={`text-xs sm:hidden ${statusColor() || "text-zinc-500"}`}>
                              {p.total ? `${p.running ?? 0}/${p.total} 运行中` : "未部署"}
                            </span>
                          </div>
                          <Show when={rep()}>
                            {(r) => <div class="mt-0.5 text-[11px] text-zinc-400 sm:hidden">{fmtContainerStatus(r().State, r().Status)}{" · 创建 "}{fmtRelTime(r().Created)}</div>}
                          </Show>
                          <div class="mt-1 hidden flex-wrap items-center gap-0.5 sm:flex">{actionButtons()}</div>
                        </div>
                      </div>
                    </div>
                    <div class="hidden w-32 shrink-0 px-3 py-2 text-xs sm:block">
                      <div class={statusColor() || "text-zinc-500"}>{p.total ? `${p.running ?? 0}/${p.total} 运行中` : "未部署"}</div>
                      <Show when={rep()}>
                        {(r) => <div class="mt-0.5 truncate text-[11px] text-zinc-400">{fmtContainerStatus(r().State, r().Status)}</div>}
                      </Show>
                    </div>
                    <div class="w-full min-w-0 border-t border-zinc-800/60 px-10 py-2 text-left sm:flex-1 sm:border-t-0 sm:px-3">
                      <div class="truncate font-mono text-[11px] text-zinc-400" title={p.compose_file}>{p.compose_file}</div>
                      <Show when={p.base_dir}>
                        <div class="mt-0.5 truncate font-mono text-[11px] text-zinc-500" title={p.base_dir}>目录：{p.base_dir}</div>
                      </Show>
                    </div>
                    <div class="flex flex-wrap items-center gap-0.5 border-t border-zinc-800/60 pl-10 pr-2 py-1.5 sm:hidden" onClick={(e) => e.stopPropagation()}>
                      {actionButtons()}
                    </div>
                  </div>
                  <Show when={hasContainers()}>
                    {/* Keep the open state animation, but make the child list part
                        of the project row instead of a second boxed surface. */}
                    <div
                      class="grid transition-[grid-template-rows] duration-200 ease-out"
                      style={{ "grid-template-rows": isOpen() ? "1fr" : "0fr" }}
                    >
                      <div class="overflow-hidden">
                        <div class="border-t border-zinc-800 bg-zinc-900/40 px-3 pb-3 pt-2 sm:px-4">
                          <div class="border-l-2 border-indigo-500/30 pl-3">
                            <div class="mb-1 flex items-center gap-2 text-[11px] text-zinc-500">
                              <span class="font-medium text-zinc-400">容器</span>
                              <span>{cs().length} 个</span>
                            </div>
                            <div class="divide-y divide-zinc-800/80">
                              <For each={cs()}>
                                {(c) => (
                                  <ContainerRow
                                    c={c}
                                    all={containers.items()}
                                    isP={isP}
                                    act={act}
                                    onViewCmd={setRunTarget}
                                    onConsole={setConsoleTarget}
                                  />
                                )}
                              </For>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
          <LoadMore when={view.hasMore()} onMore={view.loadMore} />
        </div>
        <Show when={view.filtered().length === 0 && !store.error()}>
          <div class="py-16 text-center text-zinc-400">
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
