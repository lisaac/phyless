import {
  Component, createSignal, createResource, createEffect, For, Show, onMount, onCleanup,
} from "solid-js";
import { useParams, useSearchParams, useNavigate } from "@solidjs/router";
import { get, post, del, put, getToken, setToken, imageInspectUrl } from "../../api/client";
import { toast } from "../shared/Toast";
import { Modal } from "../shared/Modal";
import { CreateContainerModal } from "./CreateContainerModal";
import { ContainerLogs } from "./ContainerLogs";
import { ContainerTerminal } from "./ContainerTerminal";
import { ContainerStats } from "./ContainerStats";
import { FileBrowser } from "../shared/FileBrowser";
import { inspectToRunCmd } from "../../api/inspect";
import { hasRole } from "../../stores/auth";
import type { FileEntry, NetworkSummary } from "../../types";

// ── Design tokens ──────────────────────────────────────────────────────────────
// Labels: system-ui (zinc-500, uppercase, 10px)
// Values: font-mono (zinc-200)
// Editable values: click to reveal inline input, save on blur/enter

const STATE_COLOR: Record<string, string> = {
  running: "text-emerald-400",
  paused: "text-amber-400",
  restarting: "text-sky-400",
  exited: "text-zinc-500",
  dead: "text-red-400",
  created: "text-zinc-500",
};

const STATE_ZH: Record<string, string> = {
  running: "运行中", paused: "已暂停", restarting: "重启中",
  exited: "已停止", dead: "已终止", created: "已创建", removing: "删除中",
};

type Tab = "info" | "stats" | "files" | "console" | "logs" | "inspect";
const TABS: { key: Tab; label: string; requiresRunning?: true }[] = [
  { key: "info",    label: "基本信息" },
  { key: "stats",   label: "状态",    requiresRunning: true },
  { key: "files",   label: "文件",    requiresRunning: true },
  { key: "console", label: "控制台",  requiresRunning: true },
  { key: "logs",    label: "日志"   },
  { key: "inspect", label: "Inspect" },
];

// ── Shared field components ────────────────────────────────────────────────────
const KV: Component<{ k: string; children: any }> = (p) => (
  <div class="flex min-h-[1.75rem] items-start gap-3 py-0.5">
    <dt class="w-28 shrink-0 pt-px text-[10px] uppercase tracking-widest text-zinc-400">{p.k}</dt>
    <dd class="min-w-0 flex-1 font-mono text-xs text-zinc-200">{p.children}</dd>
  </div>
);

// Editable text field: shows value, click → input, enter/blur → onSave
const EditableKV: Component<{
  k: string; value: string; onSave: (v: string) => Promise<void>;
  type?: string; placeholder?: string; title?: string; clearable?: boolean;
}> = (p) => {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal(p.value);
  const save = async () => {
    setEditing(false);
    if (draft() !== p.value) await p.onSave(draft());
  };
  const clear = async (e: MouseEvent) => {
    e.stopPropagation();
    await p.onSave("");
  };
  return (
    <div class="flex min-h-[1.75rem] items-baseline gap-3">
      <dt class="w-28 shrink-0 pt-px text-[10px] uppercase tracking-widest text-zinc-400 cursor-help" title={p.title}>{p.k}</dt>
      <dd class="min-w-0 flex-1">
        <Show when={editing()} fallback={
          <span class="inline-flex items-baseline gap-1.5">
            <span
              class="cursor-text font-mono text-xs text-zinc-200 border-b border-dashed border-zinc-600 hover:border-zinc-400 transition-colors"
              title="点击编辑，回车保存，清空后保存可恢复默认"
              onClick={() => { setDraft(p.value); setEditing(true); }}
            >{p.value || <span class="text-zinc-500">{p.placeholder ?? "—"}</span>}</span>
            <Show when={p.clearable && p.value}>
              <button
                class="text-[10px] text-zinc-600 hover:text-zinc-300 transition-colors leading-none"
                title="清除（恢复默认）"
                onClick={clear}
              >×</button>
            </Show>
          </span>
        }>
          <input
            class="border border-indigo-500/60 bg-zinc-900 px-1.5 py-0.5 font-mono text-xs text-zinc-100 outline-none w-full max-w-xs"
            value={draft()}
            type={p.type ?? "text"}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }}
            onBlur={() => setEditing(false)}
            ref={(el) => setTimeout(() => el?.select(), 0)}
          />
        </Show>
      </dd>
    </div>
  );
};

