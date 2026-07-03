import { Component, createSignal, createResource, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { get, post, del } from "../../api/client";
import { tags, refreshTags, createTag, updateTag, deleteTag, unbindTag } from "../../stores/tags";
import { toast } from "../shared/Toast";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { hasRole } from "../../stores/auth";
import type { TaggedResource } from "../../types";

export const TagsPage: Component = () => {
  const navigate = useNavigate();
  const [selectedTag, setSelectedTag] = createSignal<string | null>(null);
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [newTagName, setNewTagName] = createSignal("");
  const [showNewTag, setShowNewTag] = createSignal(false);
  const [renaming, setRenaming] = createSignal<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = createSignal(false);

  const [resources, { refetch }] = createResource(selectedTag, (id) =>
    get<TaggedResource[]>(`/api/tags/${encodeURIComponent(id)}/resources`)
  );

  void refreshTags();

  const key = (r: TaggedResource) => `${r.resource_type}:${r.resource_id}`;
  const toggle = (r: TaggedResource) =>
    setSelected((s) => { const n = new Set(s); const k = key(r); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const selectedResources = () => (resources() ?? []).filter((r) => selected().has(key(r)));

  const runBulk = async (fn: (r: TaggedResource) => Promise<void>) => {
    setBusy(true);
    try {
      await Promise.all(selectedResources().map((r) => fn(r).catch((e) => toast.error(`${r.name || r.resource_id}: ${(e as Error).message}`))));
      setSelected(new Set());
      await refetch();
    } finally { setBusy(false); }
  };

  const bulkStart = () => runBulk(async (r) => { if (r.resource_type === "container") await post(`/api/containers/${r.resource_id}/start`); });
  const bulkStop = () => runBulk(async (r) => { if (r.resource_type === "container") await post(`/api/containers/${r.resource_id}/stop`); });
  const bulkDelete = () => runBulk(async (r) => {
    if (r.resource_type === "container") await del(`/api/containers/${r.resource_id}`);
    else await del(`/api/images?id=${encodeURIComponent(r.resource_id)}`);
  });
  const bulkUntag = () => runBulk(async (r) => {
    const id = selectedTag();
    if (id) await unbindTag(id, r.resource_type, r.resource_id);
  });

  const createAndSelect = async () => {
    const name = newTagName().trim();
    if (!name) return;
    try {
      const t = await createTag(name);
      setNewTagName(""); setShowNewTag(false);
      setSelectedTag(t.id);
    } catch (e) { toast.error((e as Error).message); }
  };

  const doRename = async () => {
    const r = renaming(); if (!r) return;
    try { await updateTag(r.id, { name: r.name }); setRenaming(null); }
    catch (e) { toast.error((e as Error).message); }
  };

  const doDeleteTag = async (id: string) => {
    if (!confirm("删除该标签？（不会删除绑定的容器/镜像本身）")) return;
    try {
      await deleteTag(id);
      if (selectedTag() === id) setSelectedTag(null);
    } catch (e) { toast.error((e as Error).message); }
  };

  const allSelected = () => (resources() ?? []).length > 0 && selected().size === (resources() ?? []).length;

  return (
    <div class="flex gap-4">
      {/* Tag list */}
      <div class="w-56 shrink-0 border border-zinc-800">
        <div class="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
          <span class="text-sm font-semibold">标签</span>
          <Show when={hasRole("operator")}>
            <button class="text-xs text-indigo-400 hover:text-indigo-300" onClick={() => setShowNewTag(true)}>+ 新建</button>
          </Show>
        </div>
        <div class="max-h-[70vh] overflow-auto">
          <For each={tags()} fallback={<p class="p-3 text-xs text-zinc-500">暂无标签</p>}>
            {(t) => (
              <div
                class={`group flex cursor-pointer items-center justify-between gap-1 border-b border-zinc-800/50 px-3 py-2 text-sm transition-colors ${
                  selectedTag() === t.id ? "bg-zinc-800" : "hover:bg-zinc-800/50"
                }`}
                onClick={() => setSelectedTag(t.id)}
              >
                <span class="flex min-w-0 items-center gap-2">
                  <span class="h-2 w-2 shrink-0 rounded-full" style={{ "background-color": t.color || "#71717a" }} />
                  <span class="truncate">{t.name}</span>
                  <span class="shrink-0 text-xs text-zinc-500">{t.count ?? 0}</span>
                </span>
                <Show when={hasRole("operator")}>
                  <span class="hidden shrink-0 gap-2 group-hover:flex">
                    <button class="text-xs text-zinc-500 hover:text-zinc-200" onClick={(e) => { e.stopPropagation(); setRenaming({ id: t.id, name: t.name }); }}>改</button>
                    <button class="text-xs text-zinc-500 hover:text-red-400" onClick={(e) => { e.stopPropagation(); void doDeleteTag(t.id); }}>删</button>
                  </span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </div>

      {/* Resources under selected tag */}
      <div class="min-w-0 flex-1">
        <Show when={selectedTag()} fallback={<p class="text-sm text-zinc-500">选择左侧标签，查看并批量管理关联的容器/镜像</p>}>
          <Show when={hasRole("operator")}>
            <div class="mb-2 flex flex-wrap items-center gap-1.5 border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs">
              <input
                type="checkbox"
                checked={allSelected()}
                onChange={(e) => setSelected(e.currentTarget.checked ? new Set((resources() ?? []).map(key)) : new Set())}
              />
              <span class="min-w-[4rem] text-zinc-500">{selected().size > 0 ? `${selected().size} 已选` : "全选"}</span>
              <span class="text-zinc-400">│</span>
              <button disabled={busy() || selected().size === 0} class="px-2 py-0.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30" onClick={bulkStart}>▶ 启动</button>
              <button disabled={busy() || selected().size === 0} class="px-2 py-0.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30" onClick={bulkStop}>■ 停止</button>
              <button disabled={busy() || selected().size === 0} class="px-2 py-0.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30" onClick={bulkDelete}>⊖ 删除</button>
              <span class="text-zinc-400">│</span>
              <button disabled={busy() || selected().size === 0} class="px-2 py-0.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30" onClick={bulkUntag}>移除标签</button>
            </div>
          </Show>
          <div class="overflow-x-auto border border-zinc-800">
            <table class="w-full text-left text-sm">
              <thead class="border-b border-zinc-800 text-xs text-zinc-500">
                <tr>
                  <th class="w-8 px-3 py-2 text-center font-normal" />
                  <th class="px-3 py-2 font-normal">类型</th>
                  <th class="px-3 py-2 font-normal">名称</th>
                  <th class="px-3 py-2 font-normal">状态</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-zinc-800">
                <For each={resources() ?? []}>
                  {(r) => (
                    <tr class="transition-colors hover:bg-white/[0.03]">
                      <td class="px-3 py-2 text-center align-middle">
                        <input type="checkbox" checked={selected().has(key(r))} onChange={() => toggle(r)} />
                      </td>
                      <td class="px-3 py-2 align-middle text-xs text-zinc-400">{r.resource_type === "container" ? "容器" : "镜像"}</td>
                      <td class="px-3 py-2 align-middle">
                        <a
                          class="font-mono text-xs text-indigo-400 hover:text-indigo-300 hover:underline"
                          href={r.resource_type === "container" ? `/containers/${r.resource_id}` : "/images"}
                          onClick={(e) => { e.preventDefault(); navigate(r.resource_type === "container" ? `/containers/${r.resource_id}` : "/images"); }}
                        >
                          {r.name || r.repo_tags?.[0] || r.resource_id.slice(0, 12)}
                        </a>
                        <Show when={r.missing}>
                          <span class="ml-2 text-xs text-red-400">已不存在</span>
                        </Show>
                      </td>
                      <td class="px-3 py-2 align-middle text-xs text-zinc-400">{r.state ?? "—"}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
            <Show when={(resources() ?? []).length === 0 && !resources.loading}>
              <div class="py-16 text-center text-zinc-400">该标签下暂无容器/镜像</div>
            </Show>
          </div>
        </Show>
      </div>

      {/* New tag modal */}
      <Modal open={showNewTag()} onClose={() => setShowNewTag(false)} title="新建标签">
        <input
          class="mb-3 w-full border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-600 transition-colors"
          placeholder="标签名称"
          value={newTagName()}
          onInput={(e) => setNewTagName(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && void createAndSelect()}
          ref={(el: HTMLInputElement) => setTimeout(() => el?.focus(), 50)}
        />
        <div class="flex justify-end gap-2">
          <Button onClick={() => setShowNewTag(false)}>取消</Button>
          <Button variant="primary" onClick={() => void createAndSelect()}>创建</Button>
        </div>
      </Modal>

      {/* Rename modal */}
      <Modal open={!!renaming()} onClose={() => setRenaming(null)} title="重命名标签">
        <input
          class="mb-3 w-full border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-600 transition-colors"
          value={renaming()?.name ?? ""}
          onInput={(e) => setRenaming((r) => r && { ...r, name: e.currentTarget.value })}
          onKeyDown={(e) => e.key === "Enter" && void doRename()}
        />
        <div class="flex justify-end gap-2">
          <Button onClick={() => setRenaming(null)}>取消</Button>
          <Button variant="primary" onClick={() => void doRename()}>保存</Button>
        </div>
      </Modal>
    </div>
  );
};
