import { Component, createSignal, onMount, onCleanup, Show, For } from "solid-js";
import { createResourceStore } from "../../stores/resource";
import { get, imageInspectUrl } from "../../api/client";
import { inspectToRunCmd } from "../../api/inspect";
import { hasRole } from "../../stores/auth";
import { createContainerActions, containerName } from "./containerActions";
import { CreateContainerModal } from "./CreateContainerModal";
import { ConsoleModal } from "./ConsoleModal";
import { ViewCmdModal } from "./ViewCmdModal";
import { ContainerRow, ContainerRowHeader } from "./ContainerRow";
import { UpgradeContainerModal } from "./UpgradeContainerModal";
import { ImportContainerModal } from "./ImportContainerModal";
import { Btn } from "../shared/ActionButton";
import { confirmAction } from "../shared/ConfirmModal";
import { ComposeIcon } from "../compose/composeShared";
import { createListView, SearchBox, LoadMore } from "../shared/ListView";
import type { ContainerSummary } from "../../types";

const DEFAULT_BULK_RUN = "docker run -d --name my-container nginx:latest";

// ── Main page ──────────────────────────────────────────────────────────────────
export const ContainerListPage: Component = () => {
  const store = createResourceStore<ContainerSummary>("/api/containers");
  const { isP, act } = createContainerActions();
  const view = createListView(store.items, (c) =>
    `${c.Names.join(" ")} ${c.Image} ${c.Id} ${c.Status}`);
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [showCreate, setShowCreate] = createSignal(false);
  const [showImport, setShowImport] = createSignal(false);
  const [runTarget, setRunTarget] = createSignal<{ id: string; name: string } | null>(null);
  const [consoleTarget, setConsoleTarget] = createSignal<{ id: string; name: string } | null>(null);
  const [upgradeTarget, setUpgradeTarget] = createSignal<{ id: string; name: string } | null>(null);
  // Bulk Run/Compose no longer opens a separate read-only viewer — it feeds
  // the same CreateContainerModal used for "+新建容器", which detects (from
  // the compose.yaml content itself) whether this is one service or many
  // and switches between "创建容器" and "注册 Compose" accordingly.
  const [bulkRunText, setBulkRunText] = createSignal<string | null>(null);

  onMount(() => store.startPolling());
  onCleanup(() => store.stopPolling());

  const toggle = (id: string) =>
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = (v: boolean) =>
    setSelected(v ? new Set<string>(view.filtered().map((c) => c.Id)) : new Set<string>());

  const bulk = (verb: "start" | "stop" | "pause" | "delete") => {
    const byId = new Map(store.items().map((c) => [c.Id, containerName(c)]));
    for (const id of selected()) void act(id, verb, byId.get(id));
    setSelected(new Set<string>());
  };

  const bulkRun = async () => {
    const ids = [...selected()];
    if (ids.length === 0) { setBulkRunText(DEFAULT_BULK_RUN); return; }
    const cmds = await Promise.all(ids.map(async (id) => {
      const container = await get<any>(`/api/containers/${id}/inspect`);
      let image: any = {};
      try { image = await get<any>(imageInspectUrl(container.Image)); } catch { /* ignore */ }
      return inspectToRunCmd(container, image);
    }));
    setBulkRunText(cmds.join("\n\n"));
  };

  const n = () => selected().size;
  const allSel = () => view.filtered().length > 0 && n() === view.filtered().length;
  const confirmBulkDelete = async () => {
    const count = n();
    if (count && await confirmAction(`删除选中的 ${count} 个容器？`, { title: "删除容器", confirmText: "删除", danger: true })) bulk("delete");
  };

  return (
    <div class="flex flex-col gap-3">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div class="flex items-center justify-between">
        <h1 class="text-lg font-semibold">容器</h1>
        <Show when={hasRole("operator")}>
          <div class="flex items-center gap-2">
            <button
              class="rounded-md border border-zinc-600 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-zinc-400 hover:text-zinc-100"
              onClick={() => setShowImport(true)}
            >
              导入容器
            </button>
            <button
              class="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
              onClick={() => setShowCreate(true)}
            >
              + 新建容器
            </button>
          </div>
        </Show>
      </div>

      <SearchBox value={view.query()} onInput={view.setQuery} placeholder="搜索容器…" />

      {/* ── Bulk bar ────────────────────────────────────────────────────────── */}
      <div class="flex flex-wrap items-center gap-1.5 border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs">
        <input type="checkbox" checked={allSel()} onChange={(e) => toggleAll(e.currentTarget.checked)} />
        <span class="min-w-[4rem] text-zinc-500">{n() > 0 ? `${n()} 已选` : "全选"}</span>

        <Show when={hasRole("operator")}>
          <span class="text-zinc-400">│</span>
          <Btn title="启动选中容器" disabled={n() === 0} onClick={() => void bulk("start")}>▶ 启动</Btn>
          <Btn title="停止选中容器" disabled={n() === 0} onClick={() => void bulk("stop")}>■ 停止</Btn>
          <Btn title="暂停选中容器" disabled={n() === 0} onClick={() => void bulk("pause")}>⏸ 暂停</Btn>
          <Btn title="删除选中容器" danger disabled={n() === 0} onClick={() => void confirmBulkDelete()}>⊖ 删除</Btn>
        </Show>

        <span class="text-zinc-400">│</span>
        <Btn title="基于选中容器创建容器 / 注册 Compose" onClick={() => void bulkRun()}>
          <span class="inline-flex items-center gap-1"><ComposeIcon size={14} /> Run/Compose</span>
        </Btn>

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
          <For each={view.visible()}>
            {(c) => (
              <ContainerRow
                c={c}
                selected={selected().has(c.Id)}
                onToggleSelect={() => toggle(c.Id)}
                isP={isP}
                act={act}
                onViewCmd={setRunTarget}
                onConsole={setConsoleTarget}
                onUpgrade={setUpgradeTarget}
              />
            )}
          </For>
          <LoadMore when={view.hasMore()} onMore={view.loadMore} />
        </div>

        <Show when={view.filtered().length === 0 && !store.error()}>
          <div class="py-16 text-center text-zinc-400">
            {store.items().length === 0 ? "暂无容器" : "无匹配结果"}
          </div>
        </Show>
      </div>

      {/* ── Run/Compose modal (per-row Compose button — single container only) ── */}
      <ViewCmdModal target={runTarget()} onClose={() => setRunTarget(null)} />
      <ConsoleModal target={consoleTarget()} onClose={() => setConsoleTarget(null)} />
      <UpgradeContainerModal target={upgradeTarget()} onClose={() => setUpgradeTarget(null)} />

      {/* ── Create container modal ───────────────────────────────────────────── */}
      <CreateContainerModal
        open={showCreate()}
        onClose={() => setShowCreate(false)}
      />

      {/* ── Bulk Run/Compose modal — same component, fed the selected
          containers' merged run commands ────────────────────────────────── */}
      <CreateContainerModal
        open={bulkRunText() !== null}
        initialRun={bulkRunText() ?? undefined}
        onClose={() => setBulkRunText(null)}
      />

      {/* ── Import container (tar → image) modal ─────────────────────────────── */}
      <ImportContainerModal open={showImport()} onClose={() => setShowImport(false)} />
    </div>
  );
};
