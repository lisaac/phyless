import { Component, createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { createResourceStore } from "../../stores/resource";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { FileBrowser } from "../shared/FileBrowser";
import { get, post, del } from "../../api/client";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import { midPath } from "../containers/containerActions";
import { createListView, SearchBox, LoadMore } from "../shared/ListView";
import type { VolumeSummary, FileEntry } from "../../types";

export const VolumeListPage: Component = () => {
  const navigate = useNavigate();
  const store = createResourceStore<VolumeSummary>("/api/volumes");
  const view = createListView(store.items, (v) =>
    `${v.Name} ${v.Driver} ${v.Mountpoint} ${v.UsedBy?.map((c) => c.Name).join(" ") ?? ""}`);
  const [show, setShow] = createSignal(false);
  const [name, setName] = createSignal("");
  const [browse, setBrowse] = createSignal<VolumeSummary | null>(null);

  onMount(() => store.startPolling());
  onCleanup(() => store.stopPolling());

  const create = async () => {
    try { await post("/api/volumes", { name: name() }); setShow(false); setName(""); await store.refresh(); }
    catch (e) { toast.error((e as Error).message); }
  };
  const remove = async (n: string) => {
    try { await del(`/api/volumes/${encodeURIComponent(n)}`); await store.refresh(); }
    catch (e) { toast.error((e as Error).message); }
  };
  const listFiles = (sub: string) =>
    get<FileEntry[]>(`/api/volumes/${encodeURIComponent(browse()!.Name)}/files?path=${encodeURIComponent(sub)}`);

  return (
    <div>
      <div class="mb-4 flex items-center justify-between">
        <h1 class="text-xl font-semibold">存储卷</h1>
        <Show when={hasRole("operator")}>
          <Button variant="primary" onClick={() => setShow(true)}>创建卷</Button>
        </Show>
      </div>
      <div class="mb-3">
        <SearchBox value={view.query()} onInput={view.setQuery} placeholder="搜索存储卷…" />
      </div>

      <Show when={store.error()}><p class="mb-2 text-sm text-red-400">{store.error()}</p></Show>

      {/* div-simulated table (same approach as ContainerRow) — a fixed-width
          name column left the mountpoint/used-by columns starved for room
          whenever a name happened to be long. */}
      <div class="overflow-x-auto border border-zinc-800">
        <div class="hidden border-b border-zinc-800 text-xs text-zinc-500 sm:flex">
          <div class="w-48 shrink-0 px-3 py-2">名称</div>
          <div class="w-20 shrink-0 px-3 py-2">驱动</div>
          <div class="min-w-0 flex-1 px-3 py-2">挂载点</div>
          <div class="w-48 shrink-0 px-3 py-2">使用容器</div>
          <div class="w-36 shrink-0 px-3 py-2">操作</div>
        </div>
        <div class="divide-y divide-zinc-800">
          <For each={view.visible()}>
            {(v) => (
              <div class="flex flex-col text-sm transition-colors sm:flex-row hover:bg-white/[0.03]">
                <div class="w-full px-3 py-2 sm:w-48 sm:shrink-0">
                  <span class="font-medium" title={v.Name}>{midPath(v.Name)}</span>
                </div>
                <div class="w-full border-t border-zinc-800/60 px-3 py-2 text-xs text-zinc-400 sm:w-20 sm:shrink-0 sm:border-t-0">{v.Driver}</div>
                <div class="w-full min-w-0 border-t border-zinc-800/60 px-3 py-2 text-xs text-zinc-400 sm:flex-1 sm:border-t-0" title={v.Mountpoint}>{midPath(v.Mountpoint)}</div>
                <div class="w-full border-t border-zinc-800/60 px-3 py-2 sm:w-48 sm:shrink-0 sm:border-t-0">
                  <Show when={(v.UsedBy?.length ?? 0) > 0} fallback={<span class="text-xs text-zinc-500">—</span>}>
                    <div class="flex flex-wrap gap-x-1.5 gap-y-0.5">
                      <For each={v.UsedBy}>
                        {(c) => (
                          <a
                            href={`/containers/${c.Id}`}
                            class="text-xs text-indigo-400 hover:text-indigo-300 hover:underline transition-colors"
                            onClick={(e) => { e.preventDefault(); navigate(`/containers/${c.Id}`, { replace: true }); }}
                          >
                            {c.Name || c.Id.slice(0, 8)}
                          </a>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
                <div class="w-full border-t border-zinc-800/60 px-3 py-2 sm:w-36 sm:shrink-0 sm:border-t-0">
                  <div class="flex gap-1">
                    <Button onClick={() => setBrowse(v)}>浏览</Button>
                    <Show when={hasRole("operator")}>
                      <Button variant="danger" onClick={() => remove(v.Name)}>删除</Button>
                    </Show>
                  </div>
                </div>
              </div>
            )}
          </For>
          <LoadMore when={view.hasMore()} onMore={view.loadMore} />
        </div>
        <Show when={view.filtered().length === 0 && !store.error()}>
          <div class="py-16 text-center text-zinc-400">
            {store.items().length === 0 ? "暂无存储卷" : "无匹配结果"}
          </div>
        </Show>
      </div>

      <Modal open={show()} onClose={() => setShow(false)} title="创建存储卷">
        <input class="mb-3 w-full bg-zinc-900 border border-zinc-800 px-3 py-2" placeholder="卷名" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
        <div class="flex justify-end gap-2">
          <Button onClick={() => setShow(false)}>取消</Button>
          <Button variant="primary" onClick={create}>创建</Button>
        </div>
      </Modal>

      <Modal open={!!browse()} onClose={() => setBrowse(null)} title={`浏览 ${browse()?.Name ?? ""}`} wide>
        <Show when={browse()}>
          <FileBrowser listPath={listFiles} />
        </Show>
      </Modal>
    </div>
  );
};
