import { Component, createSignal, createMemo, Show, For } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { useFloatingSlot } from "../../stores/floatingStack";
import {
  tasks, panelHidden, setPanelHidden, cancel, remove, clearFinished, isActive, type Task,
} from "../../stores/taskQueue";

const DEFAULT_VISIBLE = 5;

const STATUS_STYLE: Record<string, string> = {
  "Pull complete": "text-emerald-400",
  "Already exists": "text-zinc-500",
  "Download complete": "text-sky-400",
  Downloading: "text-indigo-400",
  Extracting: "text-indigo-400",
  Waiting: "text-zinc-500",
  Verifying: "text-zinc-400",
};

const dotClass = (t: Task) =>
  isActive(t.status)
    ? (t.status === "queued" ? "bg-zinc-500" : "animate-pulse bg-indigo-500")
    : (t.status === "done" ? "bg-emerald-500" : "bg-red-500");

// One-line status shown to the right of the title in the compact row.
const brief = (t: Task): string => {
  switch (t.status) {
    case "queued": return "排队中";
    case "done": return "完成";
    case "error": return "失败";
    case "cancelled": return "已取消";
    case "interrupted": return "已中断";
  }
  if (t.uploadPct !== null) return `上传 ${t.uploadPct.toFixed(0)}%`;
  const total = t.layers.reduce((s, l) => s + (l.total ?? 0), 0);
  if (total > 0) {
    const cur = t.layers.reduce((s, l) => s + Math.min(l.current ?? 0, l.total ?? 0), 0);
    return `${((cur / total) * 100).toFixed(0)}%`;
  }
  return t.notes[t.notes.length - 1] ?? "连接中…";
};

