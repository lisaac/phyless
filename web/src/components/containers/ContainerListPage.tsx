import { Component, createSignal, onMount, onCleanup, Show, For, JSX } from "solid-js";
import { useNavigate, A } from "@solidjs/router";
import { createResourceStore } from "../../stores/resource";
import { post, del } from "../../api/client";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import { containerName } from "./containerActions";
import { CreateContainerModal } from "./CreateContainerModal";
import type { ContainerSummary } from "../../types";

// ── Inline SVG icon set ───────────────────────────────────────────────────────
const Ico = (props: { path: string; title?: string; size?: number }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    width={props.size ?? 14}
    height={props.size ?? 14}
    aria-label={props.title}
  >
    <path d={props.path} />
  </svg>
);

// Icon button with tooltip + loading state
const IBtn = (props: {
  title: string;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
  danger?: boolean;
  children: JSX.Element;
}) => (
  <button
    title={props.title}
    disabled={props.loading || props.disabled}
    onClick={(e) => { e.stopPropagation(); props.onClick(); }}
    class={`inline-flex h-6 w-6 items-center justify-center rounded transition-colors disabled:opacity-30 ${
      props.danger
        ? "text-zinc-400 hover:bg-red-900/40 hover:text-red-400"
        : "text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
    }`}
  >
    {props.loading
      ? <span class="animate-spin text-xs">↺</span>
      : props.children}
  </button>
);

// ── Status badge ──────────────────────────────────────────────────────────────
const STATE_STYLE: Record<string, string> = {
  running:    "bg-green-500/15 text-green-400",
  paused:     "bg-yellow-500/15 text-yellow-400",
  restarting: "bg-blue-500/15 text-blue-400",
  exited:     "bg-zinc-500/15 text-zinc-400",
  dead:       "bg-red-500/15 text-red-400",
  created:    "bg-zinc-500/15 text-zinc-400",
};

const StateBadge: Component<{ state: string; status: string }> = (props) => (
  <span class={`inline-block max-w-[9rem] truncate rounded-full px-2 py-0.5 text-xs font-medium ${STATE_STYLE[props.state] ?? "bg-zinc-500/15 text-zinc-400"}`}>
    {props.status}
  </span>
);

// ── Port / Network / Mount formatters ─────────────────────────────────────────
function fmtPorts(c: ContainerSummary): string {
  const seen = new Set<string>();
  return c.Ports
    .filter((p) => p.PublicPort)
    .map((p) => {
      const s = p.IP && p.IP !== "0.0.0.0" ? `${p.IP}:${p.PublicPort}→${p.PrivatePort}` : `${p.PublicPort}→${p.PrivatePort}`;
      return seen.has(s) ? null : (seen.add(s), s);
    })
    .filter(Boolean)
    .join("\n");
}

function fmtNets(c: ContainerSummary): string {
  const nets = Object.keys(c.NetworkSettings?.Networks ?? {});
  return nets.join(", ");
}

function fmtMounts(c: ContainerSummary): string {
  return c.Mounts
    .filter((m) => m.Type !== "volume" || m.Source)
    .slice(0, 4)
    .map((m) => {
      const src = m.Source.length > 28 ? "…" + m.Source.slice(-26) : m.Source;
      const ro = m.Mode?.includes("ro") ? " (ro)" : "";
      return `${src} → ${m.Destination}${ro}`;
    })
    .join("\n");
}

