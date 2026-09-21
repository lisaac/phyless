import { Component, createSignal, createResource, onMount, onCleanup, Show, For } from "solid-js";
import { enqueue, queued, isPending, SETTLED_EVENT, type Task } from "../../stores/taskQueue";
import { A } from "@solidjs/router";
import { createResourceStore } from "../../stores/resource";
import { Modal } from "../shared/Modal";
import { Button } from "../shared/Button";
import { confirmAction } from "../shared/ConfirmModal";
import { PullOptions, createPullOptions, isBrowserDownload, browserPullSpec, browserWorkerReady } from "../shared/PullOptions";
import { CreateContainerModal } from "../containers/CreateContainerModal";
import { Btn, IBtn, Ico } from "../shared/ActionButton";
import { createListView, SearchBox, LoadMore } from "../shared/ListView";
import { FileBrowser } from "../shared/FileBrowser";
import { DownloadStatusWidget } from "../shared/UploadStatusWidget";
import { createDownloadTask } from "../../api/download";
import { get, getToken } from "../../api/client";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import type { ImageSummary, FileEntry } from "../../types";

// "<none> | repo@1234567890ab" — the digest names where an untagged image came from.
const digestHint = (img: ImageSummary) => {
  const d = img.RepoDigests?.[0];
  if (!d) return "";
  const [repo, digest = ""] = d.split("@sha256:");
  return ` | ${repo}@${digest.slice(0, 12)}`;
};
const imgLabel = (img: ImageSummary) => img.RepoTags?.[0] ?? img.Id.replace("sha256:", "").slice(0, 12);

// "myrepo/app:v2" → "app" — a reasonable default --name for a fresh container
function suggestName(ref: string): string {
  const last = ref.split("/").pop() ?? ref;
  const base = last.split(":")[0];
  return base.replace(/[^a-zA-Z0-9_.-]/g, "-") || "container";
}

function fmtDate(unix: number): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

// Editable + deletable tag chip — click to rename inline (like the container
// detail page's Memory field), × to untag. Renaming = tag the new ref, then
// untag the old one (Docker has no atomic rename).
// Untagging the LAST tag is equivalent to deleting the image (Docker removes
// the underlying image once no reference points to it), so that case routes
// through the same confirm dialog as the image delete button instead of
// untagging immediately.
const TagChip: Component<{
  tag: string; img: ImageSummary; onChanged: () => void; onConfirmLastTagDelete: (img: ImageSummary) => void;
}> = (p) => {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal(p.tag);

  const rename = async () => {
    setEditing(false);
    const next = draft().trim();
    if (!next || next === p.tag) return;
    try {
      await queued(`标签 ${next}`, "POST", `/api/images/tag?id=${encodeURIComponent(p.img.Id)}`, { tag: next });
      await queued(`移除标签 ${p.tag}`, "DELETE", `/api/images/untag?ref=${encodeURIComponent(p.tag)}`);
      toast.success("已重命名标签");
      p.onChanged();
    } catch (e) { toast.error((e as Error).message); }
  };

  const untag = async (e: MouseEvent) => {
    e.stopPropagation();
    if ((p.img.RepoTags?.length ?? 0) <= 1) {
      p.onConfirmLastTagDelete(p.img);
      return;
    }
    try {
      await queued(`移除标签 ${p.tag}`, "DELETE", `/api/images/untag?ref=${encodeURIComponent(p.tag)}`);
      p.onChanged();
    } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <Show when={editing()} fallback={
      <span class="inline-flex items-baseline gap-1">
        <span
          class="cursor-text font-mono text-xs text-zinc-100 border-b border-dashed border-zinc-600 hover:border-zinc-400 transition-colors"
          title="点击编辑，回车保存"
          onClick={(e) => { e.stopPropagation(); setDraft(p.tag); setEditing(true); }}
        >{p.tag}</span>
        <button
          class="text-[10px] leading-none text-zinc-600 transition-colors hover:text-red-400"
          title="删除标签"
          onClick={untag}
        >×</button>
      </span>
    }>
      <input
        class="w-full max-w-xs border border-indigo-500/60 bg-zinc-900 px-1.5 py-0.5 font-mono text-xs text-zinc-100 outline-none"
        value={draft()}
        onClick={(e) => e.stopPropagation()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void rename(); if (e.key === "Escape") setEditing(false); }}
        onBlur={() => setEditing(false)}
        ref={(el) => setTimeout(() => el?.select(), 0)}
      />
    </Show>
  );
};