// Single bottom-left panel for the global task queue (stores/taskQueue.ts):
// compact one-line rows, newest first, expandable to the per-layer
// progress / log detail that PullStatusWidget used to show per task.
export const TaskQueueWidget: Component = () => {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = createSignal(false);
  const [showAll, setShowAll] = createSignal(false);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const visible = () => tasks.list.length > 0 && !panelHidden();
  const { setRef, offset } = useFloatingSlot(visible);

  const sorted = createMemo(() => [...tasks.list].sort((a, b) => b.createdAt - a.createdAt));
  const shown = () => (showAll() ? sorted() : sorted().slice(0, DEFAULT_VISIBLE));
  const runningCount = () => tasks.list.filter((t) => t.status === "running").length;
  const queuedCount = () => tasks.list.filter((t) => t.status === "queued").length;
  const toggleExpand = (id: string) =>
    setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const link = (t: Task) => t.doneLink ?? (t.containerId ? { href: `/containers/${t.containerId}`, label: "查看容器详情" } : undefined);

  return (
    <Show when={visible()}>
      <div
        ref={setRef}
        class="fixed left-4 z-50 w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-zinc-700/50 bg-zinc-900 shadow-2xl transition-[bottom] duration-200"
        style={{ bottom: `${offset()}px` }}
      >
        <div class="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
          <div class="flex min-w-0 items-center gap-2 text-sm text-zinc-200">
            <span class={`h-2 w-2 shrink-0 rounded-full ${runningCount() > 0 ? "animate-pulse bg-indigo-500" : "bg-zinc-600"}`} />
            <span class="font-medium">任务</span>
            <span class="truncate text-xs text-zinc-500">
              <Show when={runningCount() > 0}>{runningCount()} 运行中</Show>
              <Show when={queuedCount() > 0}> · {queuedCount()} 排队</Show>
            </span>
          </div>
          <div class="flex shrink-0 items-center gap-0.5 text-xs">
            <Show when={tasks.list.some((t) => !isActive(t.status))}>
              <button class="px-1 py-0.5 text-zinc-500 hover:text-zinc-200" onClick={clearFinished}>清除已完成</button>
            </Show>
            <button
              class="w-4 p-1 text-center leading-none text-zinc-500 hover:text-zinc-200"
              title={collapsed() ? "展开" : "收起"}
              onClick={() => setCollapsed((c) => !c)}
            >{collapsed() ? "+" : "−"}</button>
            <button class="p-1 text-zinc-500 hover:text-zinc-200" title="隐藏" onClick={() => setPanelHidden(true)}>✕</button>
          </div>
        </div>
        <Show when={!collapsed()}>
          <div class="max-h-[50vh] overflow-auto text-xs">
            <For each={shown()}>
              {(t) => (
                <div class="border-b border-zinc-800/60 last:border-b-0">
                  <div class="flex items-center gap-2 px-3 py-1.5">
                    <button class="w-3 shrink-0 text-zinc-500 hover:text-zinc-200" onClick={() => toggleExpand(t.id)}>
                      {expanded().has(t.id) ? "▾" : "▸"}
                    </button>
                    <span class={`h-2 w-2 shrink-0 rounded-full ${dotClass(t)}`} />
                    <span class="min-w-0 flex-1 truncate text-zinc-200" title={t.title}>{t.title}</span>
                    <span class={`max-w-[35%] shrink-0 truncate font-mono ${t.status === "error" || t.status === "interrupted" ? "text-red-400" : "text-zinc-500"}`} title={brief(t)}>
                      {brief(t)}
                    </span>
                    <button
                      class="shrink-0 p-0.5 text-zinc-500 hover:text-zinc-200"
                      title={isActive(t.status) ? "取消" : "移除"}
                      onClick={() => (isActive(t.status) ? cancel(t.id) : remove(t.id))}
                    >✕</button>
                  </div>
                  <Show when={expanded().has(t.id)}>
                    <div class="max-h-64 overflow-auto bg-zinc-950/40 px-3 py-2 font-mono">
                      <Show when={t.uploadPct !== null}>
                        <div class="mb-1.5 h-2 overflow-hidden rounded-full bg-zinc-800">
                          <div class="h-full rounded-full bg-indigo-600 transition-all duration-150" style={{ width: `${Math.min(100, t.uploadPct!)}%` }} />
                        </div>
                      </Show>
                      <div class="flex flex-col gap-1">
                        <For each={t.layers}>
                          {(l) => (
                            <div class="flex items-center gap-2 py-0.5">
                              <span class="w-16 shrink-0 truncate text-zinc-500">{l.id}</span>
                              <span class={`w-24 shrink-0 truncate ${STATUS_STYLE[l.status] ?? "text-zinc-400"}`}>{l.status}</span>
                              <Show when={l.total}>
                                <div class="h-2 flex-1 overflow-hidden rounded-full bg-zinc-800">
                                  <div class="h-full rounded-full bg-indigo-600 transition-all duration-200" style={{ width: `${Math.min(100, ((l.current ?? 0) / (l.total ?? 1)) * 100)}%` }} />
                                </div>
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                      <For each={t.notes}>{(n) => <div class="mt-1 text-zinc-400">{n}</div>}</For>
                      <Show when={t.layers.length === 0 && t.notes.length === 0 && !t.error}>
                        <p class="text-zinc-500">{t.status === "queued" ? "等待前序任务完成" : t.status === "done" ? "完成" : "连接中…"}</p>
                      </Show>
                      <Show when={t.error}><p class="mt-1 text-red-400">{t.error}</p></Show>
                      <Show when={t.status === "done" && link(t)}>
                        {(l) => (
                          <a
                            href={l().href}
                            class="mt-1.5 block text-indigo-400 hover:text-indigo-300 hover:underline"
                            onClick={(e) => { e.preventDefault(); navigate(l().href, { replace: true }); }}
                          >→ {l().label}</a>
                        )}
                      </Show>
                    </div>
                  </Show>
                </div>
              )}
            </For>
            <Show when={sorted().length > DEFAULT_VISIBLE}>
              <button class="w-full px-3 py-1.5 text-center text-zinc-500 hover:text-zinc-200" onClick={() => setShowAll((v) => !v)}>
                {showAll() ? "收起" : `显示全部 (${sorted().length})`}
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
};
