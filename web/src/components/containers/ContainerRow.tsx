import { Component, JSX, Show, For } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { hasRole } from "../../stores/auth";
import { containerName, STATE_DOT, fmtContainerStatus, fmtRelTime, midPath } from "./containerActions";
import type { ContainerSummary } from "../../types";

// Shared semantic palette for per-row action buttons — exported so
// ComposeListPage's own action buttons (Up/Stop/Down/Restart/Pull) use the
// same colors for the same kind of action instead of inventing a second set.
export type BtnVariant = "default" | "danger" | "success" | "warning" | "info";
export const VARIANT_STYLE: Record<BtnVariant, string> = {
  default: "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100",
  danger:  "text-zinc-500 hover:bg-red-900/40 hover:text-red-400",
  success: "text-zinc-500 hover:bg-emerald-900/40 hover:text-emerald-400",
  warning: "text-zinc-500 hover:bg-amber-900/40 hover:text-amber-400",
  info:    "text-zinc-500 hover:bg-sky-900/40 hover:text-sky-400",
};

const IBtn = (p: {
  title: string; onClick: () => void;
  loading?: boolean; disabled?: boolean; variant?: BtnVariant; children: JSX.Element;
}) => (
  <button
    title={p.title}
    disabled={p.loading || p.disabled}
    onClick={(e) => { e.stopPropagation(); p.onClick(); }}
    class={`inline-flex h-6 w-6 items-center justify-center transition-colors disabled:opacity-30 ${VARIANT_STYLE[p.variant ?? "default"]}`}
  >
    {p.loading ? <span class="inline-block animate-spin text-xs">↺</span> : p.children}
  </button>
);

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
  act: (id: string, verb: string) => void | Promise<void>;
  onViewCmd: (target: { id: string; name: string }) => void;
  onConsole?: (target: { id: string; name: string }) => void;
}> = (p) => {
  const navigate = useNavigate();
  const c = () => p.c;
  const name = () => containerName(c());
  const running = () => c().State === "running";
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

  return (
    <div
      class={`flex text-sm transition-colors ${rowBg()} ${p.onToggleSelect ? "cursor-pointer" : ""} ${
        p.selected ? "ring-1 ring-inset ring-indigo-500/60" : ""
      }`}
      onClick={() => p.onToggleSelect?.()}
    >
      {/* Container info + actions */}
      <div class="w-44 shrink-0 px-3 py-2">
        <div class="flex items-center gap-1.5">
          <span class={`h-2 w-2 shrink-0 ${STATE_DOT[c().State] ?? "bg-zinc-600"}`} />
          <a
            class="max-w-[9rem] truncate font-medium text-zinc-200 hover:text-indigo-400 transition-colors"
            href={`/containers/${c().Id}`}
            title={name() || "(unnamed)"}
            onClick={goto(`/containers/${c().Id}`)}
          >
            {name() || <span class="text-zinc-400">(unnamed)</span>}
          </a>
        </div>
        <a
          class="mt-0.5 font-mono text-[11px] text-zinc-400 hover:text-indigo-400 transition-colors"
          href={`/containers/${c().Id}`}
          onClick={goto(`/containers/${c().Id}`)}
        >{c().Id.slice(0, 12)}</a>
        <div class="max-w-[10rem] truncate text-[11px] text-zinc-400" title={c().Image}>{c().Image}</div>
        <div class="mt-0.5 text-[11px] text-zinc-400">
          {fmtContainerStatus(c().State, c().Status)}
          {" · 创建 "}{fmtRelTime(c().Created)}
        </div>
        <Show when={hasRole("operator")}>
          <div class="mt-1 flex items-center gap-0.5">
            <Show when={!running() && !paused()}>
              <IBtn title="启动" variant="success" loading={p.isP(c().Id, "start")} onClick={() => void p.act(c().Id, "start")}>▶</IBtn>
            </Show>
            <Show when={paused()}>
              <IBtn title="恢复运行" variant="success" loading={p.isP(c().Id, "unpause")} onClick={() => void p.act(c().Id, "unpause")}>▶</IBtn>
            </Show>
            <Show when={running()}>
              <IBtn title="停止" variant="warning" loading={p.isP(c().Id, "stop")} onClick={() => void p.act(c().Id, "stop")}>■</IBtn>
              <IBtn title="暂停" variant="warning" loading={p.isP(c().Id, "pause")} onClick={() => void p.act(c().Id, "pause")}>⏸</IBtn>
              <IBtn title="重启" variant="info" loading={p.isP(c().Id, "restart")} onClick={() => void p.act(c().Id, "restart")}>↺</IBtn>
              <IBtn title="强制关闭 (SIGKILL)" variant="danger" loading={p.isP(c().Id, "kill")} onClick={() => void p.act(c().Id, "kill")}>✕</IBtn>
            </Show>

            <span class="mx-0.5 text-zinc-400">│</span>

            <IBtn title="查看 Run/Compose 命令" onClick={() => p.onViewCmd({ id: c().Id, name: name() || c().Id.slice(0, 8) })}>⧉</IBtn>

            <Show when={running() && p.onConsole}>
              <IBtn title="控制台" onClick={() => p.onConsole?.({ id: c().Id, name: name() || c().Id.slice(0, 8) })}>&gt;_</IBtn>
            </Show>

            <Show when={!running()}>
              <span class="mx-0.5 text-zinc-400">│</span>
              <IBtn title="删除容器" variant="danger" loading={p.isP(c().Id, "delete")} onClick={() => { if (confirm(`删除容器 ${name() || c().Id.slice(0, 8)}？`)) void p.act(c().Id, "delete"); }}>⊖</IBtn>
            </Show>
          </div>
        </Show>
        <Show when={!hasRole("operator")}>
          <div class="mt-1 flex gap-0.5">
            <IBtn title="查看 Run/Compose 命令" onClick={() => p.onViewCmd({ id: c().Id, name: name() || c().Id.slice(0, 8) })}>⧉</IBtn>
          </div>
        </Show>
      </div>

      {/* Network + Ports */}
      <div class="w-36 shrink-0 px-3 py-2 text-center">
        <Show when={nets()}>
          <div class="mx-auto max-w-[10rem] truncate text-xs text-zinc-500" title={nets()}>{nets()}</div>
        </Show>
        <Show when={pubPorts().length > 0}>
          <div class="mt-0.5 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5">
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
      <div class="min-w-0 flex-1 px-3 py-2">
        <Show
          when={c().Mounts.length > 0}
          fallback={<span class="text-xs text-zinc-500">—</span>}
        >
          <div class="flex flex-col gap-0.5">
            <For each={c().Mounts.slice(0, 4)}>
              {(m) => (
                <Show
                  when={running()}
                  fallback={
                    <span
                      class="flex items-center gap-0.5 font-mono text-[11px] text-zinc-500"
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
                    class="flex items-center gap-0.5 font-mono text-[11px] text-zinc-400 hover:text-emerald-400 transition-colors"
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
      <div class="w-48 shrink-0 px-3 py-2">
        <span class="line-clamp-3 break-all font-mono text-[11px] text-zinc-400" title={c().Command}>
          {c().Command || "—"}
        </span>
      </div>
    </div>
  );
};

// Header row matching ContainerRow's column widths — used above the <For> in
// any list that renders ContainerRow, so labels line up with their column.
export const ContainerRowHeader: Component = () => (
  <div class="flex border-b border-zinc-800 text-xs text-zinc-500">
    <div class="w-44 shrink-0 px-3 py-2">容器</div>
    <div class="w-36 shrink-0 px-3 py-2 text-center">网络 / 端口</div>
    <div class="min-w-0 flex-1 px-3 py-2">挂载</div>
    <div class="w-48 shrink-0 px-3 py-2">命令</div>
  </div>
);
