import { Component, createEffect, createSignal, onCleanup, Show } from "solid-js";
import { useParams, useSearchParams } from "@solidjs/router";
import { FileBrowser } from "./FileBrowser";
import { TarTextViewer } from "./TarTextViewer";
import { DownloadStatusWidget } from "./UploadStatusWidget";
import { createDownloadTask } from "../../api/download";
import { confirmOpenText } from "../../api/textFile";
import { fileSource, type FileSourceKind } from "../../api/fileSources";
import { currentUser, hasRole } from "../../stores/auth";

// Standalone file-browser window, the file-side twin of TerminalWindowPage:
// a top-level route outside Guard/Layout, opened via FileBrowser's "独立窗口"
// button. Handlers are rebuilt from (kind, id) via fileSource; files open in
// the read-only tar viewer (editing stays in the main window's editor).
const KIND_LABEL: Record<FileSourceKind, string> = {
  container: "容器", image: "镜像", volume: "存储卷", compose: "Compose", config: "本机配置",
};

export const FilesWindowPage: Component = () => {
  const params = useParams();
  const [search, setSearch] = useSearchParams();
  const kind = () => params.kind as FileSourceKind;
  // Router params stay percent-encoded (an image id "sha256:…" arrives as
  // "sha256%3A…"); fileSource encodes again, so decode once here.
  const id = () => decodeURIComponent(params.id);
  const src = () => fileSource(kind(), id());
  const op = () => hasRole("operator");
  const name = () => (search.name as string) || id();

  createEffect(() => { document.title = `文件 · ${name()}`; });

  const download = createDownloadTask();
  onCleanup(() => download.cancel());
  const [viewPath, setViewPath] = createSignal<string | null>(null);
  const viewUrl = () => { const p = viewPath(), u = src().downloadUrl; return p && u ? u(p) : null; };

  return (
    <Show when={currentUser()} fallback={<p class="p-8 text-sm text-zinc-500">未登录，请先在主窗口登录。</p>}>
      <div class="min-h-screen bg-zinc-950 p-3">
        <div class="mb-3 flex min-w-0 items-baseline gap-2 border-b border-zinc-800 pb-2">
          <span class="shrink-0 border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-400">{KIND_LABEL[kind()] ?? kind()}</span>
          {/* 本机配置 has no name/id of its own — the label says it all. */}
          <Show when={kind() !== "config"}>
            <span class="truncate text-sm font-semibold text-zinc-200" title={name()}>{name()}</span>
            <Show when={id() !== name()}>
              <span class="truncate font-mono text-[11px] text-zinc-500" title={id()}>{id()}</span>
            </Show>
          </Show>
        </div>
        <FileBrowser
          instanceKey={`${kind()}:${id()}`}
          initialPath={(search.path as string) || "/"}
          onPathChange={(path) => setSearch({ path }, { replace: true })}
          listPath={(sub) => src().listPath(sub)}
          onDownload={src().downloadUrl ? (sub, n) => download.start(src().downloadUrl!(sub), `${n}.tar`) : undefined}
          onOpenFile={src().downloadUrl ? async (p) => { if (await confirmOpenText(p)) setViewPath(p); } : undefined}
          onUpload={op() ? src().upload : undefined}
          onCreate={op() ? src().create : undefined}
          onDelete={op() ? src().remove : undefined}
          onRename={op() ? src().rename : undefined}
        />
      </div>
      <DownloadStatusWidget task={download} />
      <TarTextViewer url={viewUrl()} path={viewPath() ?? ""} onClose={() => setViewPath(null)} />
    </Show>
  );
};
