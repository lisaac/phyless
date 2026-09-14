import { Component, createSignal, createResource, createEffect, For, Show, Suspense, createMemo } from "solid-js";
import type { FileEntry } from "../../types";
import { confirmAction } from "./ConfirmModal";

function fmtSize(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}K`;
  return `${(b / 1024 / 1024).toFixed(1)}M`;
}

function fmtTime(unix?: number): string {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

// Border-radius is force-zeroed globally (index.css), so a CSS ring spinner
// would render square — use an SVG circle instead.
const Spinner: Component<{ size?: number }> = (p) => (
  <svg class="animate-spin text-zinc-500" width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" stroke-opacity="0.25" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
  </svg>
);

function pathSegments(p: string) {
  const parts = p.split("/").filter(Boolean);
  return [
    { label: "/", path: "/" },
    ...parts.map((seg, i) => ({ label: seg, path: "/" + parts.slice(0, i + 1).join("/") })),
  ];
}

interface FileBrowserProps {
  listPath: (sub: string) => Promise<FileEntry[]>;
  // (fullSubPath, displayName) — the caller drives the actual transfer
  // (progress widget, auth, etc.); this just tells it what got clicked.
  onDownload?: (sub: string, name: string) => void;
  onUpload?: (sub: string, file: File) => Promise<void>;
  onCreate?: (sub: string) => Promise<void>;
  onDelete?: (sub: string) => Promise<void>;
  onRename?: (oldPath: string, newPath: string) => Promise<void>;
  onCopyToContainer?: (fullPath: string) => void;
  onOpenFile?: (fullSubPath: string) => void;
  initialPath?: string;
  onPathChange?: (path: string) => void;
  // Identifies which entity (e.g. container id) is being browsed. The page
  // that owns FileBrowser often doesn't remount across navigations (Solid
  // Router reuses the same component instance for e.g. /containers/:id when
  // only :id changes), so without this, switching to a different container
  // whose file browser happens to already sit at the same path would never
  // refetch — leaving the previous container's stale listing on screen while
  // every action (delete/rename/copy) silently targets the new container.
  instanceKey?: string;
}

// The resource + its eager `sorted` memo are created in the component body,
// which runs under whatever <Suspense> is active at mount. The app has one
// at the root (App.tsx), so a first-fetch suspend there blanks the whole
// page (and the modal, killing click-outside-to-cancel). Wrapping the body
// in its OWN <Suspense> here means the body runs under this boundary instead
// — first load shows just the spinner, the modal stays put.
export const FileBrowser: Component<FileBrowserProps> = (props) => (
  <Suspense fallback={<div class="flex items-center justify-center gap-2 py-12 text-xs text-zinc-500"><Spinner size={20} /> 加载中…</div>}>
    <FileBrowserInner {...props} />
  </Suspense>
);

const FileBrowserInner: Component<FileBrowserProps> = (props) => {
  const [path, setPath] = createSignal(props.initialPath ?? "/");
  createEffect(() => {
    props.instanceKey;
    setPath(props.initialPath ?? "/");
  });
  const [entries, { refetch }] = createResource(() => [props.instanceKey, path()] as const, ([, p]) => props.listPath(p));
  const [sortCol, setSortCol] = createSignal("name");
  const [sortDir, setSortDir] = createSignal<1 | -1>(1);
  const toggleSort = (col: string) => {
    if (sortCol() === col) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortCol(col); setSortDir(1); }
  };
  // Read `.latest`, never `entries()`: the app has a single root <Suspense>
  // (App.tsx), so reading a loading resource under it re-suspends the WHOLE
  // app to a bare "加载中…" on every folder click — blanking the modal (and
  // its click-outside-to-close) and jumping the page. `.latest` keeps the
  // previous rows visible during refetch and never triggers Suspense.
  const rows = () => entries.latest;
  const sorted = createMemo(() => {
    const es = [...(rows() ?? [])];
    const col = sortCol(), dir = sortDir();
    return es.sort((a, b) => {
      let av: any, bv: any;
      if (col === "name")     { av = a.name;           bv = b.name; }
      else if (col === "size")     { av = a.is_dir ? -1 : a.size;  bv = b.is_dir ? -1 : b.size; }
      else if (col === "mod_time") { av = a.mod_time ?? 0;         bv = b.mod_time ?? 0; }
      else if (col === "mode")     { av = a.mode ?? "";            bv = b.mode ?? ""; }
      else if (col === "owner")    { av = a.uname ?? "";           bv = b.uname ?? ""; }
      return (typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number)) * dir;
    });
  });
  const [renamingName, setRenamingName] = createSignal<string | null>(null);
  const [renameVal, setRenameVal] = createSignal("");
  const [editingPath, setEditingPath] = createSignal(false);
  const [pathDraft, setPathDraft] = createSignal("");
  let pathInput: HTMLInputElement | undefined;

  const nav = (p: string) => { setPath(p); props.onPathChange?.(p); };
  const join = (name: string) => (path().endsWith("/") ? path() : path() + "/") + name;

  const enter = (e: FileEntry) => {
    const full = join(e.name);
    if (e.is_dir) nav(full);
    else props.onOpenFile?.(full.replace(/^\/+/, "/"));
  };
  const up = () => nav(path().replace(/\/[^/]+\/?$/, "") || "/");

  const startEditPath = () => {
    setPathDraft(path());
    setEditingPath(true);
    setTimeout(() => { pathInput?.select(); }, 0);
  };

  const commitEditPath = () => {
    setEditingPath(false);
    const p = pathDraft().trim() || "/";
    nav(p.startsWith("/") ? p : "/" + p);
  };

  const upload = async (file: File | undefined) => {
    if (file && props.onUpload) { await props.onUpload(path(), file); refetch(); }
  };

  const [creating, setCreating] = createSignal(false);
  const [createVal, setCreateVal] = createSignal("");
  const startCreate = () => { setCreateVal(""); setCreating(true); };
  const commitCreate = async () => {
    const val = createVal().trim();
    setCreating(false);
    if (val && props.onCreate) { await props.onCreate(join(val).replace(/^\/+/, "/")); refetch(); }
  };

  const doDelete = async (e: FileEntry) => {
    if (!props.onDelete || !await confirmAction(`删除 ${e.name}？`, { title: "删除文件", confirmText: "删除", danger: true })) return;
    await props.onDelete(join(e.name));
    refetch();
  };

  const startRename = (e: FileEntry) => { setRenamingName(e.name); setRenameVal(e.name); };

  const commitRename = async (e: FileEntry) => {
    const newName = renameVal().trim();
    if (newName && newName !== e.name && props.onRename) {
      const dir = path().endsWith("/") ? path() : path() + "/";
      await props.onRename(dir + e.name, dir + newName);
      refetch();
    }
    setRenamingName(null);
  };

  const segs = () => pathSegments(path());

  return (
    <div>
      {/* ── Path bar ──────────────────────────────────────────────────────── */}
      <div class="mb-2 flex items-center gap-1.5 border-b border-zinc-800 pb-2">
        <button
          class="shrink-0 px-1 py-0.5 text-sm text-zinc-500 hover:text-zinc-200 transition-colors disabled:opacity-30"
          onClick={up}
          disabled={path() === "/"}
          title="返回上一层"
        >↑</button>

        {/* Breadcrumb / editable path */}
        <Show
          when={editingPath()}
          fallback={
            <div
              class="flex min-w-0 flex-1 cursor-text flex-wrap items-center gap-0.5 rounded px-1 py-0.5 font-mono text-xs hover:bg-zinc-800/60 transition-colors"
              onClick={startEditPath}
              title="点击编辑路径"
            >
              <For each={segs()}>
                {(seg, i) => (
                  <>
                    <Show when={i() > 1}>
                      <span class="select-none text-zinc-700">/</span>
                    </Show>
                    <button
                      class={`max-w-[12rem] truncate transition-colors ${
                        i() === segs().length - 1
                          ? "text-zinc-200 cursor-default"
                          : "text-zinc-500 hover:text-zinc-200"
                      }`}
                      onClick={(e) => { e.stopPropagation(); nav(seg.path); }}
                      title={seg.path}
                    >{seg.label}</button>
                  </>
                )}
              </For>
            </div>
          }
        >
          <input
            ref={pathInput}
            class="min-w-0 flex-1 rounded border border-indigo-500/50 bg-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-100 outline-none focus:border-indigo-500"
            value={pathDraft()}
            onInput={(e) => setPathDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEditPath();
              if (e.key === "Escape") setEditingPath(false);
            }}
            onBlur={commitEditPath}
          />
        </Show>

        <Show when={props.onCreate}>
          <Show
            when={!creating()}
            fallback={
              <input
                class="w-28 shrink-0 border border-indigo-500/50 bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-100 outline-none"
                placeholder="新文件名"
                value={createVal()}
                onInput={(e) => setCreateVal(e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void commitCreate(); if (e.key === "Escape") setCreating(false); }}
                onBlur={() => void commitCreate()}
                ref={(el) => setTimeout(() => el?.focus(), 0)}
              />
            }
          >
            <button class="shrink-0 px-2 py-0.5 text-xs text-zinc-500 hover:text-zinc-200 transition-colors" onClick={startCreate}>+ 新建</button>
          </Show>
        </Show>

        <Show when={props.onUpload}>
          <label class="shrink-0 cursor-pointer px-2 py-0.5 text-xs text-zinc-500 hover:text-zinc-200 transition-colors">
            ↑ 上传
            <input type="file" class="hidden" onChange={(e) => upload(e.currentTarget.files?.[0])} />
          </label>
        </Show>
      </div>

      <Show when={entries.error}>
        <p class="py-6 text-center text-sm text-red-400">{String(entries.error)}</p>
      </Show>
      {/* Refetch keeps rows on screen (`.latest` doesn't re-suspend): just dim
          + overlay a spinner — no unmount, no page jump. */}
      <Show when={!entries.error}>
       <div class="relative">
        <div classList={{ "pointer-events-none opacity-40 transition-opacity": entries.loading }}>
        <table class="w-full text-left">
          <thead>
            <tr class="text-[11px] text-zinc-500 select-none">
              {(() => {
                const th = (col: string, label: string, extraClass = "") => (
                  <th
                    class={`pb-1 pr-3 font-normal cursor-pointer hover:text-zinc-300 transition-colors ${extraClass}`}
                    onClick={() => toggleSort(col)}
                  >
                    {label}{sortCol() === col ? (sortDir() === 1 ? " ↑" : " ↓") : ""}
                  </th>
                );
                // 权限/所有者/修改时间 hidden below sm — a 6-column table has
                // nowhere to go on a phone-width screen; name/size/actions
                // are what you actually need to navigate and act on files.
                return <>
                  {th("name", "名称")}
                  {th("mode", "权限", "hidden sm:table-cell")}
                  {th("owner", "所有者", "hidden sm:table-cell")}
                  {th("size", "大小", "text-right")}
                  {th("mod_time", "修改时间", "hidden sm:table-cell")}
                  <th class="pb-1 font-normal" />
                </>;
              })()}
            </tr>
          </thead>
          <tbody>
            <For each={sorted()}>
              {(e) => {
                const isRenaming = () => renamingName() === e.name;
                return (
                  <tr class="border-t border-zinc-800/50 hover:bg-white/[0.03] transition-colors">
                    <td class="py-1 pr-3">
                      <Show when={isRenaming()} fallback={
                        <span
                          class={`cursor-pointer font-mono text-xs transition-colors ${
                            e.is_dir
                              ? "font-medium text-sky-400 hover:text-sky-300"
                              : "text-zinc-300 hover:text-zinc-100"
                          }`}
                          onClick={() => enter(e)}
                        >
                          {e.is_dir ? "▸ " : "  "}{e.name}
                        </span>
                      }>
                        <input
                          class="border border-zinc-600 bg-zinc-900 px-1 font-mono text-xs text-zinc-100 outline-none"
                          value={renameVal()}
                          onInput={(ev) => setRenameVal(ev.currentTarget.value)}
                          onKeyDown={(ev) => { if (ev.key === "Enter") void commitRename(e); if (ev.key === "Escape") setRenamingName(null); }}
                          onBlur={() => void commitRename(e)}
                          ref={(el) => setTimeout(() => el?.select(), 0)}
                        />
                      </Show>
                    </td>
                    <td class="hidden py-1 pr-3 font-mono text-[11px] text-zinc-400 sm:table-cell">{e.mode ?? ""}</td>
                    <td class="hidden py-1 pr-3 text-[11px] text-zinc-400 sm:table-cell">
                      {e.uname ?? (e.uid != null ? String(e.uid) : "")}{e.gid != null ? `:${e.gid}` : ""}
                    </td>
                    <td class="py-1 pr-3 text-right font-mono text-[11px] text-zinc-400">{e.is_dir ? "—" : fmtSize(e.size)}</td>
                    <td class="hidden py-1 pr-3 text-[11px] text-zinc-400 sm:table-cell">{fmtTime(e.mod_time)}</td>
                    <td class="py-1">
                      <div class="flex gap-2">
                        <Show when={props.onRename}>
                          <button class="text-[11px] text-zinc-400 hover:text-zinc-300" onClick={() => startRename(e)}>重命名</button>
                        </Show>
                        <Show when={props.onDownload}>
                          <button
                            class="text-[11px] text-zinc-400 hover:text-zinc-300"
                            title="下载 tar"
                            onClick={() => props.onDownload!(join(e.name), e.name)}
                          >下载 tar</button>
                        </Show>
                        <Show when={props.onCopyToContainer}>
                          <button class="text-[11px] text-zinc-400 hover:text-zinc-300" onClick={() => props.onCopyToContainer!(join(e.name))}>复制到容器</button>
                        </Show>
                        <Show when={props.onDelete}>
                          <button class="text-[11px] text-red-900 hover:text-red-400" onClick={() => void doDelete(e)}>删除</button>
                        </Show>
                      </div>
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
        <Show when={sorted().length === 0}>
          <p class="py-4 text-center text-xs text-zinc-500">空目录</p>
        </Show>
        </div>
        <Show when={entries.loading}>
          <div class="pointer-events-none absolute left-1/2 top-12 -translate-x-1/2"><Spinner size={22} /></div>
        </Show>
       </div>
      </Show>
    </div>
  );
};