export const ImageListPage: Component = () => {
  const store = createResourceStore<ImageSummary>("/api/images");
  const view = createListView(store.items, (img) => `${(img.RepoTags ?? []).join(" ")} ${img.Id}`);
  const [pullRef, setPullRef] = createSignal("");
  const [showPullInput, setShowPullInput] = createSignal(false);
  const [showRemoteImport, setShowRemoteImport] = createSignal(false);
  const pull = createPullOptions();
  const [remoteImportURL, setRemoteImportURL] = createSignal("");
  const [remoteImportRef, setRemoteImportRef] = createSignal("");
  const [remoteImportFile, setRemoteImportFile] = createSignal<File | undefined>(undefined);
  const [tagFor, setTagFor] = createSignal<ImageSummary | null>(null);
  const [tagVal, setTagVal] = createSignal("");
  const [inspectFor, setInspectFor] = createSignal<ImageSummary | null>(null);
  const [filesFor, setFilesFor] = createSignal<ImageSummary | null>(null);
  const download = createDownloadTask();
  const [createFrom, setCreateFrom] = createSignal<ImageSummary | null>(null);
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [inspectResult] = createResource(inspectFor, async (img) => {
    try { return { data: await get<any>(`/api/images/inspect?id=${encodeURIComponent(img.Id)}`) }; }
    catch (error) { return { error }; }
  });
  const inspectData = () => inspectResult()?.data;
  const inspectError = () => inspectResult()?.error;

  onMount(() => store.startPolling());
  onCleanup(() => store.stopPolling());
  onCleanup(() => download.cancel());

  const closePullInput = () => { setShowPullInput(false); pull.reset(); };
  const closeRemoteImport = () => {
    setShowRemoteImport(false); setRemoteImportURL(""); setRemoteImportRef(""); setRemoteImportFile(undefined);
  };

  // Long-running image ops go through the global task queue (progress in the
  // task panel, survives navigation). meta drives the settle listener below.
  const startPull = () => {
    const ref = pullRef().trim();
    if (!ref) return;
    if (isBrowserDownload(pull.value)) {
      if (!browserWorkerReady(pull.value)) return;
      enqueue(browserPullSpec(`拉取 ${ref}`, ref, `image:${ref}`, pull.value));
    } else {
      enqueue({
        title: `拉取 ${ref}`,
        url: "/api/images/pull",
        body: { image: ref, ...pull.payload() },
        key: `image:${ref}`,
        meta: { type: "pull" },
      });
    }
    setPullRef("");
    closePullInput();
  };

  const startImport = (file: File) => {
    enqueue({ title: `Load ${file.name}`, url: "/api/images/load", file, meta: { type: "load" } });
  };

  const startRemoteImport = () => {
    const source = remoteImportURL().trim();
    try {
      const u = new URL(source);
      if (!u.hostname || (u.protocol !== "http:" && u.protocol !== "https:")) throw new Error();
    } catch {
      toast.error("请输入有效的 http(s) 远程 tar URL");
      return;
    }
    enqueue({ title: `Import ${source}`, url: "/api/images/import", body: { source, ref: remoteImportRef().trim() }, meta: { type: "import" } });
    closeRemoteImport();
  };

  const startLocalImport = (file: File) => {
    const ref = remoteImportRef().trim();
    enqueue({ title: `Import ${file.name}`, url: `/api/images/import${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`, file, meta: { type: "import" } });
    closeRemoteImport();
  };

  const toggle = (id: string) =>
    setSelected((s) => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const toggleAll = (checked: boolean) =>
    setSelected(checked ? new Set(view.filtered().map((img) => img.Id)) : new Set<string>());
  const selectedCount = () => selected().size;
  const allSelected = () => view.filtered().length > 0 && view.filtered().every((img) => selected().has(img.Id));

  const startImageDelete = (ids: string[], force = false) => {
    if (!ids.length) return;
    const images = ids.map((id) => {
      const image = store.items().find((item) => item.Id === id);
      return image ? `${image.RepoTags?.join(", ") || imgLabel(image)} · ${image.Id.replace("sha256:", "").slice(0, 12)}` : id;
    });
    setSelected(new Set<string>());
    enqueue({
      title: `${force ? "强制删除" : "删除"} ${ids.length} 个镜像`,
      url: "/api/images/delete",
      body: { ids, force },
      key: "images:delete",
      meta: { type: "image-delete", images, ids, force },
    });
  };

  const bulkRemove = () => startImageDelete([...selected()]);

  const prune = () => {
    setSelected(new Set<string>());
    enqueue({ title: "清理镜像", url: "/api/images/prune", key: "images:delete", meta: { type: "prune" } });
  };

  const remove = (id: string, force = false) => startImageDelete([id], force);
  const confirmImageDelete = async (img: ImageSummary) => {
    if (await confirmAction(`确定删除镜像 ${imgLabel(img)}？`, { title: "删除镜像", confirmText: "删除", danger: true })) void remove(img.Id);
  };
  const confirmBulkRemove = async () => {
    const count = selectedCount();
    if (count && await confirmAction(`删除选中的 ${count} 个镜像？`, { title: "删除镜像", confirmText: "删除", danger: true })) bulkRemove();
  };
  const confirmPrune = async () => {
    if (await confirmAction("清理所有未被容器使用的镜像？此操作不可撤销。", { title: "清理镜像", confirmText: "清理", danger: true })) prune();
  };
  const deleting = (id: string) => isPending((t) => t.meta?.type === "image-delete" && (t.meta.ids as string[]).includes(id));
  const pruning = () => isPending((t) => t.meta?.type === "prune");

  // Page-level reactions to finished image tasks (while this page is mounted;
  // otherwise the outcome just stays in the task panel). List refresh itself is
  // handled by createResourceStore.
  const onSettled = (e: Event) => {
    const t = (e as CustomEvent<Task>).detail;
    const kind = t.meta?.type;
    if (kind !== "image-delete" && kind !== "prune") return;
    if (t.status === "done") {
      toast.success(kind === "prune" ? "镜像清理完成" : `已删除 ${(t.meta!.ids as string[]).length} 个镜像`);
      return;
    }
    if (t.status !== "error") return;
    const ids = (t.meta!.ids as string[] | undefined) ?? [];
    if (kind === "image-delete" && ids.length === 1 && !t.meta!.force &&
        (t.error.includes("must be forced") || t.error.includes("is being used") || t.error.includes("referenced"))) {
      const id = ids[0];
      void confirmAction("该镜像正被容器使用，普通删除被拒绝。\n强制删除将移除镜像，已有容器会继续运行，但无法重新拉起该版本。", { title: "强制删除镜像", confirmText: "强制删除", danger: true }).then((confirmed) => {
        if (confirmed) remove(id, true);
      });
      return;
    }
    toast.error(t.error);
  };
  onMount(() => window.addEventListener(SETTLED_EVENT, onSettled));
  onCleanup(() => window.removeEventListener(SETTLED_EVENT, onSettled));

  const addTag = async () => {
    const img = tagFor(); if (!img) return;
    try {
      await queued(`标签 ${tagVal()}`, "POST", `/api/images/tag?id=${encodeURIComponent(img.Id)}`, { tag: tagVal() });
      toast.success("打标签成功");
      setTagFor(null); setTagVal("");
      await store.refresh();
    } catch (e) { toast.error((e as Error).message); }
  };

  const fmtSize = (b: number) => b >= 1e9
    ? `${(b / 1e9).toFixed(1)} GB`
    : `${(b / 1e6).toFixed(1)} MB`;

  return (
    <div>
      <div class="mb-3 flex items-center justify-between gap-2">
        <h1 class="shrink-0 text-xl font-semibold">镜像</h1>
        <Show when={hasRole("operator")}>
          <div class="flex min-w-0 items-center justify-end gap-1 sm:gap-2">
            <button
              class="whitespace-nowrap rounded-md border border-red-500/30 px-2 py-1 text-xs text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50 sm:px-3 sm:py-1.5 sm:text-sm"
              disabled={pruning()}
              title={pruning() ? "清理中" : "清理所有未被容器使用的镜像"}
              onClick={() => void confirmPrune()}
            >
              {pruning() ? "清理中…" : "清理"}
            </button>
            <button
              class="whitespace-nowrap rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50 sm:px-3 sm:py-1.5 sm:text-sm"
              onClick={() => setShowPullInput(true)}
            >
              + 拉取
            </button>
            <button
              class="whitespace-nowrap rounded-md border border-zinc-600 px-2 py-1 text-xs text-zinc-300 transition-colors hover:border-zinc-400 hover:text-zinc-100 disabled:opacity-50 sm:px-3 sm:py-1.5 sm:text-sm"
              title="Import：导入容器导出的 rootfs tar，可选远程 URL 或本地文件"
              onClick={() => setShowRemoteImport(true)}
            >
              + Import
            </button>
            <label
              class="cursor-pointer whitespace-nowrap rounded-md border border-zinc-600 px-2 py-1 text-xs text-zinc-300 transition-colors hover:border-zinc-400 hover:text-zinc-100 sm:px-3 sm:py-1.5 sm:text-sm"
              title="Load：导入由镜像 save 导出的 tar 文件"
            >
              + Load
              <input
                type="file"
                accept=".tar,.tar.gz,.tgz"
                class="hidden"
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  e.currentTarget.value = "";
                  if (file) startImport(file);
                }}
              />
            </label>
          </div>
        </Show>
      </div>

      <div class="mb-3">
        <SearchBox value={view.query()} onInput={view.setQuery} placeholder="搜索镜像…" />
      </div>

      <div class="mb-3 flex flex-wrap items-center gap-1.5 border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs">
        <input type="checkbox" aria-label="全选镜像" checked={allSelected()} onChange={(e) => toggleAll(e.currentTarget.checked)} />
        <span class="min-w-[4rem] text-zinc-500">{selectedCount() > 0 ? `${selectedCount()} 已选` : "全选"}</span>
        <Show when={hasRole("operator")}>
          <span class="text-zinc-400">│</span>
          <Btn
            title="删除选中镜像"
            danger
            disabled={selectedCount() === 0}
            onClick={() => void confirmBulkRemove()}
          >
            ⊖ 删除
          </Btn>
        </Show>
        <Show when={selectedCount() > 0}>
          <button class="ml-auto text-zinc-400 hover:text-zinc-100" onClick={() => setSelected(new Set<string>())}>
            清除
          </button>
        </Show>
      </div>

      <Show when={store.error()}><p class="mb-2 text-sm text-red-400">{store.error()}</p></Show>

      <div class="overflow-x-auto border border-zinc-800">
        <div class="hidden border-b border-zinc-800 text-xs text-zinc-500 sm:flex">
          <div class="min-w-0 flex-1 px-3 py-2">标签</div>
          <div class="w-24 shrink-0 px-3 py-2 text-center">大小</div>
          <div class="w-48 shrink-0 px-3 py-2 text-center">使用容器</div>
          <div class="w-40 shrink-0 px-3 py-2 text-center">创建时间</div>
        </div>
        <div class="divide-y divide-zinc-800">
          <For each={view.visible()}>
            {(img) => (
              <div
                class={`flex flex-col text-sm transition-colors sm:flex-row sm:items-start hover:bg-white/[0.03] ${selected().has(img.Id) ? "ring-1 ring-inset ring-indigo-500/60" : ""}`}
                onClick={() => toggle(img.Id)}
              >
                <div class="min-w-0 w-full px-3 py-2 sm:flex-1">
                  <div class="min-w-0 flex-1">
                    {/* Tags — editable + deletable chips */}
                    <Show when={(img.RepoTags ?? []).length > 0} fallback={<div class="font-mono text-xs text-zinc-500">&lt;none&gt;{digestHint(img)}</div>}>
                      <For each={img.RepoTags}>
                        {(tag) => (
                          <div>
                            <TagChip
                              tag={tag}
                              img={img}
                              onChanged={() => void store.refresh()}
                              onConfirmLastTagDelete={confirmImageDelete}
                            />
                          </div>
                        )}
                      </For>
                    </Show>
                    {/* ID — click to inspect */}
                    <button
                      class="mt-0.5 block font-mono text-[11px] text-zinc-400 transition-colors hover:text-indigo-400"
                      title="查看 inspect"
                      onClick={(e) => { e.stopPropagation(); setInspectFor(img); }}
                    >
                      {img.Id.replace("sha256:", "").slice(0, 12)}
                    </button>
                    {/* Inline actions */}
                    <div class="mt-1 flex items-center gap-0.5">
                      <IBtn title="inspect" onClick={() => setInspectFor(img)}>
                        <Ico path="M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM21 21l-4.35-4.35" />
                      </IBtn>
                      <Show when={hasRole("operator")}>
                        <IBtn title="使用此镜像创建容器" onClick={() => setCreateFrom(img)}>
                          ⊕
                        </IBtn>
                        <Show when={(img.RepoTags ?? []).length > 0}>
                          <IBtn
                            title="升级：重新拉取该镜像标签"
                            onClick={() => { setPullRef(img.RepoTags![0]); setShowPullInput(true); }}
                          >
                            ↑
                          </IBtn>
                        </Show>
                      </Show>
                      <a
                        title="save"
                        target="_blank"
                        rel="noopener"
                        href={`/api/images/save?id=${encodeURIComponent(img.Id)}&token=${encodeURIComponent(getToken() ?? "")}`}
                        class="inline-flex h-6 w-6 items-center justify-center text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                        onClick={(e) => e.stopPropagation()}
                      >
                        ↓
                      </a>
                      <IBtn title="文件" onClick={() => setFilesFor(img)}>
                        <Ico path="M3 7v13a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-9l-2-3H4a1 1 0 0 0-1 1z" />
                      </IBtn>
                      <Show when={hasRole("operator")}>
                        <IBtn title="新增标签" onClick={() => { setTagFor(img); setTagVal(""); }}>
                          <Ico path="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01" />
                        </IBtn>
                        <IBtn
                          title="删除"
                          danger
                          loading={deleting(img.Id)}
                          onClick={() => void confirmImageDelete(img)}
                        >
                          ⊖
                        </IBtn>
                      </Show>
                    </div>
                  </div>
                </div>
                <div class="w-full border-t border-zinc-800/60 px-3 py-2 text-left text-xs text-zinc-400 sm:w-24 sm:shrink-0 sm:self-center sm:border-t-0 sm:text-center">{fmtSize(img.Size)}</div>
                <div class="w-full border-t border-zinc-800/60 px-3 py-2 text-left text-xs sm:w-48 sm:shrink-0 sm:self-center sm:border-t-0 sm:text-center">
                  <Show when={img.UsedBy && img.UsedBy.length > 0} fallback={<span class="text-zinc-600">—</span>}>
                    <div class="flex flex-col items-start gap-0.5 sm:items-center">
                      <For each={img.UsedBy}>
                        {(c) => (
                          <A href={`/containers/${c.Id}`} replace class="text-indigo-400 hover:text-indigo-300 hover:underline" onClick={(e) => e.stopPropagation()}>
                            {c.Name}
                          </A>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
                <div class="w-full border-t border-zinc-800/60 px-3 py-2 text-left text-xs text-zinc-400 sm:w-40 sm:shrink-0 sm:self-center sm:border-t-0 sm:text-center">{fmtDate(img.Created)}</div>
              </div>
            )}
          </For>
          <LoadMore when={view.hasMore()} onMore={view.loadMore} />
        </div>

        <Show when={view.filtered().length === 0 && !store.error()}>
          <div class="py-16 text-center text-zinc-400">
            {store.items().length === 0 ? "暂无镜像" : "无匹配结果"}
          </div>
        </Show>
      </div>

      {/* Docker import accepts a container-exported rootfs tar from either a URL or a local file. */}
      <Modal open={showRemoteImport()} onClose={closeRemoteImport} title="Import 镜像">
        <div class="flex flex-col gap-3">
          <label class="flex flex-col gap-1">
            <span class="text-xs text-zinc-400">远程 tar URL（可选）</span>
            <input
              type="url"
              class="w-full border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-600"
              placeholder="https://example.com/rootfs.tar"
              value={remoteImportURL()}
              onInput={(e) => { setRemoteImportURL(e.currentTarget.value); if (e.currentTarget.value.trim()) setRemoteImportFile(undefined); }}
              onKeyDown={(e) => e.key === "Enter" && startRemoteImport()}
              ref={(el: HTMLInputElement) => setTimeout(() => el?.focus(), 50)}
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-zinc-400">本地 tar 文件（容器导出的 rootfs）</span>
            <input
              type="file"
              accept=".tar,.tar.gz,.tgz"
              class="w-full text-sm text-zinc-300 file:mr-3 file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-zinc-200 file:hover:bg-zinc-700"
              onChange={(e) => { const file = e.currentTarget.files?.[0]; setRemoteImportFile(file); if (file) setRemoteImportURL(""); }}
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-zinc-400">镜像名称:标签（可选）</span>
            <input
              class="w-full border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-600"
              placeholder="imported/myapp:latest"
              value={remoteImportRef()}
              onInput={(e) => setRemoteImportRef(e.currentTarget.value)}
            />
          </label>
          <p class="text-xs text-zinc-500">Import 用于把容器导出的 rootfs tar 转成镜像；可填写远程 URL 或选择本地文件。由镜像 save 导出的 tar 请使用 Load。</p>
        </div>
        <div class="mt-4 flex justify-end gap-2">
          <Button onClick={closeRemoteImport}>取消</Button>
          <Button
            variant="primary"
            disabled={!remoteImportURL().trim() && !remoteImportFile()}
            onClick={() => remoteImportFile() ? startLocalImport(remoteImportFile()!) : startRemoteImport()}
          >Import</Button>
        </div>
      </Modal>

      {/* Pull input modal */}
      <Modal open={showPullInput()} onClose={closePullInput} title="拉取镜像">
        <input
          class="mb-3 w-full border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-600 transition-colors"
          placeholder="nginx:latest"
          value={pullRef()}
          onInput={(e) => setPullRef(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && startPull()}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ref={(el: any) => setTimeout(() => el?.focus(), 50)}
        />
        <PullOptions options={pull} showPlatform allowBrowser />
        <div class="flex justify-end gap-2">
          <Button onClick={closePullInput}>取消</Button>
          <Button variant="primary" onClick={startPull}>拉取</Button>
        </div>
      </Modal>

      {/* Pull/import progress — non-blocking floating card, rest of the page stays usable */}
      {/* Tag modal */}
      <Modal open={!!tagFor()} onClose={() => setTagFor(null)} title="添加标签">
        <p class="mb-2 text-xs text-zinc-500">
          当前：{tagFor()?.RepoTags?.[0] ?? tagFor()?.Id.replace("sha256:", "").slice(0, 12)}
        </p>
        <input
          class="mb-3 w-full border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-600 transition-colors"
          placeholder="myrepo/app:v2"
          value={tagVal()}
          onInput={(e) => setTagVal(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && addTag()}
          ref={(el: HTMLInputElement) => setTimeout(() => el?.focus(), 50)}
        />
        <div class="flex justify-end gap-2">
          <Button onClick={() => setTagFor(null)}>取消</Button>
          <Button variant="primary" onClick={addTag}>添加</Button>
        </div>
      </Modal>

      {/* Inspect modal */}
      <Modal open={!!inspectFor()} onClose={() => setInspectFor(null)} title={`Inspect · ${inspectFor() ? imgLabel(inspectFor()!) : ""}`} wide>
        <Show
          when={!inspectResult.loading && !inspectError()}
          fallback={<p class={inspectError() ? "text-xs text-red-400" : "text-xs text-zinc-500"}>{inspectError() ? `加载失败：${(inspectError() as Error).message}` : "加载中…"}</p>}
        >
          <pre class="max-h-[70vh] overflow-auto bg-zinc-950 p-4 font-mono text-xs leading-5 text-zinc-400">
            {JSON.stringify(inspectData(), null, 2)}
          </pre>
        </Show>
      </Modal>

      {/* File browser — inspect the image's rootfs, download files as a tar */}
      <Modal open={!!filesFor()} onClose={() => setFilesFor(null)} title={`文件 · ${filesFor() ? imgLabel(filesFor()!) : ""}`} wide>
        <Show when={filesFor()}>
          {(img) => (
            <FileBrowser
              instanceKey={img().Id}
              listPath={(sub) => get<FileEntry[]>(`/api/images/files?id=${encodeURIComponent(img().Id)}&path=${encodeURIComponent(sub)}`)}
              onDownload={(sub, name) => download.start(
                `/api/images/files/download?id=${encodeURIComponent(img().Id)}&path=${encodeURIComponent(sub)}&token=${encodeURIComponent(getToken() ?? "")}`,
                `${name}.tar`,
              )}
            />
          )}
        </Show>
      </Modal>
      <DownloadStatusWidget task={download} />

      <CreateContainerModal
        open={!!createFrom()}
        onClose={() => setCreateFrom(null)}
        initialRun={createFrom() ? `docker run -d --name ${suggestName(imgLabel(createFrom()!))} ${imgLabel(createFrom()!)}` : ""}
      />
    </div>
  );
};
