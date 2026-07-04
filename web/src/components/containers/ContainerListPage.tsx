import { Component, createSignal, onMount, onCleanup, Show, For } from "solid-js";
import { createResourceStore } from "../../stores/resource";
import { hasRole } from "../../stores/auth";
import { containerName, createContainerActions } from "./containerActions";
import { CreateContainerModal } from "./CreateContainerModal";
import { BulkRunModal } from "./BulkRunModal";
import { ConsoleModal } from "./ConsoleModal";
import { ViewCmdModal } from "./ViewCmdModal";
import { ContainerRow, ContainerRowHeader } from "./ContainerRow";
import type { ContainerSummary } from "../../types";

// ── Main page ──────────────────────────────────────────────────────────────────
export const ContainerListPage: Component = () => {
  const store = createResourceStore<ContainerSummary>("/api/containers");
  const { isP, act } = createContainerActions(store.refresh);
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [showCreate, setShowCreate] = createSignal(false);
  const [runTarget, setRunTarget] = createSignal<{ id: string; name: string } | null>(null);
  const [consoleTarget, setConsoleTarget] = createSignal<{ id: string; name: string } | null>(null);
  const [bulkRunIds, setBulkRunIds] = createSignal<string[] | null>(null);

  onMount(() => store.startPolling());
  onCleanup(() => store.stopPolling());

  const toggle = (id: string) =>
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = (v: boolean) =>
    setSelected(v ? new Set(store.items().map((c) => c.Id)) : new Set());

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
            disabled={n() === 0}
            onClick={() => { if (confirm(`删除选中的 ${n()} 个容器？`)) void bulk("delete"); }}
          >⊖ 删除</button>
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

      {/* ── List (div-simulated table, so rows can be reused elsewhere — e.g.
          ComposeListPage's expanded project section) ───────────────────────── */}
      <div class="overflow-x-auto border border-zinc-800">
        <ContainerRowHeader />
        <div class="divide-y divide-zinc-800">
          <For each={store.items()}>
            {(c) => (
              <ContainerRow
                c={c}
                selected={selected().has(c.Id)}
                onToggleSelect={() => toggle(c.Id)}
                isP={isP}
                act={act}
                onViewCmd={setRunTarget}
                onConsole={setConsoleTarget}
              />
            )}
          </For>
        </div>

        <Show when={store.items().length === 0 && !store.error()}>
          <div class="py-16 text-center text-zinc-400">暂无容器</div>
        </Show>
      </div>

      {/* ── Run/Compose modal ───────────────────────────────────────────────── */}
      <ViewCmdModal target={runTarget()} onClose={() => setRunTarget(null)} />
      <ConsoleModal target={consoleTarget()} onClose={() => setConsoleTarget(null)} />
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
