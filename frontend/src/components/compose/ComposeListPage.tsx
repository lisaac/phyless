import { Component, createSignal, createResource, onMount, onCleanup, For, Show } from "solid-js";
import { createTabState } from "../../stores/tabs";
import { useNavigate } from "@solidjs/router";
import { createResourceStore } from "../../stores/resource";
import { Button, PageHeader } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { ComposeActionModal, isComposeRunning, requestComposeAction, startComposeAction, type ComposeAction } from "./ComposeActionModal";
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
import { ComposeSettingsModal } from "./ComposeSettingsModal";
import { createListView, SearchBox, LoadMore, SortHead, FilterChips, More, by, type ListFilter } from "../shared/ListView";
import { composeActionAvailability, composeProjectState, containersOf, representative, ComposeIcon, ComposeInfo, type ComposeProjectState } from "./composeShared";
import { Btn, IBtn, Ico } from "../shared/ActionButton";
import { confirmAction } from "../shared/ConfirmModal";
import type { ComposeProject, ContainerSummary } from "../../types";
import { JsonView } from "../shared/JsonView";

// Files-tab links for the Compose 文件 column; only files under base_dir are reachable there.
const fileLinkCls = "text-zinc-400 transition-colors hover:text-indigo-400 hover:underline";
const filesUrl = (id: string, rel?: string) => `/compose/${id}?tab=files${rel ? `&file=${encodeURIComponent(rel)}` : ""}`;
export const composeFileRel = (baseDir: string, file: string) => {
  const base = baseDir.replace(/\/+$/, "");
  return base && file.startsWith(base + "/") ? file.slice(base.length) : null;
};
// Lucide "hammer".
const BUILD_ICON = "m15 12-8.5 8.5c-.83.83-2.17.83-3 0a2.12 2.12 0 0 1 0-3L12 9M17.64 15 22 10.64M20.91 11.7l-1.25-1.25c-.6-.6-.93-1.4-.93-2.25v-.86L16.01 4.6a5.56 5.56 0 0 0-3.94-1.64H9l.92.82A6.18 6.18 0 0 1 12 8.4v1.56l2 2h2.47l2.26 1.91";
const DEFAULT_RUN = "docker run -d --name my-container nginx:latest";
const inState = (s: ComposeProjectState) => (p: ComposeProject) => composeProjectState(p) === s;
const STATUS_FILTERS: ListFilter<ComposeProject>[] = [
  { key: "running", label: "运行中", tone: "emerald", match: inState("running") },
  { key: "partial", label: "部分运行", tone: "sky", match: inState("partial") },
  { key: "stopped", label: "已停止", tone: "zinc", match: inState("stopped") },
  { key: "empty", label: "未部署", tone: "zinc", match: inState("empty") },
  { key: "discovered", label: "未注册", tone: "violet", group: "source", title: "筛选发现但尚未注册的项目", match: (p) => !!p.discovered },
];