// ── Section heading — aligns with KV dt column ────────────────────────────────
const Sec: Component<{ children: string; noLine?: boolean }> = (p) => (
  <div class="flex items-center gap-3 pt-3 pb-0.5 first:pt-0">
    <span class="w-28 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">{p.children}</span>
    <Show when={!p.noLine}><span class="flex-1 border-t border-zinc-800" /></Show>
  </div>
);

// ── Action button ─────────────────────────────────────────────────────────────
const Btn: Component<{
  onClick?: () => void; href?: string; danger?: boolean;
  disabled?: boolean; loading?: boolean; title?: string; children: any;
}> = (p) => {
  const cls = `rounded-md px-2.5 py-1 text-xs transition-colors disabled:opacity-30 ${
    p.danger
      ? "bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20"
      : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100"
  }`;
  return p.href
    ? <a href={p.href} class={cls} title={p.title}>{p.children}</a>
    : <button class={cls} onClick={p.onClick} disabled={p.disabled || p.loading} title={p.title}>
        {p.loading ? <span class="inline-block animate-spin">↺</span> : p.children}
      </button>;
};

function fmtTime(unix: number): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function fmtBytes(b: number): string {
  if (!b) return "—";
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(0)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtSince(isoStr: string | undefined, now: number, suffix = ""): string {
  if (!isoStr || isoStr.startsWith("0001")) return "";
  const sec = Math.floor((now - new Date(isoStr).getTime()) / 1000);
  if (sec < 0) return "";
  let s: string;
  if (sec < 60) s = `${sec}s`;
  else if (sec < 3600) s = `${Math.floor(sec / 60)}m`;
  else if (sec < 86400) s = `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  else s = `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
  return suffix ? `${s} ${suffix}` : s;
}

// ── Main page ─────────────────────────────────────────────────────────────────
export const ContainerDetailPage: Component = () => {
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const id = () => params.id;
  const tab = () => (searchParams.tab as Tab) || "info";
  const setTab = (t: Tab) => setSearchParams({ tab: t }, { replace: true });
  // Auto-redirect to info when current tab requires running but container is stopped
  createEffect(() => {
    const cur = TABS.find((t) => t.key === tab());
    if (cur?.requiresRunning && state() !== "running") setTab("info");
  });

  const [inspect, { refetch }] = createResource(id, (i) =>
    get<any>(`/api/containers/${i}/inspect`)
  );

  const [networks] = createResource(() => get<NetworkSummary[]>("/api/networks"));
  const [runCmd, setRunCmd] = createSignal<string>("");
  const [showCmdModal, setShowCmdModal] = createSignal(false);
  const [showUpgrade, setShowUpgrade] = createSignal(false);
  const [upgradeLog, setUpgradeLog] = createSignal("");
  const [upgrading, setUpgrading] = createSignal(false);
  let upgradeLogEl: HTMLPreElement | undefined;

  const cfg  = () => inspect()?.Config ?? {};
  const host = () => inspect()?.HostConfig ?? {};
  const name = () => (inspect()?.Name ?? id()).replace(/^\//, "");
  const state = () => inspect()?.State?.Status ?? "unknown";
  const running = () => state() === "running";

  const [now, setNow] = createSignal(Date.now());
  onMount(() => { const t = setInterval(() => setNow(Date.now()), 1000); onCleanup(() => clearInterval(t)); });

  // ── Actions ──────────────────────────────────────────────────────────────────
  const [pending, setPending] = createSignal<Set<string>>(new Set());
  const isP = (v: string) => pending().has(v);

  const act = async (verb: string) => {
    setPending((p) => { const n = new Set(p); n.add(verb); return n; });
    try {
      await post(`/api/containers/${id()}/${verb}`);
      await refetch();
      toast.success(`${verb} 完成`);
    } catch (e) { toast.error((e as Error).message); }
    finally { setPending((p) => { const n = new Set(p); n.delete(verb); return n; }); }
  };

  const openCmdModal = async () => {
    try {
      const imageId = (inspect()?.Image as string) ?? "";
      let imgInspect = {};
      if (imageId) {
        try { imgInspect = await get(imageInspectUrl(imageId)); } catch { /**/ }
      }
      setRunCmd(inspectToRunCmd(inspect(), imgInspect));
      setShowCmdModal(true);
    } catch (e) { toast.error((e as Error).message); }
  };

  const doUpgrade = async () => {
    setUpgradeLog(""); setUpgrading(true); setShowUpgrade(true);
    try {
      const resp = await fetch(`/api/containers/${id()}/upgrade`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken() ?? ""}` },
      });
      const reader = resp.body!.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        setUpgradeLog((l) => l + dec.decode(value));
        if (upgradeLogEl) upgradeLogEl.scrollTop = upgradeLogEl.scrollHeight;
      }
      await refetch();
    } catch (e) {
      setUpgradeLog((l) => l + "\nERROR: " + (e as Error).message);
    } finally {
      setUpgrading(false);
    }
  };

  // ── Inline resource save ──────────────────────────────────────────────────────
  const saveResources = async (patch: Record<string, unknown>) => {
    const mem = patch.Memory;
    if (typeof mem === "number" && mem > 0 && mem < 6 * 1024 * 1024) {
      toast.error("内存最小限制为 6 MB");
      return;
    }
    try {
      const h = host();
      const base = {
        Memory: h?.Memory ?? 0,
        MemorySwap: h?.MemorySwap ?? 0,
        CpuQuota: h?.CpuQuota ?? 0,
        CpuPeriod: h?.CpuPeriod ?? 0,
        CpuShares: h?.CpuShares ?? 0,
        RestartPolicy: h?.RestartPolicy ?? { Name: "no", MaximumRetryCount: 0 },
      };
      const merged = { ...base, ...patch };
      await put(`/api/containers/${id()}/resources`, merged);
      await new Promise((r) => setTimeout(r, 250));
      await refetch();
      toast.success("已更新");
    } catch (e) { toast.error((e as Error).message); }
  };

  const saveName = async (v: string) => {
    try {
      await post(`/api/containers/${id()}/rename`, { name: v });
      await refetch();
    } catch (e) { toast.error((e as Error).message); }
  };

  // ── File actions ──────────────────────────────────────────────────────────────
  const listFiles = (sub: string) =>
    get<FileEntry[]>(`/api/containers/${id()}/files?path=${encodeURIComponent(sub)}`);
  const downloadURL = (sub: string) =>
    `/api/containers/${id()}/files/download?path=${encodeURIComponent(sub)}&token=${encodeURIComponent(getToken() ?? "")}`;
  const uploadFile = async (sub: string, file: File) => {
    const res = await fetch(`/api/containers/${id()}/files/upload?path=${encodeURIComponent(sub)}`, {
      method: "POST", headers: { Authorization: `Bearer ${getToken()}` }, body: file,
    });
    if (res.status === 401) { setToken(null); window.dispatchEvent(new CustomEvent("phyless:unauthorized")); return; }
    if (!res.ok) throw new Error(await res.text());
  };
  const deleteFile = async (path: string) => {
    await del(`/api/containers/${id()}/files?path=${encodeURIComponent(path)}`);
  };
  const renameFile = async (oldPath: string, newPath: string) => {
    await post(`/api/containers/${id()}/files/rename`, { old_path: oldPath, new_path: newPath });
  };

  // ── Network actions ────────────────────────────────────────────────────────────
  const [netDlg, setNetDlg] = createSignal(false);
  const doConnectNet = async (netName: string) => {
    try {
      await post(`/api/networks/${encodeURIComponent(netName)}/connect`, { container: id() });
      await refetch();
      toast.success("已连接");
    } catch (e) { toast.error((e as Error).message); }
  };
  const doDisconnectNet = async (netName: string) => {
    try {
      await post(`/api/networks/${encodeURIComponent(netName)}/disconnect`, { container: id(), force: false });
      await refetch();
      toast.success("已断开");
    } catch (e) { toast.error((e as Error).message); }
  };

  const fileInitialPath = () => searchParams.path || "/";
  const onFilePathChange = (p: string) => setSearchParams({ tab: "files", path: p }, { replace: true });

  return (
    <div class="flex flex-col gap-4">

      {/* ── Back ────────────────────────────────────────────────────────────── */}
      <div>
        <button class="text-xs text-zinc-500 hover:text-zinc-300 transition-colors" onClick={() => navigate(-1)}>← 返回</button>
      </div>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <Show when={inspect()} fallback={<p class="text-xs text-zinc-400">加载中…</p>}>
        <div>
          <div class="flex items-baseline gap-3">
            <h1 class={`font-mono text-xl font-medium ${STATE_COLOR[state()] ?? "text-zinc-300"}`}>
              {name()}
            </h1>
            <span class="font-mono text-xs text-zinc-400">{id().slice(0, 12)}</span>
            <span class="text-xs text-zinc-400">{state()}</span>
            <Show when={inspect()?.State?.Health?.Status}>
              {(h) => <span class="text-xs text-zinc-400">· {h()}</span>}
            </Show>
          </div>
          <p class="mt-0.5 font-mono text-[11px] text-zinc-400">{cfg().Image}</p>
        </div>

        {/* Action strip */}
        <Show when={hasRole("operator")}>
          <div class="flex flex-wrap items-center gap-1.5">
            <Show when={!running()}>
              <Btn loading={isP("start")} onClick={() => void act("start")}>▶ 启动</Btn>
            </Show>
            <Show when={running()}>
              <Btn loading={isP("stop")} onClick={() => void act("stop")}>■ 停止</Btn>
            </Show>
            <Btn loading={isP("restart")} onClick={() => void act("restart")}>↺ 重启</Btn>
            <Btn loading={isP("kill")} danger onClick={() => void act("kill")}>✕ 强制关闭</Btn>
            <span class="text-zinc-400">│</span>
            <Btn onClick={() => {
              window.open(`/api/containers/${id()}/export?token=${encodeURIComponent(getToken() ?? "")}`, "_blank");
            }}>↓ 导出 tar</Btn>
            <Btn onClick={() => void doUpgrade()}>⇡ 升级</Btn>
            <Btn onClick={() => void openCmdModal()}>⧉ Run/Compose</Btn>
            <span class="text-zinc-400">│</span>
            <Btn danger onClick={async () => {
              if (!confirm(`删除容器 ${name()}?`)) return;
              try { await del(`/api/containers/${id()}`); history.back(); }
              catch (e) { toast.error((e as Error).message); }
            }}>⊖ 移除</Btn>
          </div>
        </Show>
      </Show>

      {/* ── Tabs ────────────────────────────────────────────────────────────── */}
      <div class="flex gap-1 border-b border-zinc-800">
        <For each={TABS}>
          {(t) => {
            const disabled = () => !!t.requiresRunning && state() !== "running";
            return (
              <button
                disabled={disabled()}
                class={`rounded-t-md px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
                  tab() === t.key
                    ? "bg-zinc-800 text-zinc-100 font-medium"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
                }`}
                onClick={() => !disabled() && setTab(t.key)}
              >{t.label}</button>
            );
          }}
        </For>
      </div>

      {/* ── Tab: 基本信息 ──────────────────────────────────────────────────── */}
      <Show when={tab() === "info" && inspect()}>
        <div class="max-w-2xl">
          <dl class="space-y-0.5">
            {/* ── Single-value rows ── */}
            <Sec noLine>标识</Sec>
            <EditableKV k="名称" value={name()} onSave={saveName} />
            <KV k="ID"><span class="select-all truncate block" title={id()}>{id()}</span></KV>
            <KV k="镜像">
              <span class="break-all" title={inspect()?.Image}>{cfg().Image}</span>
              <Show when={inspect()?.Image}>
                <span class="ml-2 text-zinc-500">{inspect()!.Image!.replace(/^sha256:/, "").slice(0, 12)}</span>
              </Show>
            </KV>
            <KV k="状态">
              <span class={STATE_COLOR[state()] ?? "text-zinc-300"}>{STATE_ZH[state()] ?? state()}</span>
              <Show when={running() && inspect()?.State?.StartedAt}>
                <span class="ml-2 text-zinc-500">· {fmtSince(inspect()?.State?.StartedAt, now())}</span>
              </Show>
              <Show when={!running() && state() === "exited" && inspect()?.State?.FinishedAt}>
                <span class="ml-2 text-zinc-500">· {fmtSince(inspect()?.State?.FinishedAt, now(), "前")}</span>
              </Show>
              <Show when={inspect()?.State?.Health?.Status}>
                {(h) => <span class="ml-2 text-zinc-500">· {h()}</span>}
              </Show>
            </KV>
            <KV k="创建时间">{fmtTime(Math.floor(new Date(inspect()?.Created ?? 0).getTime() / 1000))}</KV>
            <KV k="重启策略">
              <select
                class="bg-transparent font-mono text-xs text-zinc-200 outline-none cursor-pointer hover:text-zinc-100 appearance-none border-b border-dashed border-zinc-600 hover:border-zinc-400 transition-colors"
                value={host()?.RestartPolicy?.Name ?? "no"}
                onChange={(e) => void saveResources({ RestartPolicy: { Name: e.currentTarget.value, MaximumRetryCount: 0 } })}
              >
                <option value="no">no</option>
                <option value="always">always</option>
                <option value="unless-stopped">unless-stopped</option>
                <option value="on-failure">on-failure</option>
              </select>
            </KV>
            <KV k="主机名">{cfg().Hostname || <span class="text-zinc-600">—</span>}</KV>
            <Show when={(host()?.Dns ?? []).length > 0}>
              <KV k="DNS">{(host().Dns as string[]).join(", ")}</KV>
            </Show>
            <Show when={cfg().User}>
              <KV k="用户">{cfg().User}</KV>
            </Show>
            <Show when={cfg().WorkingDir}>
              <KV k="工作目录">{cfg().WorkingDir}</KV>
            </Show>
            <Show when={(cfg().Cmd ?? []).length > 0}>
              <KV k="CMD">{(cfg().Cmd as string[]).join(" ")}</KV>
            </Show>
            <Show when={(cfg().Entrypoint ?? []).length > 0}>
              <KV k="ENTRYPOINT">{(cfg().Entrypoint as string[]).join(" ")}</KV>
            </Show>

            <Sec>资源</Sec>
            <Show
              when={hasRole("operator") || host()?.Memory > 0 || host()?.CpuQuota > 0 || host()?.CpuShares > 0}
              fallback={<KV k="资源限制"><span class="text-zinc-500">全部无限制</span></KV>}
            >
              <EditableKV k="内存 (MB)" clearable
                value={host()?.Memory > 0 ? `${Math.round(host().Memory / 1024 / 1024)}` : ""}
                placeholder="无限制"
                type="number"
                title="容器可使用的最大内存（MB）。超出后进程会被 OOM 强制终制。×清除=同时重置 Swap 为无限制"
                onSave={(v) => {
                  const patch: Record<string, unknown> = { Memory: v ? Number(v) * 1024 * 1024 : -1 };
                  if (!v) patch.MemorySwap = -1; // clearing memory must also clear swap (kernel constraint)
                  return saveResources(patch);
                }}
              />
              <EditableKV k="内存+Swap (MB)" clearable
                value={host()?.MemorySwap > 0 ? `${Math.round(host().MemorySwap / 1024 / 1024)}` : ""}
                placeholder="默认 (2×内存)"
                type="number"
                title="内存+Swap 合计上限（MB），需大于内存限制。-1=无限 Swap。×清除=无限制"
                onSave={(v) => saveResources({ MemorySwap: v ? (Number(v) === -1 ? -1 : Number(v) * 1024 * 1024) : -1 })}
              />
              <EditableKV k="CPU Quota (μs)" clearable
                value={host()?.CpuQuota > 0 ? String(host().CpuQuota) : ""}
                placeholder="无限制"
                type="number"
                title="每个调度周期内容器最多使用的 CPU 时间（微秒）。如 50000 / 100000 Period = 50% CPU。×清除=无限制"
                onSave={(v) => saveResources({ CpuQuota: v ? Number(v) : -1 })}
              />
              <EditableKV k="CPU Period (μs)" clearable
                value={host()?.CpuPeriod > 0 ? String(host().CpuPeriod) : ""}
                placeholder="100000"
                type="number"
                title="CPU 调度周期长度（微秒），默认 100000（100ms）。×清除=默认值"
                onSave={(v) => saveResources({ CpuPeriod: v ? Number(v) : 100000 })}
              />
              <EditableKV k="CPU 权重" clearable
                value={host()?.CpuShares > 0 ? String(host().CpuShares) : ""}
                placeholder="1024"
                type="number"
                title="相对 CPU 权重，默认 1024。多容器竞争时，权重越高分得越多 CPU 时间。×清除=默认"
                onSave={(v) => saveResources({ CpuShares: v ? Number(v) : 1024 })}
              />
            </Show>
            {/* ── List sections at bottom: 挂载 > 端口 > 网络 > 环境变量 > CAP > Devices > Sysctls > ExtraHosts > 标签 ── */}
            <Show when={(inspect()?.Mounts ?? []).length > 0}>
              <Sec>挂载</Sec>
              <div class="space-y-px pb-1 pl-[7.75rem] font-mono text-xs">
                <For each={inspect()?.Mounts ?? []}>
                  {(m: any) => (
                    <div class="break-all">
                      <span class="text-zinc-500">{m.Source || m.Name}</span>
                      <span class="text-zinc-600"> → </span>
                      <button
                        class="text-zinc-300 hover:text-sky-400 transition-colors"
                        onClick={() => setSearchParams({ tab: "files", path: m.Destination }, { replace: true })}
                      >{m.Destination}</button>
                      <Show when={m.Mode && m.Mode !== "rw"}>
                        <span class="text-zinc-600">:{m.Mode}</span>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <Show when={Object.keys(host()?.PortBindings ?? {}).length > 0}>
              <Sec>端口</Sec>
              <div class="space-y-px pb-1 pl-[7.75rem] font-mono text-xs">
                <For each={Object.entries(host()?.PortBindings ?? {})}>
                  {([cPort, bindings]) => (
                    <For each={bindings as any[]}>
                      {(b) => (
                        <div>
                          <span class="text-zinc-500">{cPort}</span>
                          <span class="text-zinc-600">: </span>
                          <a
                            class="text-zinc-300 hover:text-indigo-400 transition-colors"
                            href={`http://${location.hostname}:${b.HostPort}`}
                            target="_blank" rel="noopener"
                          >{b.HostIp && b.HostIp !== "0.0.0.0" ? `${b.HostIp}:` : ""}{b.HostPort}</a>
                        </div>
                      )}
                    </For>
                  )}
                </For>
              </div>
            </Show>

            <Sec>网络</Sec>
            <div class="space-y-px pb-1 pl-[7.75rem] font-mono text-xs">
              <For each={Object.entries(inspect()?.NetworkSettings?.Networks ?? {})}>
                {([netName, net]: [string, any]) => (
                  <div class="flex items-center gap-2">
                    <span class="text-zinc-500">{netName}:</span>
                    <span class="text-zinc-300">{net.IPAddress || "—"}</span>
                    <Show when={hasRole("operator")}>
                      <button class="text-[11px] text-zinc-500 hover:text-red-500 transition-colors" onClick={() => void doDisconnectNet(netName)}>断开</button>
                    </Show>
                  </div>
                )}
              </For>
              <Show when={hasRole("operator")}>
                <button
                  class="text-[11px] text-zinc-500 hover:text-zinc-200 transition-colors"
                  onClick={() => setNetDlg(true)}
                >+ 新连接</button>
              </Show>
            </div>

            {/* ── Network connect dialog ── */}
            <Show when={netDlg()}>
              {(() => {
                const connected = new Set(Object.keys(inspect()?.NetworkSettings?.Networks ?? {}));
                const available = (networks() ?? []).filter(
                  (n) => !connected.has(n.Name) && n.Name !== "none" && n.Name !== "ingress"
                );
                return (
                  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setNetDlg(false)}>
                    <div class="w-64 rounded border border-zinc-700 bg-zinc-900 p-4" onClick={(e) => e.stopPropagation()}>
                      <div class="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">连接到网络</div>
                      <Show when={available.length > 0} fallback={<p class="text-xs text-zinc-500">无可用网络</p>}>
                        <div class="flex flex-wrap gap-1.5">
                          <For each={available}>
                            {(n) => (
                              <button
                                class="border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:border-indigo-500 hover:bg-indigo-600/20 hover:text-indigo-300 transition-colors"
                                onClick={() => { void doConnectNet(n.Name); setNetDlg(false); }}
                              >{n.Name}</button>
                            )}
                          </For>
                        </div>
                      </Show>
                      <button class="mt-3 w-full border border-zinc-700 py-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors" onClick={() => setNetDlg(false)}>取消</button>
                    </div>
                  </div>
                );
              })()}
            </Show>

            <Show when={(cfg().Env ?? []).length > 0}>
              <Sec>环境变量</Sec>
              <div class="space-y-px pb-1 pl-[7.75rem] font-mono text-xs">
                <For each={cfg().Env as string[]}>
                  {(e) => {
                    const eq = e.indexOf("=");
                    const k = eq >= 0 ? e.slice(0, eq) : e;
                    const v = eq >= 0 ? e.slice(eq + 1) : "";
                    return (
                      <div class="break-all">
                        <span class="text-zinc-500">{k}</span>
                        <span class="text-zinc-600">=</span>
                        <span class="text-zinc-300">{v}</span>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>

            <Show when={(host()?.CapAdd ?? []).length > 0}>
              <Sec>CAP ADD</Sec>
              <div class="flex flex-wrap gap-1 pb-1 pl-[7.75rem]">
                <For each={host().CapAdd as string[]}>
                  {(c) => <span class="border border-zinc-700 px-2 py-0.5 font-mono text-[11px] text-zinc-300">{c}</span>}
                </For>
              </div>
            </Show>

            <Show when={(host()?.CapDrop ?? []).length > 0}>
              <Sec>CAP DROP</Sec>
              <div class="flex flex-wrap gap-1 pb-1 pl-[7.75rem]">
                <For each={host().CapDrop as string[]}>
                  {(c) => <span class="border border-zinc-700 px-2 py-0.5 font-mono text-[11px] text-zinc-300">{c}</span>}
                </For>
              </div>
            </Show>

            <Show when={(host()?.Devices ?? []).length > 0}>
              <Sec>设备</Sec>
              <div class="space-y-px pb-1 pl-[7.75rem] font-mono text-xs">
                <For each={host().Devices as any[]}>
                  {(d) => (
                    <div class="break-all">
                      <span class="text-zinc-500">{d.PathOnHost}</span>
                      <span class="text-zinc-600"> → </span>
                      <span class="text-zinc-300">{d.PathInContainer}</span>
                      <Show when={d.CgroupPermissions && d.CgroupPermissions !== "rwm"}>
                        <span class="text-zinc-600">:{d.CgroupPermissions}</span>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <Show when={Object.keys(host()?.Sysctls ?? {}).length > 0}>
              <Sec>Sysctls</Sec>
              <div class="space-y-px pb-1 pl-[7.75rem] font-mono text-xs">
                <For each={Object.entries(host().Sysctls as Record<string, string>)}>
                  {([k, v]) => (
                    <div class="break-all">
                      <span class="text-zinc-500">{k}</span>
                      <span class="text-zinc-600">=</span>
                      <span class="text-zinc-300">{v}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <Show when={(host()?.ExtraHosts ?? []).length > 0}>
              <Sec>ExtraHosts</Sec>
              <div class="space-y-px pb-1 pl-[7.75rem] font-mono text-xs">
                <For each={host().ExtraHosts as string[]}>
                  {(h) => <div class="text-zinc-300">{h}</div>}
                </For>
              </div>
            </Show>

            <Show when={Object.entries(cfg()?.Labels ?? {}).filter(([k]) => !k.startsWith("com.docker.compose.")).length > 0}>
              <Sec>标签</Sec>
              <div class="space-y-px pb-1 pl-[7.75rem] font-mono text-xs">
                <For each={Object.entries(cfg().Labels ?? {}).filter(([k]) => !k.startsWith("com.docker.compose."))}>
                  {([k, v]) => (
                    <div class="break-all">
                      <span class="text-zinc-500">{k}</span>
                      <span class="text-zinc-600">=</span>
                      <span class="text-zinc-300">{v as string}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </dl>
        </div>
      </Show>

      {/* ── Tab: 状态 ──────────────────────────────────────────────────────── */}
      <Show when={tab() === "stats"}>
        <ContainerStats id={id()} />
      </Show>

      {/* ── Tab: 文件 ──────────────────────────────────────────────────────── */}
      <Show when={tab() === "files"}>
        <FileBrowser
          listPath={listFiles}
          downloadURL={downloadURL}
          onUpload={hasRole("operator") ? uploadFile : undefined}
          onDelete={hasRole("operator") ? deleteFile : undefined}
          onRename={hasRole("operator") ? renameFile : undefined}
          initialPath={fileInitialPath()}
          onPathChange={onFilePathChange}
        />
      </Show>

      {/* ── Tab: 控制台 ────────────────────────────────────────────────────── */}
      <Show when={tab() === "console"}>
        <Show when={hasRole("operator")} fallback={<p class="text-xs text-zinc-400">需要 operator 权限</p>}>
          <ContainerTerminal id={id()} />
        </Show>
      </Show>

      {/* ── Tab: 日志 ──────────────────────────────────────────────────────── */}
      <Show when={tab() === "logs"}>
        <ContainerLogs id={id()} running={running()} />
      </Show>

      {/* ── Tab: Inspect ──────────────────────────────────────────────────── */}
      <Show when={tab() === "inspect"}>
        <pre class="max-h-[75vh] overflow-auto bg-zinc-950 p-4 font-mono text-xs text-zinc-400 leading-5">
          {JSON.stringify(inspect(), null, 2)}
        </pre>
      </Show>

      {/* ── Run/Compose modal (reuse CreateContainerModal) ────────────────── */}
      <Show when={showCmdModal()}>
        <CreateContainerModal
          open
          onClose={() => setShowCmdModal(false)}
          onCreated={() => { setShowCmdModal(false); void refetch(); }}
          initialRun={runCmd()}
        />
      </Show>

      {/* ── Upgrade modal ─────────────────────────────────────────────────── */}
      <Show when={showUpgrade()}>
        <Modal open title={`升级 — ${name()}`} onClose={() => { if (!upgrading()) setShowUpgrade(false); }}>
          <pre
            ref={upgradeLogEl}
            class="max-h-[60vh] min-h-[8rem] overflow-auto rounded-md bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-300 whitespace-pre-wrap"
          >{upgradeLog() || "准备中…"}</pre>
          <div class="mt-3 flex items-center justify-between">
            <span class="text-xs text-zinc-500">{upgrading() ? "升级中，请稍候…" : "已完成"}</span>
            <Btn onClick={() => setShowUpgrade(false)} disabled={upgrading()}>关闭</Btn>
          </div>
        </Modal>
      </Show>
    </div>
  );
};
