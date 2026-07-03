import { Component, createSignal, onMount, onCleanup, Show, For, JSX, createResource } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { createResourceStore } from "../../stores/resource";
import { get, post, del, imageInspectUrl } from "../../api/client";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import { containerName } from "./containerActions";
import { inspectToRunCmd } from "../../api/inspect";
import { CreateContainerModal } from "./CreateContainerModal";
import { BulkRunModal } from "./BulkRunModal";
import type { ContainerSummary } from "../../types";

// ── Helpers ────────────────────────────────────────────────────────────────────
export function fmtRelTime(unix: number): string {
  const diff = Date.now() - unix * 1000;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m}m 前`;
  if (h < 24) return `${h}h 前`;
  if (d < 30) return `${d}d 前`;
  const dt = new Date(unix * 1000);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

// Parse Docker's English duration string ("2 hours", "About a minute", …) into compact form
function fmtDockerDur(s: string): string {
  if (/less than a second/i.test(s)) return "<1s";
  if (/about a minute/i.test(s)) return "~1m";
  const m = s.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?/i);
  if (!m) return s.trim();
  const units: Record<string, string> = { second: "s", minute: "m", hour: "h", day: "d", week: "w", month: "mo", year: "y" };
  return m[1] + (units[m[2].toLowerCase()] ?? m[2]);
}

// "Up 2 hours" / "Exited (0) 3 hours ago" → "运行 2h" / "停止 3h 前"
function fmtContainerStatus(state: string, status: string): string {
  if (state === "running") {
    const dur = status.replace(/^Up\s+/i, "").replace(/\s*\(Paused\)\s*$/i, "");
    return `运行 ${fmtDockerDur(dur)}`;
  }
  if (state === "paused") {
    const dur = status.replace(/^Up\s+/i, "").replace(/\s*\(Paused\)\s*$/i, "");
    return `暂停 ${fmtDockerDur(dur)}`;
  }
  if (state === "exited") {
    const m = status.match(/Exited\s+\(\d+\)\s+(.+?)\s+ago/i);
    return m ? `停止 ${fmtDockerDur(m[1])} 前` : "已停止";
  }
  if (state === "restarting") {
    const m = status.match(/Restarting\s+\(\d+\)\s+(.+?)\s+ago/i);
    return m ? `重启 ${fmtDockerDur(m[1])} 前` : "重启中";
  }
  if (state === "created") return "已创建";
  if (state === "dead") return "已终止";
  return state;
}

// Show last 1-2 path segments, max ~16 chars
// Middle-ellipsis: keep the start and end of the path so both context and target are visible.
function midPath(p: string, max = 26): string {
  if (!p || p.length <= max) return p;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - head - 1;
  return p.slice(0, head) + "…" + p.slice(p.length - tail);
}

function composeProject(c: ContainerSummary): string | undefined {
  return c.Labels?.["com.docker.compose.project"];
}

// ── State dot color ────────────────────────────────────────────────────────────
const STATE_DOT: Record<string, string> = {
  running:    "bg-emerald-500",
  paused:     "bg-amber-500/80",
  restarting: "bg-sky-500/70",
  exited:     "bg-zinc-600",
  dead:       "bg-red-600/80",
  created:    "bg-zinc-600",
};

// ── Icon button ────────────────────────────────────────────────────────────────
const IBtn = (p: {
  title: string; onClick: () => void;
  loading?: boolean; disabled?: boolean; danger?: boolean; children: JSX.Element;
}) => (
  <button
    title={p.title}
    disabled={p.loading || p.disabled}
    onClick={(e) => { e.stopPropagation(); p.onClick(); }}
    class={`inline-flex h-6 w-6 items-center justify-center transition-colors disabled:opacity-30 ${
      p.danger
        ? "text-zinc-500 hover:bg-red-900/40 hover:text-red-400"
        : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"
    }`}
  >
    {p.loading ? <span class="inline-block animate-spin text-xs">↺</span> : p.children}
  </button>
);

// ── Run/Compose modal ──────────────────────────────────────────────────────────
const ViewCmdModal: Component<{ id: string; name: string; onClose: () => void }> = (props) => {
  const [cmd] = createResource(async () => {
    const inspect = await get<Record<string, unknown>>(`/api/containers/${props.id}/inspect`);
    const imageId = (inspect?.Image as string) ?? "";
    let imageInspect = {};
    if (imageId) {
      try { imageInspect = await get(imageInspectUrl(imageId)); } catch { /* ignore */ }
    }
    return inspectToRunCmd(inspect, imageInspect);
  });

  return (
    <Show when={!cmd.loading} fallback={null}>
      <CreateContainerModal
        open
        onClose={props.onClose}
        onCreated={props.onClose}
        initialRun={cmd() ?? ""}
      />
    </Show>
  );
};

// ── Main page ──────────────────────────────────────────────────────────────────
export const ContainerListPage: Component = () => {
  const navigate = useNavigate();
  const store = createResourceStore<ContainerSummary>("/api/containers");
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [showCreate, setShowCreate] = createSignal(false);
  const [pending, setPending] = createSignal<Set<string>>(new Set());
  const [runTarget, setRunTarget] = createSignal<{ id: string; name: string } | null>(null);
  const [bulkRunIds, setBulkRunIds] = createSignal<string[] | null>(null);

  onMount(() => store.startPolling());
  onCleanup(() => store.stopPolling());

  const toggle = (id: string) =>
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = (v: boolean) =>
    setSelected(v ? new Set(store.items().map((c) => c.Id)) : new Set());

  const mark = (id: string, verb: string, on: boolean) =>
    setPending((p) => { const n = new Set(p); on ? n.add(`${id}:${verb}`) : n.delete(`${id}:${verb}`); return n; });
  const isP = (id: string, verb: string) => pending().has(`${id}:${verb}`);

  const act = async (id: string, verb: string) => {
    mark(id, verb, true);
    try {
      if (verb === "delete") await del(`/api/containers/${id}`);
      else await post(`/api/containers/${id}/${verb}`);
      await store.refresh();
    } catch (e) {
      toast.error(`${verb} 失败: ${(e as Error).message}`);
    } finally {
      mark(id, verb, false);
    }
  };

  const bulk = async (verb: "start" | "stop" | "kill" | "delete") => {
    await Promise.all([...selected()].map((id) => act(id, verb)));
    setSelected(new Set());
  };

  const bulkRun = () => {
    const ids = [...selected()];
    if (ids.length === 0) return;
    if (ids.length === 1) {
      const c = store.items().find((c) => c.Id === ids[0]);
      if (c) setRunTarget({ id: c.Id, name: containerName(c) });
    } else {
      setBulkRunIds(ids);
    }
  };

  const n = () => selected().size;
  const allSel = () => store.items().length > 0 && n() === store.items().length;

  return (
    <div class="flex flex-col gap-3">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div class="flex items-center justify-between">
        <h1 class="text-lg font-semibold">容器</h1>
        <Show when={hasRole("operator")}>
          <button
            class="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
            onClick={() => setShowCreate(true)}
          >
            + 新建容器
          </button>
        </Show>
      </div>

      {/* ── Bulk bar ────────────────────────────────────────────────────────── */}
      <div class="flex flex-wrap items-center gap-1.5 border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs">
        <input type="checkbox" checked={allSel()} onChange={(e) => toggleAll(e.currentTarget.checked)} />
        <span class="min-w-[4rem] text-zinc-500">{n() > 0 ? `${n()} 已选` : "全选"}</span>

        <Show when={hasRole("operator")}>
          <span class="text-zinc-400">│</span>
          <button title="启动选中容器" class="px-2 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30 transition-colors"
            disabled={n() === 0} onClick={() => void bulk("start")}>▶ 启动</button>
          <button title="停止选中容器" class="px-2 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30 transition-colors"
            disabled={n() === 0} onClick={() => void bulk("stop")}>■ 停止</button>
          <button title="强制关闭 (SIGKILL)" class="px-2 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30 transition-colors"
            disabled={n() === 0} onClick={() => void bulk("kill")}>✕ 强制关闭</button>
          <button title="删除选中容器" class="px-2 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30 transition-colors"
            disabled={n() === 0} onClick={() => void bulk("delete")}>⊖ 删除</button>
        </Show>

        <span class="text-zinc-400">│</span>
        <button title="查看 Run/Compose 命令" class="px-2 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30 transition-colors"
          disabled={n() === 0} onClick={bulkRun}>⧉ Run/Compose</button>

        <Show when={n() > 0}>
          <button class="ml-auto text-zinc-400 hover:text-zinc-400" onClick={() => setSelected(new Set())}>
            清除
          </button>
        </Show>
      </div>

      <Show when={store.error()}>
        <p class="text-sm text-red-400">{store.error()}</p>
      </Show>

      {/* ── Table ───────────────────────────────────────────────────────────── */}
      <div class="overflow-x-auto border border-zinc-800">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-zinc-800 text-xs text-zinc-500">
            <tr>
              <th class="w-8 px-3 py-2 font-normal" />
              <th class="w-44 px-3 py-2 font-normal">容器</th>
              <th class="w-36 px-3 py-2 font-normal">网络 / 端口</th>
              <th class="px-3 py-2 font-normal">挂载</th>
              <th class="w-36 px-3 py-2 font-normal">命令</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-zinc-800/50">
            <For each={store.items()}>
              {(c) => {
                const name = containerName(c);
                const running = () => c.State === "running";
                const paused  = () => c.State === "paused";
                const proj    = composeProject(c);

                const rowBg = () => {
                  if (c.State === "running")    return "bg-emerald-500/[0.08] hover:bg-emerald-500/[0.13]";
                  if (c.State === "paused")     return "bg-amber-500/[0.04] hover:bg-amber-500/[0.08]";
                  if (c.State === "restarting") return "bg-sky-500/[0.04] hover:bg-sky-500/[0.08]";
                  if (c.State === "dead")       return "bg-red-500/[0.05] hover:bg-red-500/[0.09]";
                  // exited / created: neutral
                  return "hover:bg-white/[0.03]";
                };

                // Port links
                const pubPorts = () => {
                  const seen = new Set<number>();
                  return c.Ports.filter((p) => p.PublicPort && !seen.has(p.PublicPort) && seen.add(p.PublicPort));
                };

                // Networks
                const nets = Object.keys(c.NetworkSettings?.Networks ?? {}).join(", ");

                return (
                  <tr class={`transition-colors ${rowBg()}`}>
                    {/* Checkbox */}
                    <td class="px-3 py-2">
                      <input type="checkbox" checked={selected().has(c.Id)} onChange={() => toggle(c.Id)} />
                    </td>

                    {/* Container info + actions */}
                    <td class="px-3 py-2">
                      {/* Name row */}
                      <div class="flex items-center gap-1.5">
                        <span class={`h-2 w-2 shrink-0 ${STATE_DOT[c.State] ?? "bg-zinc-600"}`} />
                        <a
                          class="max-w-[9rem] truncate font-medium text-zinc-200 hover:text-indigo-400 transition-colors"
                          href={`/containers/${c.Id}`}
                          title={name || "(unnamed)"}
                          onClick={(e) => { e.stopPropagation(); navigate(`/containers/${c.Id}`); e.preventDefault(); }}
                        >
                          {name || <span class="text-zinc-400">(unnamed)</span>}
                        </a>
                      </div>
                      {/* ID + image */}
                      <a
                        class="mt-0.5 font-mono text-[11px] text-zinc-400 hover:text-indigo-400 transition-colors"
                        href={`/containers/${c.Id}`}
                        onClick={(e) => { e.stopPropagation(); navigate(`/containers/${c.Id}`); e.preventDefault(); }}
                      >{c.Id.slice(0, 12)}</a>
                      <div class="max-w-[10rem] truncate text-[11px] text-zinc-400" title={c.Image}>{c.Image}</div>
                      {/* Time */}
                      <div class="mt-0.5 text-[11px] text-zinc-400">
                        {fmtContainerStatus(c.State, c.Status)}
                        {" · 创建 "}{fmtRelTime(c.Created)}
                      </div>
                      {/* Inline actions */}
                      <Show when={hasRole("operator")}>
                        <div class="mt-1.5 flex items-center gap-0.5">
                          <Show when={!running() && !paused()}>
                            <IBtn title="启动" loading={isP(c.Id, "start")} onClick={() => void act(c.Id, "start")}>▶</IBtn>
                          </Show>
                          <Show when={paused()}>
                            <IBtn title="恢复运行" loading={isP(c.Id, "unpause")} onClick={() => void act(c.Id, "unpause")}>▶</IBtn>
                          </Show>
                          <Show when={running()}>
                            <IBtn title="停止" loading={isP(c.Id, "stop")} onClick={() => void act(c.Id, "stop")}>■</IBtn>
                            <IBtn title="暂停" loading={isP(c.Id, "pause")} onClick={() => void act(c.Id, "pause")}>⏸</IBtn>
                            <IBtn title="重启" loading={isP(c.Id, "restart")} onClick={() => void act(c.Id, "restart")}>↺</IBtn>
                            <IBtn title="强制关闭 (SIGKILL)" loading={isP(c.Id, "kill")} onClick={() => void act(c.Id, "kill")} danger>✕</IBtn>
                          </Show>

                          <span class="mx-0.5 text-zinc-400">│</span>

                          <IBtn title="查看 Run/Compose 命令" onClick={() => setRunTarget({ id: c.Id, name: name || c.Id.slice(0, 8) })}>⧉</IBtn>

                          <Show when={!running()}>
                            <span class="mx-0.5 text-zinc-400">│</span>
                            <IBtn title="删除容器" danger loading={isP(c.Id, "delete")} onClick={() => void act(c.Id, "delete")}>⊖</IBtn>
                          </Show>
                        </div>
                      </Show>
                      <Show when={!hasRole("operator")}>
                        <div class="mt-1.5 flex gap-0.5">
                          <IBtn title="查看 Run/Compose 命令" onClick={() => setRunTarget({ id: c.Id, name: name || c.Id.slice(0, 8) })}>⧉</IBtn>
                        </div>
                      </Show>
                    </td>

                    {/* Network + Ports */}
                    <td class="px-3 py-2 align-top">
                      <Show when={nets}>
                        <div class="max-w-[10rem] truncate text-xs text-zinc-500" title={nets}>{nets}</div>
                      </Show>
                      <Show when={pubPorts().length > 0}>
                        <div class="mt-0.5 flex flex-wrap gap-x-1.5 gap-y-0.5">
                          <For each={pubPorts()}>
                            {(p) => (
                              <a
                                href={`http://${location.hostname}:${p.PublicPort}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                class="font-mono text-[11px] text-zinc-400 hover:text-emerald-400 transition-colors"
                                title={`打开 ${location.hostname}:${p.PublicPort}`}
                                onClick={(e) => e.stopPropagation()}
                              >
                                {p.PublicPort}→{p.PrivatePort}
                              </a>
                            )}
                          </For>
                        </div>
                      </Show>
                      <Show when={!nets && pubPorts().length === 0}>
                        <span class="text-xs text-zinc-500">—</span>
                      </Show>
                    </td>

                    {/* Mounts — both sides simplified */}
                    <td class="px-3 py-2 align-top">
                      <Show
                        when={c.Mounts.length > 0}
                        fallback={<span class="text-xs text-zinc-500">—</span>}
                      >
                        <div class="flex flex-col gap-0.5">
                          <For each={c.Mounts.slice(0, 4)}>
                            {(m) => (
                              <a
                                href={`/containers/${c.Id}?tab=files&path=${encodeURIComponent(m.Destination)}`}
                                class="flex items-center gap-0.5 font-mono text-[11px] text-zinc-400 hover:text-emerald-400 transition-colors"
                                title={`${m.Source} → ${m.Destination}${m.Mode?.includes("ro") ? " (只读)" : ""}`}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <span class="shrink-0">{midPath(m.Source || m.Name || "")}</span>
                                <span class="shrink-0 text-zinc-600">→</span>
                                <span class="shrink-0">{midPath(m.Destination)}</span>
                                <Show when={m.Mode?.includes("ro")}>
                                  <span class="text-[9px] text-zinc-400">ro</span>
                                </Show>
                              </a>
                            )}
                          </For>
                          <Show when={c.Mounts.length > 4}>
                            <span class="text-[11px] text-zinc-400">+{c.Mounts.length - 4} 更多</span>
                          </Show>
                        </div>
                      </Show>
                    </td>

                    {/* Command */}
                    <td class="px-3 py-2 align-top">
                      <span class="block max-w-[9rem] truncate font-mono text-[11px] text-zinc-400" title={c.Command}>
                        {c.Command || "—"}
                      </span>
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>

        <Show when={store.items().length === 0 && !store.error()}>
          <div class="py-16 text-center text-zinc-400">暂无容器</div>
        </Show>
      </div>

      {/* ── Run/Compose modal ───────────────────────────────────────────────── */}
      <Show when={runTarget()}>
        {(t) => <ViewCmdModal id={t().id} name={t().name} onClose={() => setRunTarget(null)} />}
      </Show>
      <Show when={bulkRunIds()}>
        {(ids) => <BulkRunModal ids={ids()} onClose={() => setBulkRunIds(null)} />}
      </Show>

      {/* ── Create container modal ───────────────────────────────────────────── */}
      <CreateContainerModal
        open={showCreate()}
        onClose={() => setShowCreate(false)}
        onCreated={() => { setShowCreate(false); void store.refresh(); }}
      />
    </div>
  );
};
