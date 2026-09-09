import { Component, createSignal, createMemo, createEffect, onCleanup, Show, For } from "solid-js";
import { useNavigate } from "@solidjs/router";
import {
  tasks, panelHidden, setPanelHidden, cancel, remove, clearFinished, isActive, type Task,
} from "../../stores/taskQueue";

const DEFAULT_VISIBLE = 12;
const AUTO_HIDE_MS = 10_000;
const ANIM_MS = 220; // keep in sync with duration-200 + a little slack

const STATUS_STYLE: Record<string, string> = {
  "Pull complete": "text-emerald-400",
  "Already exists": "text-zinc-500",
  "Download complete": "text-sky-400",
  Downloading: "text-indigo-400",
  Extracting: "text-indigo-400",
  Waiting: "text-zinc-500",
  Verifying: "text-zinc-400",
};

const OP_LABEL: Record<string, string> = {
  pull: "拉取镜像", "browser-pull": "拉取镜像（浏览器）", load: "加载镜像", import: "导入镜像",
  "image-delete": "删除镜像", prune: "清理镜像", create: "创建容器", upgrade: "升级容器",
  "browser-pull-action": "容器镜像操作（浏览器）", "browser-pull-compose": "Compose 镜像操作（浏览器）",
  "compose-update": "更新 Compose",
  start: "启动", stop: "停止", restart: "重启", pause: "暂停", unpause: "恢复", kill: "强制关闭",
  delete: "删除", up: "启动 Compose", down: "停止 Compose", build: "构建 Compose", update: "更新 Compose",
  POST: "提交", PUT: "更新", DELETE: "删除",
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

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};

// Structured facts for the expanded detail: status, timing, operation,
// complete target and request endpoint.
const metaRows = (t: Task): [string, string][] => {
  const rows: [string, string][] = [["时间", fmtTime(t.createdAt)], ["状态", brief(t)]];
  if (t.finishedAt) rows.push(["耗时", fmtDur(t.finishedAt - t.createdAt)]);
  const op = (t.meta?.verb ?? t.meta?.action ?? t.meta?.type ?? (t.url ? t.method ?? "POST" : undefined)) as string | undefined;
  if (op) rows.push(["操作", OP_LABEL[op] ?? op]);
  const target = (t.containerId ?? t.meta?.containerId ?? t.meta?.composeId ?? t.key) as string | undefined;
  if (target) rows.push(["目标", target]);
  if (t.url) rows.push(["请求", `${t.method ?? "POST"} ${t.url}`]);
  const ids = t.meta?.ids as string[] | undefined;
  if (ids?.length) rows.push(["数量", `${ids.length}`]);
  return rows;
};

