import { Component, createSignal, createResource, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { useParams, useSearchParams } from "@solidjs/router";
import { get, put, getToken, setToken, imageInspectUrl } from "../../api/client";
import { inspectToRunCmd } from "../../api/inspect";
import { createResourceStore } from "../../stores/resource";
import { setTabLabel } from "../../stores/tabs";
import { CodeEditor } from "../shared/CodeEditor";
import { Button } from "../shared/Button";
import { FileBrowser } from "../shared/FileBrowser";
import { LogsView } from "../shared/LogsView";
import { KV, Sec } from "../shared/KV";
import { Tabs } from "../shared/Tabs";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import { createContainerActions } from "../containers/containerActions";
import { ContainerRow } from "../containers/ContainerRow";
import { ViewCmdModal } from "../containers/ViewCmdModal";
import { ConsoleModal } from "../containers/ConsoleModal";
import { BulkRunModal } from "../containers/BulkRunModal";
import { containersOf, representative, ActBtn, ComposeIcon, type ComposeVerb } from "./composeShared";
import type { ComposeProject, ContainerSummary, FileEntry } from "../../types";

type Tab = "info" | "files" | "logs";
const TABS: { key: Tab; label: string }[] = [
  { key: "info", label: "基本信息" },
  { key: "files", label: "文件" },
  { key: "logs", label: "日志" },
];

// Extensions the CodeEditor/browser can render safely as text. Anything else
// (images, archives, binaries…) gets a confirm() first — the editor loads
// content via res.text(), which silently mangles non-UTF8 bytes instead of
// erroring, so a binary file would otherwise open looking "fine" and then
// corrupt on save.
const TEXT_EXT = /\.(ya?ml|json|env|txt|md|conf|cfg|ini|sh|bash|zsh|py|js|ts|jsx|tsx|go|rb|toml|properties|gitignore|dockerignore|lock|xml|html?|css|sql)$/i;
const KNOWN_TEXT_NAMES = /^(dockerfile|makefile|readme|license)$/i;
function looksTextFile(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  if (KNOWN_TEXT_NAMES.test(name)) return true;
  if (!name.includes(".")) return true; // extensionless files are usually scripts/config
  return TEXT_EXT.test(name);
}

export const ComposeDetailPage: Component = () => {
  const params = useParams();
  const id = () => params.id;
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = () => (searchParams.tab as Tab) || "info";
  const setTab = (t: Tab) => setSearchParams({ tab: t }, { replace: true });

  const store = createResourceStore<ComposeProject>("/api/compose");
  const containers = createResourceStore<ContainerSummary>("/api/containers");
  const { isP, act } = createContainerActions(containers.refresh);
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

  // ── up/stop/down/restart/pull — output shown regardless of active tab ───
  const [output, setOutput] = createSignal("");
  const runCmd = async (verb: ComposeVerb) => {
    try {
      setOutput("");
      const res = await fetch(`/api/compose/${verb}?id=${encodeURIComponent(id())}`, {
        method: "POST", headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (res.status === 401) { setToken(null); window.dispatchEvent(new CustomEvent("phyless:unauthorized")); return; }
      const reader = res.body?.getReader();
      if (!reader) return;
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            setOutput((o) => o + (evt.stream ?? evt.error ?? "") + "\n");
          } catch { /* ignore malformed line */ }
        }
      }
    } catch (e) { toast.error((e as Error).message); }
    finally { void store.refresh(); void containers.refresh(); }
  };
  const [showRun, setShowRun] = createSignal(false);

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
  const [savingFile, setSavingFile] = createSignal(false);

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

  createResource(selectedFile, async (p) => {
    if (!p) { setFileContent(""); setFileTruncated(false); return ""; }
    const res = await fetch(`/api/compose/files/content?id=${encodeURIComponent(id())}&path=${encodeURIComponent(p)}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (res.status === 401) { setToken(null); window.dispatchEvent(new CustomEvent("phyless:unauthorized")); return ""; }
    if (!res.ok) { toast.error(await res.text()); return ""; }
    const text = await res.text();
    setFileContent(text);
    setFileTruncated(res.headers.get("X-Truncated") === "true");
    return text;
  });

  const fileLang = () => {
    const p = selectedFile() ?? "";
    if (/\.ya?ml$/i.test(p)) return "yaml";
    if (/\.json$/i.test(p)) return "json";
    return "text";
  };

  const saveSelectedFile = async () => {
    const p = selectedFile();
    if (!p) return;
    setSavingFile(true);
    try {
      await put(`/api/compose/files/content?id=${encodeURIComponent(id())}&path=${encodeURIComponent(p)}`, fileContent());
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
          <ActBtn title="docker compose up -d" onClick={() => void runCmd("up")}>▶ Up</ActBtn>
          <ActBtn title="docker compose restart" onClick={() => void runCmd("restart")}>↺ Restart</ActBtn>
          <ActBtn title="docker compose stop" onClick={() => void runCmd("stop")}>■ Stop</ActBtn>
          <ActBtn
            danger
            title="docker compose down（停止并移除容器、网络）"
            onClick={() => { if (confirm(`停止并移除 ${project()?.name ?? id()} 的所有容器和网络？`)) void runCmd("down"); }}
          >⊘ Down</ActBtn>
          <ActBtn title="docker compose pull" onClick={() => void runCmd("pull")}>↓ Pull</ActBtn>
          <span class="mx-0.5 text-zinc-600">│</span>
          <ActBtn title="查看 docker run 命令（inspect 项目下所有容器）" onClick={() => setShowRun(true)}>⧉ Run/Compose</ActBtn>
        </div>
      </Show>

      <Show when={output()}>
        <pre class="mb-3 max-h-40 overflow-auto whitespace-pre-wrap border border-zinc-800 bg-zinc-950 p-2 font-mono text-xs text-zinc-400">{output()}</pre>
      </Show>

      <div class="mb-3">
        <Tabs tabs={TABS} active={tab()} onChange={setTab} />
      </div>

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

      <Show when={tab() === "files"}>
        <div class="grid grid-cols-2 gap-3">
          <div class="h-[60vh] overflow-auto border border-zinc-800 p-2">
            <FileBrowser
              listPath={(sub) => get<FileEntry[]>(`/api/compose/files?id=${encodeURIComponent(id())}&path=${encodeURIComponent(sub)}`)}
              onOpenFile={openFile}
              instanceKey={id()}
            />
          </div>
          <div class="flex h-[60vh] flex-col">
            <div class="mb-1 flex items-center justify-between">
              <span class="truncate font-mono text-xs text-zinc-400">{selectedFile() ?? "未选择文件"}</span>
              <Show when={hasRole("operator") && selectedFile()}>
                <Button
                  variant="primary"
                  disabled={savingFile() || fileTruncated()}
                  title={fileTruncated() ? "文件过大，内容已被截断，无法安全保存" : undefined}
                  onClick={saveSelectedFile}
                >保存</Button>
              </Show>
            </div>
            <Show when={fileTruncated()}>
              <p class="mb-1 text-xs text-amber-400">文件过大，仅加载了前 2MB，已禁用保存以免截断覆盖原文件。</p>
            </Show>
            <div class="min-h-0 flex-1">
              <Show when={selectedFile()} fallback={<div class="flex h-full items-center justify-center text-xs text-zinc-500">点击左侧文件开始编辑</div>}>
                <CodeEditor value={fileContent()} onChange={setFileContent} language={fileLang()} />
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <Show when={tab() === "logs"}>
        <LogsView wsUrl={`/ws/compose/logs?id=${encodeURIComponent(id())}`} />
      </Show>

      <Show when={showRun()}>
        <BulkRunModal
          reqKey={id()}
          title={project()?.name ?? id()}
          fetchCmds={() => Promise.all(cs().map(async (c) => {
            const container = await get<any>(`/api/containers/${c.Id}/inspect`);
            let image: any = {};
            try { image = await get<any>(imageInspectUrl(container.Image)); } catch { /* ignore */ }
            return inspectToRunCmd(container, image);
          }))}
          onClose={() => setShowRun(false)}
        />
      </Show>
      <ViewCmdModal target={runTarget()} onClose={() => setRunTarget(null)} />
      <ConsoleModal target={consoleTarget()} onClose={() => setConsoleTarget(null)} />
    </div>
  );
};