// ── Main page ─────────────────────────────────────────────────────────────────
export const ContainerListPage: Component = () => {
  const navigate = useNavigate();
  const store = createResourceStore<ContainerSummary>("/api/containers");
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [showCreate, setShowCreate] = createSignal(false);
  // Track in-flight actions: "id:verb" → true
  const [pending, setPending] = createSignal<Set<string>>(new Set());

  onMount(() => store.startPolling());
  onCleanup(() => store.stopPolling());

  // ── Selection ───────────────────────────────────────────────────────────────
  const toggle = (key: string) =>
    setSelected((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const toggleAll = (checked: boolean) =>
    setSelected(checked ? new Set(store.items().map((c) => c.Id)) : new Set());

  // ── Action helpers ──────────────────────────────────────────────────────────
  const pKey = (id: string, verb: string) => `${id}:${verb}`;
  const isP = (id: string, verb: string) => pending().has(pKey(id, verb));
  const anyP = (id: string) => [...pending()].some((k) => k.startsWith(id + ":"));
  const mark = (id: string, verb: string, on: boolean) =>
    setPending((p) => { const n = new Set(p); on ? n.add(pKey(id, verb)) : n.delete(pKey(id, verb)); return n; });

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

  // ── Bulk toolbar (always visible) ───────────────────────────────────────────
  const BulkBar = () => {
    const n = () => selected().size;
    const allSelected = () => store.items().length > 0 && n() === store.items().length;
    return (
      <div class="mb-3 flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900 px-3 py-2">
        <input
          type="checkbox"
          checked={allSelected()}
          class="rounded"
          onChange={(e) => toggleAll(e.currentTarget.checked)}
        />
        <span class="min-w-[5rem] text-sm text-zinc-400">
          {n() > 0 ? `${n()} 已选中` : "全选"}
        </span>
        <Show when={hasRole("operator")}>
          <button
            class="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-green-900/30 hover:text-green-400 disabled:opacity-30"
            disabled={n() === 0}
            onClick={() => void bulk("start")}
          >▶ 启动</button>
          <button
            class="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-30"
            disabled={n() === 0}
            onClick={() => void bulk("stop")}
          >■ 停止</button>
          <button
            class="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-orange-900/30 hover:text-orange-400 disabled:opacity-30"
            disabled={n() === 0}
            onClick={() => void bulk("kill")}
          >✕ 强制关闭</button>
          <button
            class="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-red-900/30 hover:text-red-400 disabled:opacity-30"
            disabled={n() === 0}
            onClick={() => void bulk("delete")}
          >🗑 删除</button>
        </Show>
        {n() > 0 && (
          <button class="ml-auto text-xs text-zinc-500 hover:text-zinc-300" onClick={() => setSelected(new Set())}>清除</button>
        )}
      </div>
    );
  };

  return (
    <div>
      {/* Page header */}
      <div class="mb-3 flex items-center justify-between">
        <h1 class="text-xl font-semibold">容器</h1>
        <Show when={hasRole("operator")}>
          <button
            class="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium hover:bg-blue-500"
            onClick={() => setShowCreate(true)}
          >
            + 新建容器
          </button>
        </Show>
      </div>

      <BulkBar />

      <Show when={store.error()}>
        <p class="mb-2 text-sm text-red-400">{store.error()}</p>
      </Show>

      {/* Container table */}
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-zinc-800 text-xs uppercase text-zinc-500">
            <tr>
              <th class="w-8 px-2 py-2" />
              <th class="px-2 py-2">容器 / 镜像</th>
              <th class="px-2 py-2">状态</th>
              <th class="px-2 py-2">网络 / 端口</th>
              <th class="px-2 py-2">挂载</th>
              <th class="max-w-[12rem] px-2 py-2">命令</th>
              <th class="px-2 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            <For each={store.items()}>
              {(c) => {
                const name = containerName(c);
                const ports = fmtPorts(c);
                const nets = fmtNets(c);
                const mounts = fmtMounts(c);
                const running = () => c.State === "running";
                const paused = () => c.State === "paused";

                return (
                  <tr
                    class="border-b border-zinc-900 hover:bg-zinc-900/60"
                    onClick={() => navigate(`/containers/${c.Id}`)}
                    style={{ cursor: "pointer" }}
                  >
                    {/* Checkbox */}
                    <td class="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected().has(c.Id)}
                        onChange={() => toggle(c.Id)}
                      />
                    </td>

                    {/* Name / ID / Image */}
                    <td class="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                      <A
                        href={`/containers/${c.Id}`}
                        class="block font-medium text-zinc-100 hover:text-blue-400"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {name || <span class="text-zinc-500">(unnamed)</span>}
                      </A>
                      <div class="font-mono text-xs text-zinc-500">{c.Id.slice(0, 12)}</div>
                      <A
                        href="/images"
                        class="mt-0.5 block max-w-[14rem] truncate text-xs text-zinc-400 hover:text-blue-400"
                        title={c.Image}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {c.Image}
                      </A>
                    </td>

                    {/* State badge */}
                    <td class="px-2 py-2">
                      <StateBadge state={c.State} status={c.Status} />
                    </td>

                    {/* Networks + Ports */}
                    <td class="px-2 py-2">
                      <Show when={nets}>
                        <div class="mb-0.5 text-xs text-blue-400/80">{nets}</div>
                      </Show>
                      <Show when={ports}>
                        <div class="whitespace-pre font-mono text-xs text-zinc-400">{ports}</div>
                      </Show>
                      <Show when={!nets && !ports}>
                        <span class="text-xs text-zinc-600">—</span>
                      </Show>
                    </td>

                    {/* Mounts */}
                    <td class="px-2 py-2">
                      <Show when={mounts} fallback={<span class="text-xs text-zinc-600">—</span>}>
                        <div class="max-w-[16rem] whitespace-pre font-mono text-xs leading-4 text-zinc-400">
                          {mounts}
                        </div>
                      </Show>
                    </td>

                    {/* Command */}
                    <td class="max-w-[12rem] px-2 py-2">
                      <span
                        class="block max-w-[12rem] truncate font-mono text-xs text-zinc-500"
                        title={c.Command}
                      >
                        {c.Command || "—"}
                      </span>
                    </td>

                    {/* Actions — icon buttons */}
                    <td class="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                      <Show when={hasRole("operator")}>
                        <div class="flex items-center gap-0.5">
                          {/* Start / Stop / Pause / Unpause / Restart / Kill */}
                          <Show when={!running() && !paused()}>
                            <IBtn title="启动" loading={isP(c.Id, "start")} onClick={() => void act(c.Id, "start")}>
                              <Ico path="M5 3l14 9-14 9z" />
                            </IBtn>
                          </Show>
                          <Show when={paused()}>
                            <IBtn title="恢复" loading={isP(c.Id, "unpause")} onClick={() => void act(c.Id, "unpause")}>
                              <Ico path="M5 3l14 9-14 9z" />
                            </IBtn>
                          </Show>
                          <Show when={running()}>
                            <IBtn title="停止" loading={isP(c.Id, "stop")} onClick={() => void act(c.Id, "stop")}>
                              <Ico path="M3 3h18v18H3z" />
                            </IBtn>
                            <IBtn title="暂停" loading={isP(c.Id, "pause")} onClick={() => void act(c.Id, "pause")}>
                              <Ico path="M6 4h4v16H6M14 4h4v16h-4" />
                            </IBtn>
                            <IBtn title="重启" loading={isP(c.Id, "restart")} onClick={() => void act(c.Id, "restart")}>
                              <Ico path="M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
                            </IBtn>
                            <IBtn title="强制关闭" loading={isP(c.Id, "kill")} onClick={() => void act(c.Id, "kill")} danger>
                              <Ico path="M18 6L6 18M6 6l12 12" />
                            </IBtn>
                          </Show>

                          {/* Divider */}
                          <span class="mx-0.5 text-zinc-700">|</span>

                          {/* Detail */}
                          <IBtn title="详情" onClick={() => navigate(`/containers/${c.Id}`)}>
                            <Ico path="M5 12h14M12 5l7 7-7 7" />
                          </IBtn>

                          {/* Delete */}
                          <Show when={!running()}>
                            <IBtn title="删除" loading={isP(c.Id, "delete")} disabled={anyP(c.Id)} onClick={() => void act(c.Id, "delete")} danger>
                              <Ico path="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
                            </IBtn>
                          </Show>
                        </div>
                      </Show>
                      <Show when={!hasRole("operator")}>
                        <IBtn title="详情" onClick={() => navigate(`/containers/${c.Id}`)}>
                          <Ico path="M5 12h14M12 5l7 7-7 7" />
                        </IBtn>
                      </Show>
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>

        <Show when={store.items().length === 0 && !store.error()}>
          <div class="py-12 text-center text-zinc-500">暂无容器</div>
        </Show>
      </div>

      <CreateContainerModal
        open={showCreate()}
        onClose={() => setShowCreate(false)}
        onCreated={() => { setShowCreate(false); void store.refresh(); }}
      />
    </div>
  );
};
