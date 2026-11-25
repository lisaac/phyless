import { Component, createMemo, createSignal, onCleanup, For, Show } from "solid-js";
import { createTabState } from "../../stores/tabs";
import { Chip, PageHeader } from "../shared/Button";
import { createListView, SearchBox, LoadMore } from "../shared/ListView";
import { TimeRangePicker, appendTimeRange, presetRange, type TimeRange } from "../shared/TimeRangePicker";
import { createResourceStore } from "../../stores/resource";
import type { AuditEntry } from "../../types";

// Same look as EventsPage. Backend returns the newest ≤1000 entries
// (audit.DefaultMaxEntries) within ?since/until.
const TYPES = ["container", "compose", "image", "network", "volume", "registry", "other"] as const;
const TYPE_LABEL: Record<string, string> = {
  container: "容器", compose: "编排", image: "镜像", network: "网络", volume: "卷", registry: "仓库", other: "其他",
};
const TYPE_COLOR: Record<string, string> = {
  container: "text-sky-400", compose: "text-indigo-400", image: "text-violet-400", network: "text-teal-400",
  volume: "text-amber-400", registry: "text-pink-400", other: "text-zinc-400",
};

const typeOf = (e: AuditEntry) => {
  const t = e.action.split(".")[0];
  return t in TYPE_LABEL ? t : "other";
};
// "container.file.copy" → "file.copy"; non-grouped actions keep their full name.
const verb = (e: AuditEntry) => (typeOf(e) === "other" ? e.action : e.action.slice(e.action.indexOf(".") + 1));
const isOk = (e: AuditEntry) => e.result === "ok";

const actionColor = (a: string) =>
  /(delete|kill|remove)/.test(a) ? "text-red-400"
  : /(create|start|pull|register|duplicate|login|save|restart|upgrade)/.test(a) ? "text-emerald-400"
  : /(stop)/.test(a) ? "text-amber-400"
  : "text-zinc-300";

const pad = (n: number) => String(n).padStart(2, "0");
const fmtTime = (ms: number) => {
  const d = new Date(ms);
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return d.toDateString() === new Date().toDateString() ? hms : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms}`;
};

export const AuditPage: Component = () => {
  const [range, setRange] = createSignal<TimeRange>(presetRange("24h"));
  // One store per range; a range that already ended has nothing new to poll for.
  const store = createMemo(() => {
    const r = range();
    const s = createResourceStore<AuditEntry>(appendTimeRange("/api/audit", r));
    if (r.until === undefined || r.until * 1000 > Date.now()) s.startPolling(); else void s.refresh();
    onCleanup(s.stopPolling);
    return s;
  });
  const [types, setTypes] = createTabState<Set<string>>("types", new Set()); // empty = all
  const [failedOnly, setFailedOnly] = createTabState("failedOnly", false);

  const entries = createMemo(() => store().items().slice().sort((a, b) => Date.parse(b.time) - Date.parse(a.time))); // newest first
  const filtered = createMemo(() => {
    const t = types();
    return entries().filter((e) => (t.size === 0 || t.has(typeOf(e))) && (!failedOnly() || !isOk(e)));
  });
  const view = createListView(filtered, (e) => `${e.user} ${e.action} ${e.target} ${e.result}`, { rowHeight: 32 });

  const toggleType = (t: string) => setTypes((prev) => {
    const next = new Set(prev);
    if (next.has(t)) next.delete(t); else next.add(t);
    return next;
  });

  return (
    <div>
      <PageHeader title="审计日志">
        <TimeRangePicker initial="24h" onChange={setRange} />
      </PageHeader>
      <Show when={store().error()}><p class="mb-2 text-sm text-red-400">{store().error()}</p></Show>

      <div class="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <SearchBox value={view.query()} onInput={view.setQuery} placeholder="搜索用户 / 动作 / 对象…" />
        <div class="flex flex-wrap items-center gap-1.5">
          <Chip active={types().size === 0} onClick={() => setTypes(new Set<string>())}>全部</Chip>
          <For each={TYPES}>
            {(t) => <Chip active={types().has(t)} onClick={() => toggleType(t)}>{TYPE_LABEL[t]}</Chip>}
          </For>
          <span class="mx-1 h-4 w-px bg-zinc-700" />
          <Chip active={failedOnly()} warn onClick={() => setFailedOnly((v) => !v)}>仅失败</Chip>
        </div>
        <span class="text-xs text-zinc-500 sm:ml-auto">
          {view.filtered().length} / {entries().length} 条
        </span>
      </div>

      <div class="border border-zinc-800 bg-zinc-950 font-mono text-xs">
        <For each={view.visible()}>
          {(e) => (
            <div class="flex flex-wrap items-baseline gap-x-3 border-b border-zinc-900 px-3 py-1.5 hover:bg-white/[0.03] sm:flex-nowrap">
              <span class="shrink-0 text-zinc-500 sm:w-28" title={new Date(e.time).toLocaleString()}>{fmtTime(Date.parse(e.time))}</span>
              <span class={`w-10 shrink-0 ${TYPE_COLOR[typeOf(e)]}`}>{TYPE_LABEL[typeOf(e)]}</span>
              <span class={`w-32 shrink-0 truncate ${actionColor(e.action)}`} title={e.action}>{verb(e)}</span>
              <span class="shrink-0 truncate text-zinc-400 sm:w-20" title={e.user}>{e.user}</span>
              <span class="min-w-0 max-w-full truncate text-zinc-200" title={e.target}>{e.target}</span>
              <Show when={!isOk(e)}>
                <span class="min-w-0 truncate text-red-400 sm:ml-auto" title={e.result}>{e.result}</span>
              </Show>
            </div>
          )}
        </For>
        <LoadMore when={view.hasMore()} onMore={view.loadMore} />
        <Show when={view.filtered().length === 0}>
          <div class="py-16 text-center font-sans text-sm text-zinc-500">
            {entries().length === 0 ? "暂无审计记录" : "该条件下无记录"}
          </div>
        </Show>
      </div>
    </div>
  );
};
