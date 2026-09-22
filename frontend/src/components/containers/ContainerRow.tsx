import { Component, Show, For, createSignal, createResource, onCleanup } from "solid-js";
import { displayImage } from "../../api/inspect";
import { useNavigate } from "@solidjs/router";
import { hasRole } from "../../stores/auth";
import { IBtn, Ico } from "../shared/ActionButton";
import { ComposeIcon } from "../compose/composeShared";
import { Modal } from "../shared/Modal";
import { confirmAction } from "../shared/ConfirmModal";
import { FileBrowser } from "../shared/FileBrowser";
import { DownloadStatusWidget } from "../shared/UploadStatusWidget";
import { createDownloadTask } from "../../api/download";
import { get, getToken } from "../../api/client";
import { updateCheckFor, isUpgradable } from "../../stores/updateCheck";
import { UpdateBadge } from "./UpdateBadge";
import { toUpgradeTarget, type UpgradeTarget } from "./UpgradeContainerModal";
import { containerName, findContainer, STATE_DOT, fmtContainerStatus, fmtRelTime, midPath } from "./containerActions";
import type { ContainerSummary, FileEntry } from "../../types";

// One容器 row, laid out with flex/div "cells" (not a real <table>) so it can
// be dropped anywhere — including inside ComposeListPage's expanded project
// section, which is itself a <div>, not a <table> that could host a <tr>.
// Column widths (w-52 / w-36 / flex-1 / w-48) mirror the table this
// replaced, so both call sites still line up the same four "columns".
export const ContainerRow: Component<{
  c: ContainerSummary;
  /** Every container, to name a `container:<id>` network target without an inspect. */
  all: readonly ContainerSummary[];
  selected?: boolean;
  onToggleSelect?: () => void;
  isP: (id: string, verb: string) => boolean;
  act: (id: string, verb: string, name?: string) => void | Promise<unknown>;
  onViewCmd: (target: { id: string; name: string }) => void;
  onConsole?: (target: { id: string; name: string }) => void;
  onUpgrade?: (target: UpgradeTarget) => void;
}> = (p) => {
  const navigate = useNavigate();
  const c = () => p.c;
  const name = () => containerName(c());
  // "restarting" is treated as running for action purposes — it's still an
  // up container mid-restart, not a stopped one, so it should offer
  // stop/pause/restart/kill rather than "启动" (which would be a no-op/error).
  const running = () => c().State === "running" || c().State === "restarting";
  const paused = () => c().State === "paused";
  const browsable = () => c().State !== "removing";
  const update = () => updateCheckFor(c().Id, c().ImageID);

  const rowBg = () => {
    const s = c().State;
    if (s === "running") return "bg-emerald-500/[0.08] hover:bg-emerald-500/[0.13]";
    if (s === "paused") return "bg-amber-500/[0.04] hover:bg-amber-500/[0.08]";
    if (s === "restarting") return "bg-sky-500/[0.04] hover:bg-sky-500/[0.08]";
    if (s === "exited" || s === "created") return "bg-slate-500/[0.06] hover:bg-slate-500/[0.11]";
    if (s === "dead") return "bg-red-500/[0.05] hover:bg-red-500/[0.09]";
    return "hover:bg-white/[0.03]";
  };

  const pubPorts = () => {
    const seen = new Set<number>();
    return c().Ports.filter((port) => port.PublicPort && !seen.has(port.PublicPort) && seen.add(port.PublicPort));
  };
  const networkContainer = () => c() as ContainerSummary & {
    HostConfig?: { NetworkMode?: string };
    NetworkSettings?: {
      Networks: Record<string, { IPAddress?: string; GlobalIPv6Address?: string }>;
    };
  };
  const sharedNetTarget = () => {
    const mode = networkContainer().HostConfig?.NetworkMode ?? "";
    return mode.startsWith("container:") ? mode.slice("container:".length) : "";
  };
  const netName = () => {
    const target = sharedNetTarget();
    const hit = target && findContainer(p.all, target);
    return hit ? containerName(hit) : target.slice(0, 12);
  };
  const networkRows = () => {
    const container = networkContainer();
    const rows = Object.entries(container.NetworkSettings?.Networks ?? {}).map(([name, endpoint]) => ({
      name,
      ips: [endpoint.IPAddress, endpoint.GlobalIPv6Address].filter((ip): ip is string => Boolean(ip)),
      target: undefined as string | undefined,
    }));
    const mode = container.HostConfig?.NetworkMode ?? "";
    if (mode.startsWith("container:")) {
      return [{
        name: `container:${netName()}`,
        target: sharedNetTarget(),
        ips: [],
      }, ...rows];
    }
    return rows.length > 0 || !mode ? rows : [{ name: mode, target: undefined, ips: [] }];
  };

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
  const [browsePath, setBrowsePath] = createSignal<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [inspectData] = createResource(() => (showInspect() ? c().Id : null), (id) => get<any>(`/api/containers/${id}/inspect`));
  const download = createDownloadTask();
  onCleanup(() => download.cancel());
  const remove = async () => {
    if (await confirmAction(`删除容器 ${name() || c().Id.slice(0, 8)}？`, { title: "删除容器", confirmText: "删除", danger: true })) {
      void p.act(c().Id, "delete", name());
    }
  };

  // Shared "view" buttons — visible to every role (read-only). Lifecycle and
  // delete stay operator-only in the branches below.
  const viewBtns = () => (
    <>
      <IBtn title="查看 Run/Compose 命令" onClick={() => p.onViewCmd({ id: c().Id, name: name() || c().Id.slice(0, 8) })}><ComposeIcon size={14} /></IBtn>
      <IBtn title="inspect" onClick={() => setShowInspect(true)}><Ico path="M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM21 21l-4.35-4.35" /></IBtn>
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
      <div class="w-full px-3 py-2 sm:w-52 sm:shrink-0">
        <div class="flex items-center gap-1.5">
          <span class={`h-2 w-2 shrink-0 ${STATE_DOT[c().State] ?? "bg-zinc-600"}`} />
          <a
            class="max-w-[9rem] truncate border-b border-dashed border-zinc-600 font-medium text-zinc-200 transition-colors hover:border-indigo-400 hover:text-indigo-400"
            href={`/containers/${c().Id}`}
            title={`容器：${name() || "(unnamed)"}\n容器 ID：${c().Id}`}
            onClick={goto(`/containers/${c().Id}`)}
          >
            {name() || <span class="text-zinc-400">(unnamed)</span>}
          </a>
        </div>
        <div class="flex max-w-[12rem] items-center gap-1">
          <span class="min-w-0 truncate text-[11px] text-zinc-400" title={c().Image}>{displayImage(c().Image, c().Labels)}</span>
          <UpdateBadge check={update()} />
        </div>
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
            </Show>

            <Show when={p.onUpgrade}>
              <IBtn
                title={isUpgradable(update()) ? "有新镜像：升级（拉取镜像并替换容器）" : "升级（拉取镜像并替换容器）"}
                accent={isUpgradable(update())}
                onClick={() => p.onUpgrade?.(toUpgradeTarget(c()))}
              >↑</IBtn>
            </Show>

            <span class="mx-0.5 text-zinc-400">│</span>

            {viewBtns()}

            <Show when={!running()}>
              <span class="mx-0.5 text-zinc-400">│</span>
              <IBtn title="删除容器" danger loading={p.isP(c().Id, "delete")} onClick={() => void remove()}>⊖</IBtn>
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
        <Show when={networkRows().length > 0}>
          <div class="space-y-px sm:mx-auto sm:max-w-[10rem]">
            <For each={networkRows()}>
              {(network) => (
                <div class="min-w-0 text-xs leading-4" title={`${network.name}${network.ips.length ? `: ${network.ips.join(", ")}` : ""}`}>
                  <Show
                    when={network.target}
                    fallback={<div class="truncate text-zinc-500">{network.name}</div>}
                  >
                    {(target) => (
                      <a
                        class="block break-all text-zinc-400 hover:text-indigo-400 hover:underline transition-colors"
                        href={`/containers/${encodeURIComponent(target())}`}
                        title={`查看共享网络容器 ${netName() || target()}`}
                        onClick={goto(`/containers/${encodeURIComponent(target())}`)}
                      >
                        {network.name}
                      </a>
                    )}
                  </Show>
                  <Show when={network.ips.length > 0}>
                    <div class="truncate font-mono text-[11px] text-zinc-400">{network.ips.join(", ")}</div>
                  </Show>
                </div>
              )}
            </For>
          </div>
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
        <Show when={networkRows().length === 0 && pubPorts().length === 0}>
          <span class="text-xs text-zinc-500">—</span>
        </Show>
      </div>

      {/* Mount paths open the file browser at that path. With no mounts, the
          dash opens the container root. Stopped containers use an API snapshot. */}
      <div class="w-full min-w-0 border-t border-zinc-800/60 px-3 py-2 sm:flex-1 sm:border-t-0">
        <Show
          when={c().Mounts.length > 0}
          fallback={
            <Show when={browsable()} fallback={<span class="text-xs text-zinc-500">—</span>}>
              <a
                href="#"
                class="text-xs text-zinc-500 hover:text-emerald-400 hover:underline transition-colors"
                title="从根目录浏览文件"
                onClick={(e) => { e.stopPropagation(); e.preventDefault(); setBrowsePath("/"); }}
              >—</a>
            </Show>
          }
        >
          {/* self-start below: this container is flex-col, whose default
              align-items:stretch would otherwise stretch each row's
              hit/hover box to the full cell width — the link (and its
              hover highlight) must cover only the path text itself. */}
          <div class="flex flex-col gap-0.5">
            <For each={c().Mounts.slice(0, 4)}>
              {(m) => (
                <Show
                  when={browsable()}
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
                    href="#"
                    class="flex w-fit shrink-0 items-center gap-0.5 self-start font-mono text-[11px] text-zinc-400 hover:text-emerald-400 hover:underline transition-colors"
                    title={`${m.Source} → ${m.Destination}${m.Mode?.includes("ro") ? " (只读)" : ""}`}
                    onClick={(e) => { e.stopPropagation(); e.preventDefault(); setBrowsePath(m.Destination || "/"); }}
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

      <Modal open={browsePath() !== null} onClose={() => setBrowsePath(null)} title={`文件 · ${name() || c().Id.slice(0, 12)}`} wide>
        <FileBrowser
          instanceKey={c().Id}
          initialPath={browsePath() ?? "/"}
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
    <div class="w-52 shrink-0 px-3 py-2">容器</div>
    <div class="w-36 shrink-0 px-3 py-2 text-center">网络 / 端口</div>
    <div class="min-w-0 flex-1 px-3 py-2">挂载</div>
    <div class="w-48 shrink-0 px-3 py-2">命令</div>
  </div>
);