// Global task queue (stores/taskQueue.ts) as a right-side slide-in drawer:
// click a row to expand its per-layer progress / log detail, click the
// backdrop (or 关闭) to slide it out.
export const TaskQueueWidget: Component = () => {
  const navigate = useNavigate();
  const [showAll, setShowAll] = createSignal(false);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const open = () => !panelHidden();

  // Keep the drawer mounted through the slide-out so the exit animation runs.
  // `rendered` gates the DOM; `slid` drives the transform (off-screen ⇄ in).
  const [rendered, setRendered] = createSignal(open());
  const [slid, setSlid] = createSignal(open());
  createEffect(() => {
    if (open()) {
      setRendered(true);
      requestAnimationFrame(() => setSlid(true));
    } else {
      setSlid(false);
      const t = setTimeout(() => setRendered(false), ANIM_MS);
      onCleanup(() => clearTimeout(t));
    }
  });

  // Auto-hide 10 s after the last task settles, but only when everything
  // ended well — an error/interrupted row stays until the user dismisses it.
  createEffect(() => {
    const list = tasks.list;
    if (list.length === 0) { setPanelHidden(true); return; } // 清除已完成 emptied it — nothing left to show
    const allOk = list.every((t) => !isActive(t.status) && t.status !== "error" && t.status !== "interrupted");
    if (!allOk) return;
    const timer = setTimeout(() => setPanelHidden(true), AUTO_HIDE_MS);
    onCleanup(() => clearTimeout(timer));
  });

  const sorted = createMemo(() => [...tasks.list].sort((a, b) => b.createdAt - a.createdAt));
  const shown = () => (showAll() ? sorted() : sorted().slice(0, DEFAULT_VISIBLE));
  const runningCount = () => tasks.list.filter((t) => t.status === "running").length;
  const queuedCount = () => tasks.list.filter((t) => t.status === "queued").length;
  const toggleExpand = (id: string) =>
    setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const link = (t: Task) => t.doneLink ?? (t.containerId ? { href: `/containers/${t.containerId}`, label: "查看容器详情" } : undefined);

  return (
    <Show when={rendered()}>
      {/* Backdrop — click outside the drawer closes it. Fades with the slide. */}
      <div
        class="fixed inset-0 z-40 bg-black/30 transition-opacity duration-200"
        classList={{ "opacity-100": slid(), "opacity-0": !slid() }}
        onClick={() => setPanelHidden(true)}
      />
      {/* Drawer — pinned to the right edge, full height, slides in from the right. */}
      <div
        class="fixed right-0 top-0 z-50 flex h-full w-[min(22rem,calc(100vw-3rem))] flex-col border-l border-zinc-800 bg-zinc-900 shadow-2xl transition-transform duration-200 ease-out"
        classList={{ "translate-x-0": slid(), "translate-x-full": !slid() }}
      >
        <div class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div class="flex min-w-0 items-center gap-2">
            <span class={`h-2 w-2 shrink-0 rounded-full ${runningCount() > 0 ? "animate-pulse bg-indigo-500" : "bg-zinc-600"}`} />
            <span class="text-sm font-semibold text-zinc-100">任务</span>
            <span class="truncate text-[10px] uppercase tracking-widest text-zinc-500">
              <Show when={runningCount() > 0}>{runningCount()} 运行中</Show>
              <Show when={queuedCount() > 0}> · {queuedCount()} 排队</Show>
            </span>
          </div>
          <div class="flex shrink-0 items-center gap-1 text-xs">
            <Show when={tasks.list.some((t) => !isActive(t.status))}>
              <button class="rounded px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" onClick={clearFinished}>清除已完成</button>
            </Show>
            <button class="rounded p-1 text-lg leading-none text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="关闭" onClick={() => setPanelHidden(true)}>×</button>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-auto">
          <Show when={tasks.list.length === 0}>
            <p class="px-4 py-6 text-center text-xs text-zinc-500">暂无任务</p>
          </Show>
          <For each={shown()}>
            {(t) => (
              <div class="border-b border-zinc-800/60 last:border-b-0">
                {/* Header row — click anywhere to expand/collapse (no arrow). */}
                <div
                  class="flex cursor-pointer items-center gap-2.5 px-4 py-2.5 hover:bg-zinc-800"
                  onClick={() => toggleExpand(t.id)}
                >
                  <span class={`h-2 w-2 shrink-0 rounded-full ${dotClass(t)}`} />
                  <span class="min-w-0 flex-1 truncate text-xs text-zinc-200" title={t.title}>{t.title}</span>
                  <span class={`shrink-0 truncate font-mono text-[11px] ${t.status === "error" || t.status === "interrupted" ? "text-red-400" : "text-zinc-500"}`} title={brief(t)}>
                    {brief(t)}
                  </span>
                  <button
                    class="shrink-0 p-0.5 text-zinc-600 hover:text-zinc-200"
                    title={isActive(t.status) ? "取消" : "移除"}
                    onClick={(e) => { e.stopPropagation(); isActive(t.status) ? cancel(t.id) : remove(t.id); }}
                  >✕</button>
                </div>
                <Show when={expanded().has(t.id)}>
                  <div class="max-h-72 overflow-auto border-t border-zinc-800 bg-zinc-950 px-4 py-3 font-mono text-[11px]">
                    <dl class="mb-2 grid grid-cols-[3rem_1fr] gap-x-3 gap-y-0.5">
                      <For each={metaRows(t)}>
                        {([k, v]) => (<>
                          <dt class="text-[10px] uppercase tracking-widest text-zinc-500">{k}</dt>
                          <dd class="break-all whitespace-pre-wrap text-zinc-300" title={v}>{v}</dd>
                        </>)}
                      </For>
                    </dl>
                    <Show when={t.details?.length > 0}>
                      <dl class="mb-2 grid grid-cols-[3rem_1fr] gap-x-3 gap-y-1 border-t border-zinc-800 pt-2">
                        <For each={t.details}>
                          {(detail) => (<>
                            <dt class="text-[10px] uppercase tracking-widest text-zinc-500">{detail.label}</dt>
                            <dd class="min-w-0 text-zinc-300">
                              <Show when={Array.isArray(detail.value)} fallback={<span class="break-all whitespace-pre-wrap">{detail.value as string}</span>}>
                                <ul class="space-y-0.5">
                                  <For each={detail.value as string[]}>{(value) => <li class="break-all"><span class="mr-1 text-zinc-600">•</span>{value}</li>}</For>
                                </ul>
                              </Show>
                            </dd>
                          </>)}
                        </For>
                      </dl>
                    </Show>
                    <Show when={t.uploadPct !== null}>
                      <div class="mb-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
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
                              <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
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
                          class="mt-2 block text-indigo-400 hover:text-indigo-300 hover:underline"
                          onClick={(e) => { e.preventDefault(); navigate(l().href, { replace: true }); setPanelHidden(true); }}
                        >→ {l().label}</a>
                      )}
                    </Show>
                  </div>
                </Show>
              </div>
            )}
          </For>
          <Show when={sorted().length > DEFAULT_VISIBLE}>
            <button class="w-full px-4 py-2.5 text-center text-xs text-zinc-500 hover:text-zinc-200" onClick={() => setShowAll((v) => !v)}>
              {showAll() ? "收起" : `显示全部 (${sorted().length})`}
            </button>
          </Show>
        </div>
      </div>
    </Show>
  );
};