export const ComposeListPage: Component = () => {
  const navigate = useNavigate();
  const store = createResourceStore<ComposeProject>("/api/compose", "id");
  const containers = createResourceStore<ContainerSummary>("/api/containers");
  const { isP, act } = createContainerActions();
  const view = createListView(store.items, (p) =>
    `${p.name} ${p.id} ${p.base_dir} ${p.compose_file} ${containersOf(p, containers.items())
      .map((c) => `${c.Names.join(" ")} ${c.Image}`).join(" ")}`, {
    rowHeight: 72,
    filters: STATUS_FILTERS,
    sort: {
      name: by((p) => p.name),
      // Ratio running/total; undeployed sorts below fully stopped.
      status: by((p) => (p.total ? (p.running ?? 0) / p.total : -1)),
      file: by((p) => p.compose_file),
    },
  });
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [expanded, setExpanded] = createTabState<Set<string>>("expanded", new Set());
  const [runTarget, setRunTarget] = createSignal<{ id: string; name: string } | null>(null);
  const [consoleTarget, setConsoleTarget] = createSignal<{ id: string; name: string } | null>(null);
  const [composeTarget, setComposeTarget] = createSignal<ComposeAction | null>(null);
  const isRunning = isComposeRunning;
  const request = (a: ComposeAction) => void requestComposeAction(a, setComposeTarget);
  // Run/Compose reuses the same flow as the container list's own Run/Compose
  // button: feed CreateContainerModal the merged run commands and let its
  // own single-vs-multi detection decide between "创建容器" and "注册
  // Compose", instead of a separate read-only viewer.
  const [runText, setRunText] = createSignal<string | null>(null);
  const [show, setShow] = createSignal(false);
  const [showSettings, setShowSettings] = createSignal(false);
  const [inspectFor, setInspectFor] = createSignal<ComposeProject | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [inspectData] = createResource(inspectFor, (p) => get<any>(`/api/compose/detail?id=${encodeURIComponent(p.id)}`));

  onMount(() => { store.startPolling(); containers.startPolling(); });
  onCleanup(() => { store.stopPolling(); containers.stopPolling(); });

  const toggle = (id: string) =>
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = (v: boolean) => setSelected(v ? new Set(view.filtered().map((p) => p.id)) : new Set<string>());
  const n = () => selected().size;
  const allSel = () => view.filtered().length > 0 && view.filtered().every((p) => selected().has(p.id));
  const picked = () => store.items().filter((p) => selected().has(p.id));

  // Bulk lifecycle: projects where the verb doesn't apply are skipped. Up runs
  // with default options (pull_policy missing) — per-project proxy/registry
  // options stay on the row's own ▶.
  const bulk = async (verb: "up" | "stop" | "pause" | "restart" | "down") => {
    const ps = picked().filter((p) => composeActionAvailability(p)[verb]);
    if (!ps.length) return;
    if (verb === "down" && !await confirmAction(
      `停止并移除选中的 ${ps.length} 个项目的所有容器和网络？${ps.some((p) => p.self) ? "\n其中包含 phyless 自身，执行后 phyless 将停止，需在主机上手动启动。" : ""}`,
      { title: "停止并移除 Compose", confirmText: "继续", danger: true },
    )) return;
    setSelected(new Set<string>());
    for (const p of ps) {
      const a: ComposeAction = { id: p.id, name: p.name, verb, self: p.self };
      if (verb === "up" || verb === "down") void startComposeAction(a);
      else request(a);
    }
  };
  const bulkRun = () => void runProject(picked().flatMap((p) => containersOf(p, containers.items()).map((c) => c.Id)));

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

  return (
    <div>
      <PageHeader title="Compose">
        <Show when={hasRole("admin")}>
          <Button onClick={() => setShowSettings(true)}>设置</Button>
        </Show>
        <Show when={hasRole("operator")}>
          <Button variant="primary" onClick={() => setShow(true)}>注册项目</Button>
        </Show>
      </PageHeader>
      <div class="mb-3">
        <SearchBox value={view.query()} onInput={view.setQuery} placeholder="搜索 Compose…" />
      </div>

      <div class="mb-3 flex flex-wrap items-center gap-1.5 border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs">
        <input type="checkbox" aria-label="全选项目" checked={allSel()} onChange={(e) => toggleAll(e.currentTarget.checked)} />
        <span class="min-w-[4rem] text-zinc-500">{n() > 0 ? `${n()} 已选` : "全选"}</span>
        <Show when={hasRole("operator")}>
          <span class="text-zinc-400">│</span>
          <Btn title="docker compose up -d（默认选项）" disabled={n() === 0} onClick={() => void bulk("up")}>▶ 启动</Btn>
          <Btn title="docker compose stop" disabled={n() === 0} onClick={() => void bulk("stop")}>■ 停止</Btn>
          <Btn title="docker compose pause" disabled={n() === 0} onClick={() => void bulk("pause")}>⏸ 暂停</Btn>
          <Btn title="docker compose restart" disabled={n() === 0} onClick={() => void bulk("restart")}>↺ 重启</Btn>
          <Btn title="docker compose down（停止并移除容器、网络）" danger disabled={n() === 0} onClick={() => void bulk("down")}>⏻ Down</Btn>
        </Show>
        <span class="text-zinc-400">│</span>
        <Btn title="基于选中项目的所有容器创建容器 / 注册 Compose" onClick={bulkRun}>
          <span class="inline-flex items-center gap-1"><ComposeIcon size={14} /> Run/Compose</span>
        </Btn>
        <span class="text-zinc-400">│</span>
        <FilterChips view={view} onChange={() => setSelected(new Set<string>())} />
        <Show when={n() > 0}>
          <button class="ml-auto text-zinc-400 hover:text-zinc-100" onClick={() => setSelected(new Set<string>())}>清除</button>
        </Show>
      </div>
      <Show when={store.error()}><p class="mb-2 text-sm text-red-400">{store.error()}</p></Show>

      <div class="overflow-x-auto border border-zinc-800">
        <div class="hidden border-b border-zinc-800 text-xs text-zinc-500 sm:flex">
          <SortHead view={view} k="name" class="w-96 shrink-0 px-3 py-2">项目</SortHead>
          <SortHead view={view} k="status" class="w-32 shrink-0 px-3 py-2">运行状态</SortHead>
          <SortHead view={view} k="file" class="min-w-0 flex-1 px-3 py-2">Compose 文件</SortHead>
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
              const fromDir = () => p.discovery_source === "directory";
              const rowBg = () => p.discovered
                ? fromDir() ? "bg-teal-500/[0.07] hover:bg-teal-500/[0.12]" : "bg-violet-500/[0.09] hover:bg-violet-500/[0.15]"
                : state() === "running"
                ? "bg-emerald-500/[0.08] hover:bg-emerald-500/[0.13]"
                : state() === "partial"
                  ? "bg-sky-500/[0.04] hover:bg-sky-500/[0.08]"
                  : state() === "empty"
                    ? "bg-slate-500/[0.06] hover:bg-slate-500/[0.11]"
                    : "hover:bg-white/[0.03]";
              // Clicking the running-status text expands the project's containers;
              // the rest of the row selects it.
              const statusText = () => (
                <Show when={hasContainers()} fallback={<span class={statusColor() || "text-zinc-500"}>{p.total ? `${p.running ?? 0}/${p.total} 运行中` : "未部署"}</span>}>
                  <button
                    class={`inline-flex items-center gap-1 border-b border-dashed border-current transition-opacity hover:opacity-80 ${statusColor() || "text-zinc-400"}`}
                    title={isOpen() ? "收起容器" : "展开容器"}
                    aria-expanded={isOpen()}
                    onClick={(e) => { e.stopPropagation(); toggleExpand(p.id); }}
                  >
                    <span class={`inline-block text-[9px] transition-transform ${isOpen() ? "rotate-90" : ""}`}>▶</span>
                    {p.total ? `${p.running ?? 0}/${p.total} 运行中` : "未部署"}
                  </button>
                </Show>
              );
              const actionButtons = () => (
                <>
                  <Show when={hasRole("operator")}>
                    <IBtn title={available().up ? "docker compose up -d" : "项目中的容器均已运行"} disabled={!available().up} loading={isRunning(p.id, "up")} onClick={() => request({ id: p.id, name: p.name, verb: "up" })}>▶</IBtn>
                    <IBtn title={available().pause ? "docker compose pause" : p.self ? "phyless 自身所在项目不能暂停" : "没有运行中的容器可暂停"} disabled={!available().pause} loading={isRunning(p.id, "pause")} onClick={() => request({ id: p.id, name: p.name, verb: "pause" })}>⏸</IBtn>
                    <IBtn title={available().restart ? "docker compose restart" : "没有运行中的容器可重启"} disabled={!available().restart} loading={isRunning(p.id, "restart")} onClick={() => request({ id: p.id, name: p.name, verb: "restart" })}>↺</IBtn>
                    <IBtn title={available().stop ? "docker compose stop" : "没有运行中的容器可停止"} disabled={!available().stop} loading={isRunning(p.id, "stop")} onClick={() => request({ id: p.id, name: p.name, verb: "stop", self: p.self })}>■</IBtn>
                    <span class="mx-0.5 text-zinc-400">│</span>
                    <IBtn title={p.can_build ? "Build：构建镜像并拉取其余镜像；不执行 down/up" : "Pull：拉取镜像；不执行 down/up"} loading={isRunning(p.id, "pull")} onClick={() => request({ id: p.id, name: p.name, verb: "pull", canBuild: p.can_build })}>
                      <Show when={p.can_build} fallback="↓"><Ico path={BUILD_ICON} /></Show>
                    </IBtn>
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
                      <IBtn title={p.discovery_source === "directory" ? "注册此目录中的 Compose YAML 文件；不会修改原文件" : "将容器发现的 Compose 项目注册到当前服务器；不会修改原文件"} loading={isPending((t) => t.key === `compose:${p.id}`)} onClick={() => void register(p)}>⊕</IBtn>
                    </Show>
                    <IBtn
                      danger
                      title={available().down ? "docker compose down（停止并移除容器、网络）" : "没有已部署的容器可移除"}
                      disabled={!available().down}
                      loading={isRunning(p.id, "down")}
                      onClick={() => request({ id: p.id, name: p.name, verb: "down", self: p.self })}
                    >
                      <Ico path="M12 2v10M18.4 6.4a8 8 0 1 1-12.8 0" />
                    </IBtn>
                  </Show>
                </>
              );
              return (
                <div>
                  <div
                    class={`flex flex-col text-sm transition-colors sm:flex-row sm:items-start ${rowBg()} ${selected().has(p.id) ? "ring-1 ring-inset ring-indigo-500/60" : ""}`}
                    onClick={() => toggle(p.id)}
                  >
                    <div class="w-full px-3 py-2 sm:w-96 sm:shrink-0">
                      <div class="flex min-w-0 gap-2.5">
                        <ComposeIcon size={16} class="mt-0.5 shrink-0 text-indigo-400" />
                        <div class="min-w-0">
                          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <a
                              href={`/compose/${p.id}`}
                              class="break-all border-b border-dashed border-indigo-400/60 font-medium text-indigo-400 transition-colors hover:border-indigo-300 hover:text-indigo-300"
                              onClick={(e) => { e.stopPropagation(); e.preventDefault(); navigate(`/compose/${p.id}`, { replace: true }); }}
                            >{p.name}</a>
                            <Show when={p.discovered}>
                              <Show when={fromDir()} fallback={
                                <span class="border border-violet-500/40 bg-violet-500/15 px-1.5 py-0.5 text-[10px] text-violet-300" title="根据运行中 Docker 容器的 Compose 标签发现；尚未手动注册，点击加号可注册">运行中发现</span>
                              }>
                                <span class="border border-dashed border-teal-500/50 px-1.5 py-0.5 text-[10px] text-teal-400" title="在 Compose 设置的搜索目录中发现 YAML 文件；尚未部署或注册，点击加号可注册">目录中发现</span>
                              </Show>
                            </Show>
                            <Show when={p.can_build}>
                              <span class="bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-400" title="Compose 文件中有服务声明了 build">build</span>
                            </Show>
                            <span class="text-xs sm:hidden">{statusText()}</span>
                          </div>
                          <Show when={rep()}>
                            {(r) => <div class="mt-0.5 text-[11px] text-zinc-400 sm:hidden">{fmtContainerStatus(r().State, r().Status)}{" · 创建 "}{fmtRelTime(r().Created)}</div>}
                          </Show>
                          <div class="mt-1 hidden flex-wrap items-center gap-0.5 sm:flex">{actionButtons()}</div>
                        </div>
                      </div>
                    </div>
                    <div class="hidden w-32 shrink-0 px-3 py-2 text-xs sm:block">
                      <div>{statusText()}</div>
                      <Show when={rep()}>
                        {(r) => <div class="mt-0.5 truncate text-[11px] text-zinc-400">{fmtContainerStatus(r().State, r().Status)}</div>}
                      </Show>
                    </div>
                    <div class="w-full min-w-0 border-t border-zinc-800/60 px-10 py-2 text-left sm:flex-1 sm:border-t-0 sm:px-3">
                      <More each={p.compose_file.split(",").filter(Boolean)} max={2} class="flex flex-col">
                        {(file) => {
                          const rel = composeFileRel(p.base_dir, file);
                          return (
                            <Show when={rel} fallback={<div class="truncate font-mono text-[11px] text-zinc-400" title={file}>{file}</div>}>
                              <a href={filesUrl(p.id, rel!)} class={`block truncate font-mono text-[11px] ${fileLinkCls}`} title={`在文件页打开 ${file}`}
                                onClick={(e) => { e.stopPropagation(); e.preventDefault(); navigate(filesUrl(p.id, rel!), { replace: true }); }}>{file}</a>
                            </Show>
                          );
                        }}
                      </More>
                      <Show when={p.base_dir}>
                        <div class="mt-0.5 truncate font-mono text-[11px] text-zinc-500">
                          目录：<a href={filesUrl(p.id)} class={fileLinkCls} title={`浏览 ${p.base_dir}`}
                            onClick={(e) => { e.stopPropagation(); e.preventDefault(); navigate(filesUrl(p.id), { replace: true }); }}>{p.base_dir}</a>
                        </div>
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

      <ComposeSettingsModal
        open={showSettings()}
        onClose={() => setShowSettings(false)}
        onSaved={() => { setShowSettings(false); void store.refresh(); }}
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
          <ComposeInfo data={inspectData()} containers={inspectFor() ? containersOf(inspectFor()!, containers.items()) : []} />
          <JsonView data={inspectData()} />
        </Show>
      </Modal>
    </div>
  );
};
