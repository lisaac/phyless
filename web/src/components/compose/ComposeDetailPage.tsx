import { Component, createSignal, createResource, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { useParams, useSearchParams } from "@solidjs/router";
import { get, imageInspectUrl } from "../../api/client";
import { inspectToRunCmd } from "../../api/inspect";
import { looksTextFile, fetchTextFile } from "../../api/textFile";
import { streamDownload, fmtBytes } from "../../api/download";
import { createResourceStore } from "../../stores/resource";
import { canSaveFile, createLatestFileRequest } from "../../stores/latestFile";
import { setTabLabel } from "../../stores/tabs";
import { CodeEditor } from "../shared/CodeEditor";
import { Button } from "../shared/Button";
import { FileBrowser } from "../shared/FileBrowser";
import { LogsView } from "../shared/LogsView";
import { TimeRangePicker, appendTimeRange, type TimeRange } from "../shared/TimeRangePicker";
import { KV, Sec } from "../shared/KV";
import { Tabs } from "../shared/Tabs";
import { UploadStatusWidget } from "../shared/UploadStatusWidget";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import { createContainerActions } from "../containers/containerActions";
import { ContainerRow } from "../containers/ContainerRow";
import { ViewCmdModal } from "../containers/ViewCmdModal";
import { ConsoleModal } from "../containers/ConsoleModal";
import { CreateContainerModal } from "../containers/CreateContainerModal";
import { containersOf, representative, ActBtn, ComposeIcon, servicesHaveBuild, type ComposeVerb } from "./composeShared";
import { ComposeActionModal, isComposeRunning, requestComposeAction, type ComposeAction } from "./ComposeActionModal";
import { enqueue, queued } from "../../stores/taskQueue";
import type { ComposeProject, ContainerSummary, FileEntry } from "../../types";

type Tab = "info" | "inspect" | "files" | "logs";
const TABS: { key: Tab; label: string }[] = [
  { key: "info", label: "基本信息" },
  { key: "inspect", label: "Inspect" },
  { key: "files", label: "文件" },
  { key: "logs", label: "日志" },
];

const DEFAULT_RUN = "docker run -d --name my-container nginx:latest";

export const ComposeDetailPage: Component = () => {
  const params = useParams();
  const id = () => params.id;
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = () => (searchParams.tab as Tab) || "info";
  const setTab = (t: Tab) => setSearchParams({ tab: t }, { replace: true });

  const store = createResourceStore<ComposeProject>("/api/compose");
  const containers = createResourceStore<ContainerSummary>("/api/containers");
  const { isP, act } = createContainerActions();
  const project = () => store.items().find((p) => p.id === id());
  const cs = () => { const p = project(); return p ? containersOf(p, containers.items()) : []; };
  const rep = () => representative(cs());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [detail] = createResource(id, (i) => get<any>(`/api/compose/detail?id=${encodeURIComponent(i)}`));

  onMount(() => { store.startPolling(); containers.startPolling(); });
  onCleanup(() => { store.stopPolling(); containers.stopPolling(); });

  // Upgrade the tab strip's placeholder label to the real project name —
  // registered projects only have a numeric id, so without this the tab
  // would show e.g. "Compose 1" forever instead of the project's actual name.
  createEffect(() => {
    const p = project();
    if (p?.name) setTabLabel(`/compose/${id()}`, p.name);
  });

  // ── up/stop/down/restart/pull — shared with ComposeListPage via ComposeActionModal.
  const [composeTarget, setComposeTarget] = createSignal<ComposeAction | null>(null);
  const isRunning = (verb: ComposeVerb) => isComposeRunning(id(), verb);
  const request = (a: ComposeAction) => requestComposeAction(a, setComposeTarget);
  const [logRange, setLogRange] = createSignal<TimeRange>({});
  // Run/Compose reuses the same flow as the container list's own Run/Compose
  // button — feed CreateContainerModal the merged run commands and let its
  // single-vs-multi detection decide "创建容器" vs "注册 Compose", instead of
  // a separate read-only viewer.
  const [runText, setRunText] = createSignal<string | null>(null);
  const runProject = async () => {
    const ids = cs().map((c) => c.Id);
    if (ids.length === 0) { setRunText(DEFAULT_RUN); return; }
    const cmds = await Promise.all(ids.map(async (cid) => {
      const container = await get<any>(`/api/containers/${cid}/inspect`);
      let image: any = {};
      try { image = await get<any>(imageInspectUrl(container.Image)); } catch { /* ignore */ }
      return inspectToRunCmd(container, image);
    }));
    setRunText(cmds.join("\n\n"));
  };

  // ── files tab — browse BaseDir on the left, edit the selected file on the
  // right (FileBrowser is already generic: listPath/onOpenFile callbacks).
  // Defaults to the project's own compose file so it's ready to edit as soon
  // as the tab is opened, without an extra click. ──────────────────────────
  const composeRelPath = () => {
    const p = project();
    if (!p) return null;
    const rel = p.compose_file.startsWith(p.base_dir) ? p.compose_file.slice(p.base_dir.length) : p.compose_file;
    return rel.startsWith("/") ? rel : "/" + rel;
  };
  const [selectedFile, setSelectedFile] = createSignal<string | null>(null);
  const [fileContent, setFileContent] = createSignal("");
  const [fileTruncated, setFileTruncated] = createSignal(false);
  const [fileLoading, setFileLoading] = createSignal(false);
  const [fileLoadError, setFileLoadError] = createSignal("");
  const [loadedFile, setLoadedFile] = createSignal<{ id: string; path: string }>();
  const [savingFile, setSavingFile] = createSignal(false);

  // Create/delete/rename operate directly on the project's BaseDir on the
  // host filesystem (internal/api/compose.go's handleCompose{Delete,Rename}
  // File) — creating is just a PUT with empty content, same endpoint the
  // editor already saves through.
  const createFile = async (path: string) => {
    await queued(`新建 ${path}`, "PUT", `/api/compose/files/content?id=${encodeURIComponent(id())}&path=${encodeURIComponent(path)}`, "", { key: `compose:${id()}` });
  };
  const deleteFile = async (path: string) => {
    await queued(`删除 ${path}`, "DELETE", `/api/compose/files?id=${encodeURIComponent(id())}&path=${encodeURIComponent(path)}`, undefined, { key: `compose:${id()}` });
    if (selectedFile() === path) setSelectedFile(null);
  };
  const renameFile = async (oldPath: string, newPath: string) => {
    await queued(`重命名 ${oldPath}`, "POST", `/api/compose/files/rename?id=${encodeURIComponent(id())}`, { old_path: oldPath, new_path: newPath }, { key: `compose:${id()}` });
    if (selectedFile() === oldPath) setSelectedFile(newPath);
  };

  // Upload/download — same PUT-raw-bytes endpoint the editor saves through
  // for upload (XHR, since fetch() has no upload-progress events), and the
  // new tar-streaming endpoint for download (fetch + a reader loop, since
  // the exact tar size isn't known upfront to compute a percentage).
  const uploadFile = async (sub: string, file: File) => {
    const t = await enqueue({
      title: `上传 ${file.name}`,
      url: `/api/compose/files/content?id=${encodeURIComponent(id())}&path=${encodeURIComponent(sub.endsWith("/") ? sub + file.name : sub + "/" + file.name)}`,
      method: "PUT",
      file,
      key: `compose:${id()}`,
    }).done;
    if (t.status !== "done") throw new Error(t.error);
  };

  const [downloadState, setDownloadState] = createSignal({ active: false, filename: "", bytes: 0, done: false, error: "" });
  let downloadController: AbortController | undefined;
  let downloadGeneration = 0;
  const downloadFile = async (sub: string, name: string) => {
    downloadController?.abort();
    const generation = ++downloadGeneration;
    const controller = new AbortController();
    const filename = `${name}.tar`;
    downloadController = controller;
    setDownloadState({ active: true, filename, bytes: 0, done: false, error: "" });
    try {
      await streamDownload(
        `/api/compose/files/download?id=${encodeURIComponent(id())}&path=${encodeURIComponent(sub)}`,
        filename,
        (bytes) => setDownloadState((s) => ({ ...s, bytes })),
        controller.signal,
      );
      if (generation === downloadGeneration) setDownloadState((s) => ({ ...s, done: true }));
    } catch (e) {
      if (generation === downloadGeneration) setDownloadState((s) => ({ ...s, done: true, error: (e as Error).message }));
    } finally {
      if (downloadController === controller) downloadController = undefined;
    }
  };
  onCleanup(() => { downloadGeneration++; downloadController?.abort(); });

  // Auto-select the compose file once per project — guarded by an id marker
  // rather than "selectedFile() === null" so store polling (which changes
  // project()'s object identity every refresh) can't fight the user's own
  // navigation to a different file.
  let autoSelectedFor: string | undefined;
  createEffect(() => {
    const rel = composeRelPath();
    if (rel && autoSelectedFor !== id()) {
      autoSelectedFor = id();
      setSelectedFile(rel);
    }
  });

  const openFile = (path: string) => {
    if (!looksTextFile(path) && !confirm(`${path.split("/").pop()} 看起来不是文本文件，仍要打开？`)) return;
    setSelectedFile(path);
  };

  const fileRequest = createLatestFileRequest();
  createEffect(() => {
    const projectId = id();
    const path = selectedFile();
    const request = fileRequest.begin({ id: projectId, path: path ?? "" });
    setLoadedFile(undefined);
    setFileContent("");
    setFileTruncated(false);
    setFileLoadError("");
    setFileLoading(Boolean(path));
    if (!path) return;
    void (async () => {
      try {
        const result = await fetchTextFile(`/api/compose/files/content?id=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`, request.signal);
        if (!fileRequest.isCurrent(request)) return;
        if (!result) {
          setFileLoadError("未授权");
          return;
        }
        setFileContent(result.text);
        setFileTruncated(result.truncated);
        setLoadedFile(request.target);
      } catch (e) {
        if (fileRequest.isCurrent(request)) {
          setFileLoadError((e as Error).message);
          toast.error((e as Error).message);
        }
      } finally {
        if (fileRequest.isCurrent(request)) setFileLoading(false);
      }
    })();
  });
  onCleanup(fileRequest.cancel);

  const fileLang = () => {
    const p = selectedFile() ?? "";
    if (/\.ya?ml$/i.test(p)) return "yaml";
    if (/\.json$/i.test(p)) return "json";
    return "text";
  };

  const saveSelectedFile = async () => {
    const loaded = loadedFile();
    if (!loaded || !canSaveFile(loaded, { id: id(), path: selectedFile() ?? "" }, fileLoading(), fileLoadError(), fileTruncated())) {
      toast.error(fileLoading() ? "文件仍在加载" : fileTruncated() ? "文件过大，无法安全保存" : "文件加载失败，无法保存");
      return;
    }
    setSavingFile(true);
    try {
      await queued(`保存 ${loaded.path}`, "PUT", `/api/compose/files/content?id=${encodeURIComponent(loaded.id)}&path=${encodeURIComponent(loaded.path)}`, fileContent(), { key: `compose:${loaded.id}` });
      toast.success("已保存");
    } catch (e) { toast.error((e as Error).message); }
    finally { setSavingFile(false); }
  };

  const [runTarget, setRunTarget] = createSignal<{ id: string; name: string } | null>(null);
  const [consoleTarget, setConsoleTarget] = createSignal<{ id: string; name: string } | null>(null);

  return (
    <div>
      <h1 class="mb-3 flex items-center gap-2 text-xl font-semibold">
        <ComposeIcon size={20} />
        {project()?.name ?? id()}
      </h1>

      <Show when={hasRole("operator")}>
        <div class="mb-3 flex flex-wrap items-center gap-0.5 border border-zinc-800 bg-zinc-900/60 px-2 py-1.5">
          <ActBtn title="docker compose up -d" loading={isRunning("up")} onClick={() => request({ id: id(), name: project()?.name ?? id(), verb: "up" })}>▶ Up</ActBtn>
          <ActBtn title="docker compose restart" loading={isRunning("restart")} onClick={() => request({ id: id(), name: project()?.name ?? id(), verb: "restart" })}>↺ Restart</ActBtn>
          <ActBtn title="docker compose stop" loading={isRunning("stop")} onClick={() => request({ id: id(), name: project()?.name ?? id(), verb: "stop" })}>■ Stop</ActBtn>
          <ActBtn title="docker compose pause" loading={isRunning("pause")} onClick={() => request({ id: id(), name: project()?.name ?? id(), verb: "pause" })}>⏸ Pause</ActBtn>
          <ActBtn
            danger
            title="docker compose down（停止并移除容器、网络）"
            loading={isRunning("down")}
            onClick={() => { if (confirm(`停止并移除 ${project()?.name ?? id()} 的所有容器和网络？`)) request({ id: id(), name: project()?.name ?? id(), verb: "down" }); }}
          >⊘ Down</ActBtn>
          <ActBtn title="docker compose pull" loading={isRunning("pull")} onClick={() => request({ id: id(), name: project()?.name ?? id(), verb: "pull" })}>↓ Pull</ActBtn>
          <Show when={servicesHaveBuild(detail()?.services)}>
            <ActBtn title="docker compose build" loading={isRunning("build")} onClick={() => request({ id: id(), name: project()?.name ?? id(), verb: "build" })}>⚒︎ Build</ActBtn>
          </Show>
          <ActBtn
            title="更新：build（若有）→ pull → down → up"
            loading={isRunning("update")}
            onClick={() => request({ id: id(), name: project()?.name ?? id(), verb: "update", canBuild: servicesHaveBuild(detail()?.services) })}
          >⬆ Update</ActBtn>
          <span class="mx-0.5 text-zinc-600">│</span>
          <ActBtn title="基于项目下所有容器创建容器 / 注册 Compose" onClick={() => void runProject()}>⧉ Run/Compose</ActBtn>
        </div>
      </Show>

      <div class="mb-3">
        <Tabs tabs={TABS} active={tab()} onChange={setTab} />
      </div>

      <Show when={detail()?.load_error}>
        <div class="mb-3 border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          {detail()!.load_error}
        </div>
      </Show>

      <Show when={tab() === "info"}>
        <div class="flex flex-col gap-4">
          <div class="max-w-2xl">
            <dl class="space-y-0.5">
              <Sec noLine>标识</Sec>
              <KV k="名称">{project()?.name}</KV>
              <KV k="ID"><span class="select-all break-all">{id()}</span></KV>
              <KV k="来源">{project()?.discovered ? "自动发现" : "手动注册"}</KV>
              <KV k="目录"><span class="break-all">{project()?.base_dir}</span></KV>
              <KV k="Compose 文件"><span class="break-all">{project()?.compose_file}</span></KV>
              <Show when={project()?.env_file}>
                <KV k="Env 文件"><span class="break-all">{project()?.env_file}</span></KV>
              </Show>

              <Sec>状态</Sec>
              <KV k="运行状态">
                <span class={(project()?.running ?? 0) > 0 ? "text-emerald-400" : "text-zinc-400"}>
                  {project()?.total ? `${project()?.running ?? 0}/${project()?.total} 运行中` : "未部署"}
                </span>
              </KV>
              <Show when={rep()}>
                {(r) => <KV k="最近状态">{r().Status}</KV>}
              </Show>

              <Show when={detail()?.services && Object.keys(detail()!.services).length > 0}>
                <Sec>服务</Sec>
                <div class="space-y-px pb-1 font-mono text-xs">
                  <For each={Object.entries(detail()!.services as Record<string, { image?: string }>)}>
                    {([name, svc]) => (
                      <div class="flex gap-2">
                        <span class="text-zinc-200">{name}</span>
                        <Show when={svc?.image}><span class="text-zinc-500">{svc!.image}</span></Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </dl>
          </div>

          <div>
            <Sec noLine>容器</Sec>
            <div class="mt-1 border border-zinc-800">
              <Show when={cs().length > 0} fallback={<div class="px-3 py-3 text-xs text-zinc-500">无容器</div>}>
                <div class="divide-y divide-zinc-800">
                  <For each={cs()}>
                    {(c) => (
                      <ContainerRow c={c} isP={isP} act={act} onViewCmd={setRunTarget} onConsole={setConsoleTarget} />
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <Show when={tab() === "inspect"}>
        <Show when={!detail.loading} fallback={<p class="text-xs text-zinc-500">加载中…</p>}>
          <pre class="max-h-[calc(100vh-16rem)] overflow-auto bg-zinc-950 p-4 font-mono text-xs leading-5 text-zinc-400">
            {JSON.stringify(detail(), null, 2)}
          </pre>
        </Show>
      </Show>

      <Show when={tab() === "files"}>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div class="h-[calc(100vh-19rem)] overflow-auto border border-zinc-800 p-2">
            <FileBrowser
              listPath={(sub) => get<FileEntry[]>(`/api/compose/files?id=${encodeURIComponent(id())}&path=${encodeURIComponent(sub)}`)}
              onOpenFile={openFile}
              onCreate={hasRole("operator") ? createFile : undefined}
              onDelete={hasRole("operator") ? deleteFile : undefined}
              onRename={hasRole("operator") ? renameFile : undefined}
              onUpload={hasRole("operator") ? uploadFile : undefined}
              onDownload={downloadFile}
              instanceKey={id()}
            />
          </div>
          <div class="sticky top-4 flex h-[calc(100vh-19rem)] flex-col">
            <div class="mb-1 flex items-center justify-between">
              <span class="truncate font-mono text-xs text-zinc-400">{selectedFile() ?? "未选择文件"}</span>
              <Show when={hasRole("operator") && selectedFile()}>
                <Button
                  variant="primary"
                  disabled={savingFile() || !canSaveFile(loadedFile(), { id: id(), path: selectedFile() ?? "" }, fileLoading(), fileLoadError(), fileTruncated())}
                  title={fileTruncated() ? "文件过大，内容已被截断，无法安全保存" : fileLoading() ? "文件加载中" : fileLoadError() || undefined}
                  onClick={saveSelectedFile}
                >保存</Button>
              </Show>
            </div>
            <Show when={fileTruncated()}>
              <p class="mb-1 text-xs text-amber-400">文件过大，仅加载了前 2MB，已禁用保存以免截断覆盖原文件。</p>
            </Show>
            <Show when={fileLoading()}><p class="mb-1 text-xs text-zinc-500">文件加载中…</p></Show>
            <Show when={fileLoadError()}><p class="mb-1 text-xs text-red-400">{fileLoadError()}</p></Show>
            <div class="min-h-0 flex-1">
              <Show when={selectedFile()} fallback={<div class="flex h-full items-center justify-center text-xs text-zinc-500">点击左侧文件开始编辑</div>}>
                <CodeEditor value={fileContent()} onChange={setFileContent} language={fileLang()} />
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <Show when={tab() === "logs"}>
        <div class="mb-2"><TimeRangePicker onChange={setLogRange} /></div>
        <LogsView wsUrl={appendTimeRange(`/ws/compose/logs?id=${encodeURIComponent(id())}`, logRange())} />
      </Show>

      <CreateContainerModal
        open={runText() !== null}
        initialRun={runText() ?? undefined}
        onClose={() => setRunText(null)}
      />
      <ViewCmdModal target={runTarget()} onClose={() => setRunTarget(null)} />
      <ConsoleModal target={consoleTarget()} onClose={() => setConsoleTarget(null)} />

      <ComposeActionModal target={composeTarget()} onClose={() => setComposeTarget(null)} />

      <UploadStatusWidget
        active={downloadState().active}
        label="下载"
        filename={downloadState().filename}
        bytesLabel={fmtBytes(downloadState().bytes)}
        done={downloadState().done}
        error={downloadState().error}
        onClose={() => { downloadGeneration++; downloadController?.abort(); setDownloadState((s) => ({ ...s, active: false })); }}
      />
    </div>
  );
};
