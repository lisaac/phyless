import { Component, Show, For, createSignal, createResource, onCleanup } from "solid-js";
import { displayImage } from "../../api/inspect";
import { useNavigate } from "@solidjs/router";
import { hasRole } from "../../stores/auth";
import { IBtn, Ico } from "../shared/ActionButton";
import { Modal } from "../shared/Modal";
import { FileBrowser } from "../shared/FileBrowser";
import { DownloadStatusWidget } from "../shared/UploadStatusWidget";
import { createDownloadTask } from "../../api/download";
import { get, getToken } from "../../api/client";
import { containerName, STATE_DOT, fmtContainerStatus, fmtRelTime, midPath } from "./containerActions";
import type { ContainerSummary, FileEntry } from "../../types";

// SVG glyphs matching the image list's file/inspect buttons.
const FOLDER = "M3 7v13a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-9l-2-3H4a1 1 0 0 0-1 1z";
const SEARCH = "M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM21 21l-4.35-4.35";

// One容器 row, laid out with flex/div "cells" (not a real <table>) so it can
// be dropped anywhere — including inside ComposeListPage's expanded project
// section, which is itself a <div>, not a <table> that could host a <tr>.
// Column widths (w-44 / w-36 / flex-1 / w-48) mirror the table this
// replaced, so both call sites still line up the same four "columns".
export const ContainerRow: Component<{
  c: ContainerSummary;
  selected?: boolean;
  onToggleSelect?: () => void;
  isP: (id: string, verb: string) => boolean;
  act: (id: string, verb: string, name?: string) => void | Promise<unknown>;
  onViewCmd: (target: { id: string; name: string }) => void;
  onConsole?: (target: { id: string; name: string }) => void;
}> = (p) => {
  const navigate = useNavigate();
  const c = () => p.c;
  const name = () => containerName(c());
  // "restarting" is treated as running for action purposes — it's still an
  // up container mid-restart, not a stopped one, so it should offer
  // stop/pause/restart/kill rather than "启动" (which would be a no-op/error).
  const running = () => c().State === "running" || c().State === "restarting";
  const paused = () => c().State === "paused";

  const rowBg = () => {
    const s = c().State;
    if (s === "running") return "bg-emerald-500/[0.08] hover:bg-emerald-500/[0.13]";
    if (s === "paused") return "bg-amber-500/[0.04] hover:bg-amber-500/[0.08]";
    if (s === "restarting") return "bg-sky-500/[0.04] hover:bg-sky-500/[0.08]";
    if (s === "dead") return "bg-red-500/[0.05] hover:bg-red-500/[0.09]";
    return "hover:bg-white/[0.03]";
  };

  const pubPorts = () => {
    const seen = new Set<number>();
    return c().Ports.filter((port) => port.PublicPort && !seen.has(port.PublicPort) && seen.add(port.PublicPort));
  };
  const nets = () => Object.keys(c().NetworkSettings?.Networks ?? {}).join(", ");

  const goto = (path: string) => (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    navigate(path, { replace: true });
  };

  // inspect / file browsing are self-contained here (local modals) so every
  // ContainerRow call site — the container list, the compose list's expanded
  // section, and the compose detail page — gets them without each wiring up
  // its own modal + callback.
  const [showInspect, setShowInspect] = createSignal(false);
  const [showFiles, setShowFiles] = createSignal(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [inspectData] = createResource(() => (showInspect() ? c().Id : null), (id) => get<any>(`/api/containers/${id}/inspect`));
  const download = createDownloadTask();
  onCleanup(() => download.cancel());

  // Shared "view" buttons — visible to every role (read-only). Lifecycle and
  // delete stay operator-only in the branches below.
  const viewBtns = () => (
    <>
      <IBtn title="查看 Run/Compose 命令" onClick={() => p.onViewCmd({ id: c().Id, name: name() || c().Id.slice(0, 8) })}>⧉</IBtn>
      <IBtn title={running() ? "浏览文件" : "仅运行中的容器可浏览文件"} disabled={!running()} onClick={() => setShowFiles(true)}><Ico path={FOLDER} /></IBtn>
      <IBtn title="inspect" onClick={() => setShowInspect(true)}><Ico path={SEARCH} /></IBtn>
      <Show when={running() && p.onConsole}>
        <IBtn title="控制台" onClick={() => p.onConsole?.({ id: c().Id, name: name() || c().Id.slice(0, 8) })}>&gt;_</IBtn>
      </Show>
    </>
  );

  return (
    <div
      class={`flex flex-col text-sm transition-colors sm:flex-row ${rowBg()} ${p.selected ? "ring-1 ring-inset ring-indigo-500/60" : ""}`}
      onClick={() => p.onToggleSelect?.()}
    >
      {/* Container info + actions */}
      <div class="w-full px-3 py-2 sm:w-44 sm:shrink-0">
        <div class="flex items-center gap-1.5">
          <span class={`h-2 w-2 shrink-0 ${STATE_DOT[c().State] ?? "bg-zinc-600"}`} />
          <a
            class="max-w-[9rem] truncate border-b border-dashed border-zinc-600 font-medium text-zinc-200 transition-colors hover:border-indigo-400 hover:text-indigo-400"
            href={`/containers/${c().Id}`}
            title={name() || "(unnamed)"}
            onClick={goto(`/containers/${c().Id}`)}
          >
            {name() || <span class="text-zinc-400">(unnamed)</span>}
          </a>
        </div>
        <a
          class="mt-0.5 inline-block font-mono text-[11px] text-zinc-400 hover:text-indigo-400 hover:underline transition-colors"
          href={`/containers/${c().Id}`}
          onClick={goto(`/containers/${c().Id}`)}
        >{c().Id.slice(0, 12)}</a>
        <div class="max-w-[10rem] truncate text-[11px] text-zinc-400" title={c().Image}>{displayImage(c().Image, c().Labels)}</div>
        <div class="mt-0.5 text-[11px] text-zinc-400">
          {fmtContainerStatus(c().State, c().Status)}
          {" · 创建 "}{fmtRelTime(c().Created)}
        </div>
        <Show when={hasRole("operator")}>
          <div class="mt-1 flex items-center gap-0.5">
            <Show when={!running() && !paused()}>
              <IBtn title="启动" loading={p.isP(c().Id, "start")} onClick={() => void p.act(c().Id, "start", name())}>▶</IBtn>
            </Show>
            <Show when={paused()}>
              <IBtn title="恢复运行" loading={p.isP(c().Id, "unpause")} onClick={() => void p.act(c().Id, "unpause", name())}>▶</IBtn>
            </Show>
            <Show when={running()}>
              <IBtn title="停止" loading={p.isP(c().Id, "stop")} onClick={() => void p.act(c().Id, "stop", name())}>■</IBtn>
              <IBtn title="暂停" loading={p.isP(c().Id, "pause")} onClick={() => void p.act(c().Id, "pause", name())}>⏸</IBtn>
              <IBtn title="重启" loading={p.isP(c().Id, "restart")} onClick={() => void p.act(c().Id, "restart", name())}>↺</IBtn>
              <IBtn title="强制关闭 (SIGKILL)" loading={p.isP(c().Id, "kill")} onClick={() => void p.act(c().Id, "kill", name())} danger>✕</IBtn>
            </Show>

            <span class="mx-0.5 text-zinc-400">│</span>

            {viewBtns()}

            <Show when={!running()}>
              <span class="mx-0.5 text-zinc-400">│</span>
              <IBtn title="删除容器" danger loading={p.isP(c().Id, "delete")} onClick={() => { if (confirm(`删除容器 ${name() || c().Id.slice(0, 8)}？`)) void p.act(c().Id, "delete", name()); }}>⊖</IBtn>
            </Show>
          </div>
        </Show>
        <Show when={!hasRole("operator")}>
          <div class="mt-1 flex gap-0.5">
            {viewBtns()}
          </div>
        </Show>
      </div>

      {/* Network + Ports */}
      <div class="w-full border-t border-zinc-800/60 px-3 py-2 text-left sm:w-36 sm:shrink-0 sm:border-t-0 sm:text-center">
        <Show when={nets()}>
          <div class="truncate text-xs text-zinc-500 sm:mx-auto sm:max-w-[10rem]" title={nets()}>{nets()}</div>
        </Show>
        <Show when={pubPorts().length > 0}>
          <div class="mt-0.5 flex flex-wrap items-center justify-start gap-x-1.5 gap-y-0.5 sm:justify-center">
            <For each={pubPorts()}>
              {(port) => (
                <a
                  href={`http://${location.hostname}:${port.PublicPort}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="font-mono text-[11px] text-zinc-400 hover:text-emerald-400 transition-colors"
                  title={`打开 ${location.hostname}:${port.PublicPort}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  {port.PublicPort}→{port.PrivatePort}
                </a>
              )}
            </For>
          </div>
        </Show>
        <Show when={!nets() && pubPorts().length === 0}>
          <span class="text-xs text-zinc-500">—</span>
        </Show>
      </div>

      {/* Mounts — only linked to the file browser while the container is
          running, since browsing its filesystem is exec-based and has
          nothing to attach to once it's stopped. */}
      <div class="w-full min-w-0 border-t border-zinc-800/60 px-3 py-2 sm:flex-1 sm:border-t-0">
        <Show
          when={c().Mounts.length > 0}
          fallback={<span class="text-xs text-zinc-500">—</span>}
        >
          {/* self-start below: this container is flex-col, whose default
              align-items:stretch would otherwise stretch each row's
              hit/hover box to the full cell width — the link (and its
              hover highlight) must cover only the path text itself. */}
          <div class="flex flex-col gap-0.5">
            <For each={c().Mounts.slice(0, 4)}>
              {(m) => (
                <Show
                  when={running()}
                  fallback={
                    <span
                      class="flex w-fit shrink-0 items-center gap-0.5 self-start font-mono text-[11px] text-zinc-500"
                      title={`${m.Source} → ${m.Destination}${m.Mode?.includes("ro") ? " (只读)" : ""}`}
                    >
                      <span class="shrink-0">{midPath(m.Source || m.Name || "")}</span>
                      <span class="shrink-0 text-zinc-600">→</span>
                      <span class="shrink-0">{midPath(m.Destination)}</span>
                      <Show when={m.Mode?.includes("ro")}>
                        <span class="text-[9px] text-zinc-500">ro</span>
                      </Show>
                    </span>
                  }
                >
                  <a
                    href={`/containers/${c().Id}?tab=files&path=${encodeURIComponent(m.Destination)}`}
                    class="flex w-fit shrink-0 items-center gap-0.5 self-start font-mono text-[11px] text-zinc-400 hover:text-emerald-400 hover:underline transition-colors"
                    title={`${m.Source} → ${m.Destination}${m.Mode?.includes("ro") ? " (只读)" : ""}`}
                    onClick={goto(`/containers/${c().Id}?tab=files&path=${encodeURIComponent(m.Destination)}`)}
                  >
                    <span class="shrink-0">{midPath(m.Source || m.Name || "")}</span>
                    <span class="shrink-0 text-zinc-600">→</span>
                    <span class="shrink-0">{midPath(m.Destination)}</span>
                    <Show when={m.Mode?.includes("ro")}>
                      <span class="text-[9px] text-zinc-400">ro</span>
                    </Show>
                  </a>
                </Show>
              )}
            </For>
            <Show when={c().Mounts.length > 4}>
              <span class="text-[11px] text-zinc-400">+{c().Mounts.length - 4} 更多</span>
            </Show>
          </div>
        </Show>
      </div>

      {/* Command */}
      <div class="w-full border-t border-zinc-800/60 px-3 py-2 sm:w-48 sm:shrink-0 sm:border-t-0">
        <span class="line-clamp-3 break-all font-mono text-[11px] text-zinc-400" title={c().Command}>
          {c().Command || "—"}
        </span>
      </div>

      <Modal open={showInspect()} onClose={() => setShowInspect(false)} title={`Inspect · ${name() || c().Id.slice(0, 12)}`} wide>
        <Show when={!inspectData.loading} fallback={<p class="text-xs text-zinc-500">加载中…</p>}>
          <pre class="max-h-[70vh] overflow-auto bg-zinc-950 p-4 font-mono text-xs leading-5 text-zinc-400">
            {JSON.stringify(inspectData(), null, 2)}
          </pre>
        </Show>
      </Modal>

      <Modal open={showFiles()} onClose={() => setShowFiles(false)} title={`文件 · ${name() || c().Id.slice(0, 12)}`} wide>
        <FileBrowser
          instanceKey={c().Id}
          listPath={(sub) => get<FileEntry[]>(`/api/containers/${c().Id}/files?path=${encodeURIComponent(sub)}`)}
          onDownload={(sub, fname) => download.start(
            `/api/containers/${c().Id}/files/download?path=${encodeURIComponent(sub)}&token=${encodeURIComponent(getToken() ?? "")}`,
            `${fname}.tar`,
          )}
        />
      </Modal>
      <DownloadStatusWidget task={download} />
    </div>
  );
};

// Header row matching ContainerRow's column widths — used above the <For> in
// any list that renders ContainerRow, so labels line up with their column.
// Hidden below sm: the column labels only mean something once the row is
// actually laid out as columns; ContainerRow itself stacks into a single
// full-width block below that breakpoint, where the labels add nothing.
export const ContainerRowHeader: Component = () => (
  <div class="hidden border-b border-zinc-800 text-xs text-zinc-500 sm:flex">
    <div class="w-44 shrink-0 px-3 py-2">容器</div>
    <div class="w-36 shrink-0 px-3 py-2 text-center">网络 / 端口</div>
    <div class="min-w-0 flex-1 px-3 py-2">挂载</div>
    <div class="w-48 shrink-0 px-3 py-2">命令</div>
  </div>
);
