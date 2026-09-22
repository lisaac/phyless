import { Component, createEffect, createMemo, createSignal, onCleanup, For, Show } from "solid-js";
import { connectWS, reportWSError } from "../../api/ws";
import { Chip } from "../shared/Button";
import { createListView, SearchBox, LoadMore } from "../shared/ListView";
import { TimeRangePicker, appendTimeRange, presetRange, type TimeRange } from "../shared/TimeRangePicker";

// One docker event as sent by ws.Events (backend/internal/ws/ws.go eventLine).
type DockerEvent = { time: number; type: string; action: string; id: string; attrs?: Record<string, string> };

const MAX_EVENTS = 5000; // ponytail: oldest dropped past this; 7d on a busy host may truncate
const TYPES = ["container", "image", "network", "volume"] as const;
const TYPE_LABEL: Record<string, string> = { container: "容器", image: "镜像", network: "网络", volume: "卷" };
const TYPE_COLOR: Record<string, string> = {
  container: "text-sky-400", image: "text-violet-400", network: "text-teal-400", volume: "text-amber-400",
};

// exec_create/exec_start/exec_die + health_status fire on every healthcheck tick
// and drown everything else — hidden by default.
const isNoise = (e: DockerEvent) => e.action.startsWith("exec_") || e.action.startsWith("health_status");

const actionColor = (a: string) =>
  /^(destroy|die|kill|delete|remove|untag|oom|disconnect|unmount)/.test(a) ? "text-red-400"
  : /^(start|create|pull|connect|mount|restart|unpause|tag|load|import)/.test(a) ? "text-emerald-400"
  : /^(stop|pause)/.test(a) ? "text-amber-400"
  : "text-zinc-300";

const eventName = (e: DockerEvent) => e.attrs?.name || e.id.slice(0, 12);

// Detail shown after the name: the fields that actually tell you something.
const eventDetail = (e: DockerEvent) => {
  const a = e.attrs ?? {};
  const parts: string[] = [];
  if (e.type === "container" && a.image) parts.push(a.image);
  if (a.exitCode) parts.push(`exit ${a.exitCode}`);
  if (a.signal) parts.push(`signal ${a.signal}`);
  if (e.type === "network" && a.container) parts.push(`容器 ${a.container.slice(0, 12)}`);
  if (a["com.docker.compose.project"]) parts.push(`compose ${a["com.docker.compose.project"]}`);
  return parts.join(" · ");
};

const pad = (n: number) => String(n).padStart(2, "0");
const fmtTime = (unix: number) => {
  const d = new Date(unix * 1000);
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return d.toDateString() === new Date().toDateString() ? hms : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms}`;
};

export const EventsPage: Component = () => {
  const [range, setRange] = createSignal<TimeRange>(presetRange("1h"));
  const [events, setEvents] = createSignal<DockerEvent[]>([]); // newest first
  const [types, setTypes] = createSignal<Set<string>>(new Set()); // empty = all
  const [hideNoise, setHideNoise] = createSignal(true);
  const [paused, setPaused] = createSignal(false);

  let ws: WebSocket | undefined;
  let pending: DockerEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  // History replay arrives as a burst of thousands of messages — batch them.
  const flush = () => {
    flushTimer = undefined;
    if (paused() || !pending.length) return;
    const batch = pending.reverse();
    pending = [];
    setEvents((prev) => batch.concat(prev).slice(0, MAX_EVENTS));
  };

  createEffect(() => {
    const url = appendTimeRange("/ws/events", range());
    ws?.close();
    pending = [];
    setEvents([]);
    const sock = connectWS(url, {
      onMessage: (ev) => {
        if (sock !== ws || typeof ev.data !== "string") return;
        try { pending.push(JSON.parse(ev.data)); } catch { return; }
        if (pending.length > MAX_EVENTS) pending = pending.slice(-MAX_EVENTS);
        flushTimer ??= setTimeout(flush, 100);
      },
      onError: () => { if (sock === ws) reportWSError("事件实时连接"); },
    });
    ws = sock;
  });
  // Resuming releases whatever queued up while paused.
  createEffect(() => { if (!paused()) flush(); });
  onCleanup(() => { ws?.close(); ws = undefined; if (flushTimer) clearTimeout(flushTimer); });

  const byType = createMemo(() => {
    const t = types();
    return events().filter((e) => (!hideNoise() || !isNoise(e)) && (t.size === 0 || t.has(e.type)));
  });
  const view = createListView(byType, (e) =>
    `${e.type} ${e.action} ${e.id} ${eventName(e)} ${eventDetail(e)}`, { rowHeight: 32 });

  const toggleType = (t: string) => setTypes((prev) => {
    const next = new Set(prev);
    if (next.has(t)) next.delete(t); else next.add(t);
    return next;
  });

  return (
    <div>
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 class="text-xl font-semibold">事件</h1>
        <TimeRangePicker initial="1h" onChange={setRange} />
      </div>

      <div class="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <SearchBox value={view.query()} onInput={view.setQuery} placeholder="搜索名称 / 动作 / 镜像…" />
        <div class="flex flex-wrap items-center gap-1.5">
          <Chip active={types().size === 0} onClick={() => setTypes(new Set<string>())}>全部</Chip>
          <For each={TYPES}>
            {(t) => <Chip active={types().has(t)} onClick={() => toggleType(t)}>{TYPE_LABEL[t]}</Chip>}
          </For>
          <span class="mx-1 h-4 w-px bg-zinc-700" />
          <Chip active={hideNoise()} onClick={() => setHideNoise((v) => !v)}>隐藏 exec/健康检查</Chip>
          <Chip active={paused()} warn onClick={() => setPaused((v) => !v)}>{paused() ? "▶ 继续" : "⏸ 暂停"}</Chip>
        </div>
        <span class="text-xs text-zinc-500 sm:ml-auto">
          {view.filtered().length} / {events().length} 条
        </span>
      </div>

      <div class="border border-zinc-800 bg-zinc-950 font-mono text-xs">
        <For each={view.visible()}>
          {(e) => (
            <div class="flex flex-wrap items-baseline gap-x-3 border-b border-zinc-900 px-3 py-1.5 hover:bg-white/[0.03] sm:flex-nowrap">
              <span class="shrink-0 text-zinc-500 sm:w-28">{fmtTime(e.time)}</span>
              <span class={`w-10 shrink-0 ${TYPE_COLOR[e.type] ?? "text-zinc-400"}`}>{TYPE_LABEL[e.type] ?? e.type}</span>
              <span class={`w-28 shrink-0 truncate ${actionColor(e.action)}`} title={e.action}>{e.action}</span>
              <span class="min-w-0 break-all text-zinc-200" title={e.id}>{eventName(e)}</span>
              <Show when={eventDetail(e)}>
                <span class="min-w-0 truncate text-zinc-500" title={eventDetail(e)}>{eventDetail(e)}</span>
              </Show>
            </div>
          )}
        </For>
        <LoadMore when={view.hasMore()} onMore={view.loadMore} />
        <Show when={view.filtered().length === 0}>
          <div class="py-16 text-center font-sans text-sm text-zinc-500">
            {events().length === 0 ? "该时间段暂无事件" : "无匹配事件"}
          </div>
        </Show>
      </div>
    </div>
  );
};
