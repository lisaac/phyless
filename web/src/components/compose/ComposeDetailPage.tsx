import { Component, createSignal, createResource, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { useParams, useSearchParams } from "@solidjs/router";
import { get, put, getToken, setToken } from "../../api/client";
import { connectWS } from "../../api/ws";
import { createResourceStore } from "../../stores/resource";
import { setTabLabel } from "../../stores/tabs";
import { CodeEditor } from "../shared/CodeEditor";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { FileBrowser } from "../shared/FileBrowser";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import { composeToRuns } from "../../api/convert";
import { createContainerActions } from "../containers/containerActions";
import { ContainerRow } from "../containers/ContainerRow";
import { ViewCmdModal } from "../containers/ViewCmdModal";
import { ConsoleModal } from "../containers/ConsoleModal";
import { containersOf, representative, ActBtn, ComposeIcon, type ComposeVerb } from "./composeShared";
import type { ComposeProject, ContainerSummary, FileEntry } from "../../types";

type Tab = "info" | "yaml" | "files" | "logs";
const TABS: { key: Tab; label: string }[] = [
  { key: "info", label: "基本信息" },
  { key: "yaml", label: "compose.yaml" },
  { key: "files", label: "文件" },
  { key: "logs", label: "日志" },
];

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

  // ── compose.yaml editor ──────────────────────────────────────────────────
  const [yaml, setYaml] = createSignal("");
  createResource(id, async (i) => {
    const text = await get<string>(`/api/compose/file?id=${encodeURIComponent(i)}`);
    setYaml(text);
    return text;
  });
  const saveYaml = async () => {
    try { await put(`/api/compose/file?id=${encodeURIComponent(id())}`, yaml()); toast.success("已保存"); }
    catch (e) { toast.error((e as Error).message); }
  };
  const runs = () => { try { return composeToRuns(yaml()); } catch { return []; } };
  const [showConvert, setShowConvert] = createSignal(false);

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

  // ── logs tab — connects only while active, reconnects if the project id
  // changes underneath it (this page isn't remounted across /compose/:id) ──
  const [logOutput, setLogOutput] = createSignal("");
  let logWs: WebSocket | undefined;
  let logWsId: string | undefined;
  createEffect(() => {
    if (tab() !== "logs") { logWs?.close(); logWs = undefined; logWsId = undefined; return; }
    if (logWs && logWsId === id()) return;
    logWs?.close();
    logWsId = id();
    setLogOutput("");
    const dec = new TextDecoder();
    logWs = connectWS(`/ws/compose/logs?id=${encodeURIComponent(id())}`, {
      onMessage: (ev) => {
        const chunk = typeof ev.data === "string" ? ev.data : dec.decode(ev.data as ArrayBuffer);
        setLogOutput((o) => (o + chunk).slice(-100_000));
      },
    });
  });
  onCleanup(() => logWs?.close());

  // ── files tab — browse BaseDir on the left, edit the selected file on the
  // right (FileBrowser is already generic: listPath/onOpenFile callbacks) ──
  const [selectedFile, setSelectedFile] = createSignal<string | null>(null);
  const [fileContent, setFileContent] = createSignal("");
  const [savingFile, setSavingFile] = createSignal(false);
  createResource(selectedFile, async (p) => {
    if (!p) { setFileContent(""); return ""; }
    const text = await get<string>(`/api/compose/files/content?id=${encodeURIComponent(id())}&path=${encodeURIComponent(p)}`);
    setFileContent(text);
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
          <ActBtn title="docker compose stop" onClick={() => void runCmd("stop")}>■ Stop</ActBtn>
          <ActBtn title="docker compose down（停止并移除容器、网络）" onClick={() => void runCmd("down")}>⊘ Down</ActBtn>
          <ActBtn title="docker compose restart" onClick={() => void runCmd("restart")}>↺ Restart</ActBtn>
          <ActBtn title="docker compose pull" onClick={() => void runCmd("pull")}>↓ Pull</ActBtn>
          <span class="mx-0.5 text-zinc-600">│</span>
          <ActBtn title="查看转换出的 docker run 命令" onClick={() => setShowConvert(true)}>⧉ Run/Compose</ActBtn>
        </div>
      </Show>

      <Show when={output()}>
        <pre class="mb-3 max-h-40 overflow-auto whitespace-pre-wrap border border-zinc-800 bg-zinc-950 p-2 font-mono text-xs text-zinc-400">{output()}</pre>
      </Show>

      <div class="mb-3 flex gap-1 border-b border-zinc-800 text-sm">
        <For each={TABS}>
          {(t) => (
            <button
              class={`border-b-2 px-3 py-2 transition-colors ${
                tab() === t.key ? "border-indigo-500 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
              onClick={() => setTab(t.key)}
            >{t.label}</button>
          )}
        </For>
      </div>

      <Show when={tab() === "info"}>
        <div class="flex flex-col gap-4">
          <div class="grid grid-cols-[8rem_1fr] gap-y-1.5 text-sm">
            <div class="text-zinc-500">名称</div><div>{project()?.name}</div>
            <div class="text-zinc-500">目录</div><div class="font-mono text-xs">{project()?.base_dir}</div>
            <div class="text-zinc-500">Compose 文件</div><div class="font-mono text-xs">{project()?.compose_file}</div>
            <Show when={project()?.env_file}>
              <div class="text-zinc-500">Env 文件</div><div class="font-mono text-xs">{project()?.env_file}</div>
            </Show>
            <div class="text-zinc-500">来源</div><div>{project()?.discovered ? "自动发现" : "手动注册"}</div>
            <div class="text-zinc-500">运行状态</div>
            <div class={(project()?.running ?? 0) > 0 ? "text-emerald-400" : "text-zinc-400"}>
              {project()?.total ? `${project()?.running ?? 0}/${project()?.total} 运行中` : "未部署"}
              <Show when={rep()}>
                {(r) => <span class="ml-2 text-xs text-zinc-500">{r().Status}</span>}
              </Show>
            </div>
          </div>

          <Show when={detail()?.services && Object.keys(detail()!.services).length > 0}>
            <div>
              <div class="mb-1 text-xs text-zinc-500">服务</div>
              <div class="flex flex-wrap gap-1.5">
                <For each={Object.entries(detail()!.services as Record<string, { image?: string }>)}>
                  {([name, svc]) => (
                    <span class="rounded bg-zinc-800 px-2 py-1 font-mono text-xs" title={svc?.image ?? ""}>{name}</span>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <div>
            <div class="mb-1 text-xs text-zinc-500">容器</div>
            <div class="border border-zinc-800">
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

      <Show when={tab() === "yaml"}>
        <div class="flex flex-col">
          <div class="mb-1 flex items-center justify-between">
            <span class="text-sm text-zinc-400">compose.yaml</span>
            <Show when={hasRole("operator")}><Button onClick={saveYaml}>保存</Button></Show>
          </div>
          <div class="h-[60vh]"><CodeEditor value={yaml()} onChange={setYaml} language="yaml" /></div>
        </div>
      </Show>

      <Show when={tab() === "files"}>
        <div class="grid grid-cols-[18rem_1fr] gap-3">
          <div class="h-[60vh] overflow-auto border border-zinc-800 p-2">
            <FileBrowser
              listPath={(sub) => get<FileEntry[]>(`/api/compose/files?id=${encodeURIComponent(id())}&path=${encodeURIComponent(sub)}`)}
              onOpenFile={(p) => setSelectedFile(p)}
              instanceKey={id()}
            />
          </div>
          <div class="flex h-[60vh] flex-col">
            <div class="mb-1 flex items-center justify-between">
              <span class="truncate font-mono text-xs text-zinc-400">{selectedFile() ?? "未选择文件"}</span>
              <Show when={hasRole("operator") && selectedFile()}>
                <Button variant="primary" disabled={savingFile()} onClick={saveSelectedFile}>保存</Button>
              </Show>
            </div>
            <div class="min-h-0 flex-1">
              <Show when={selectedFile()} fallback={<div class="flex h-full items-center justify-center text-xs text-zinc-500">点击左侧文件开始编辑</div>}>
                <CodeEditor value={fileContent()} onChange={setFileContent} language={fileLang()} />
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <Show when={tab() === "logs"}>
        <pre class="h-[60vh] overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-3 font-mono text-xs">{logOutput()}</pre>
      </Show>

      <Modal open={showConvert()} onClose={() => setShowConvert(false)} title="docker run 集合" wide>
        <div class="space-y-2">
          <For each={runs()} fallback={<p class="text-sm text-zinc-400">无法转换或无服务</p>}>
            {(r) => (
              <div class="flex items-center gap-2">
                <code class="flex-1 overflow-auto rounded bg-zinc-950 p-2 text-xs">{r}</code>
                <Button onClick={() => navigator.clipboard.writeText(r)}>复制</Button>
              </div>
            )}
          </For>
        </div>
      </Modal>

      <ViewCmdModal target={runTarget()} onClose={() => setRunTarget(null)} />
      <ConsoleModal target={consoleTarget()} onClose={() => setConsoleTarget(null)} />
    </div>
  );
};
