import { Component, createSignal, Show, onCleanup } from "solid-js";
import { FileBrowser } from "../shared/FileBrowser";
import { fileSource } from "../../api/fileSources";
import { CodeEditor } from "../shared/CodeEditor";
import { Button, PageHeader } from "../shared/Button";
import { UploadStatusWidget } from "../shared/UploadStatusWidget";
import { queued } from "../../stores/taskQueue";
import { confirmOpenText, fetchTextFile } from "../../api/textFile";
import { streamDownload, fmtBytes } from "../../api/download";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import { canSaveFile, createLatestFileRequest } from "../../stores/latestFile";

// pick CodeMirror language from extension
function langFor(name: string): "yaml" | "json" | "text" {
  if (/\.(ya?ml)$/i.test(name)) return "yaml";
  if (/\.json$/i.test(name)) return "json";
  return "text";
}

// Layout/behavior mirrors ComposeDetailPage's "文件" tab (same responsive
// grid, same non-text-file confirm guard, same 2MB-truncation handling) —
// both browse+edit arbitrary files under a root directory, just a different
// root (/etc here vs. a compose project's BaseDir there).
export const ConfigFilesPage: Component = () => {
  const [openPath, setOpenPath] = createSignal("");
  const [content, setContent] = createSignal("");
  const [truncated, setTruncated] = createSignal(false);
  const [loadingFile, setLoadingFile] = createSignal(false);
  const [loadError, setLoadError] = createSignal("");
  const [loadedPath, setLoadedPath] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const fileRequest = createLatestFileRequest();

  const files = fileSource("config", "-");

  const openFile = async (path: string) => {
    if (!await confirmOpenText(path)) return;
    const request = fileRequest.begin({ id: "config", path });
    setOpenPath(path);
    setContent("");
    setTruncated(false);
    setLoadError("");
    setLoadedPath("");
    setLoadingFile(true);
    try {
      const result = await fetchTextFile(`/api/config/files/content?path=${encodeURIComponent(path)}`, request.signal);
      if (!fileRequest.isCurrent(request)) return;
      if (!result) { setLoadError("未授权"); return; }
      setContent(result.text);
      setTruncated(result.truncated);
      setLoadedPath(path);
    } catch (e) {
      if (fileRequest.isCurrent(request)) {
        setLoadError((e as Error).message);
        toast.error((e as Error).message);
      }
    } finally {
      if (fileRequest.isCurrent(request)) setLoadingFile(false);
    }
  };

  const save = async () => {
    const loaded = loadedPath() ? { id: "config", path: loadedPath() } : undefined;
    if (!canSaveFile(loaded, { id: "config", path: openPath() }, loadingFile(), loadError(), truncated())) {
      toast.error(loadingFile() ? "文件仍在加载" : truncated() ? "文件过大，无法安全保存" : "文件加载失败，无法保存");
      return;
    }
    setSaving(true);
    try {
      await queued(`保存 ${openPath()}`, "PUT", `/api/config/files/content?path=${encodeURIComponent(openPath())}`, content(), { key: "config" });
      toast.success("已保存");
    } catch (e) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  // Create/delete/rename operate directly on /etc (backend/internal/api/config.go's
  // handleConfig{Delete,Rename}File) — creating is just a PUT with empty
  // content, same endpoint the editor already saves through.
  const deleteFile = async (path: string) => {
    await files.remove!(path);
    if (openPath() === path) setOpenPath("");
  };
  const renameFile = async (oldPath: string, newPath: string) => {
    await files.rename!(oldPath, newPath);
    if (openPath() === oldPath) setOpenPath(newPath);
  };

  // Upload/download — same PUT-raw-bytes endpoint the editor saves through
  // for upload (XHR, since fetch() has no upload-progress events), and the
  // tar-streaming endpoint for download (fetch + a reader loop, since the
  // exact tar size isn't known upfront to compute a percentage).
  const [downloadState, setDownloadState] = createSignal({ active: false, filename: "", bytes: 0, done: false, error: "" });
  let downloadController: AbortController | undefined;
  let downloadGeneration = 0;
  const downloadFile = async (sub: string, name: string) => {
    downloadController?.abort();
    const generation = ++downloadGeneration;
    const controller = new AbortController();
    const filename = `${name}.tar`;
    downloadController = controller;
    setDownloadState({ active: true, filename, bytes: 0, done: false, error: "" });
    try {
      await streamDownload(
        `/api/config/files/download?path=${encodeURIComponent(sub)}`,
        filename,
        (bytes) => setDownloadState((s) => ({ ...s, bytes })),
        controller.signal,
      );
      if (generation === downloadGeneration) setDownloadState((s) => ({ ...s, done: true }));
    } catch (e) {
      if (generation === downloadGeneration) setDownloadState((s) => ({ ...s, done: true, error: (e as Error).message }));
    } finally {
      if (downloadController === controller) downloadController = undefined;
    }
  };
  onCleanup(() => { fileRequest.cancel(); downloadGeneration++; downloadController?.abort(); });

  return (
    <div>
      <PageHeader title="本机配置" />
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="h-[calc(100vh-13rem)] overflow-auto border border-zinc-800 p-2">
          <FileBrowser
            listPath={files.listPath}
            onOpenFile={openFile}
            onCreate={hasRole("operator") ? files.create : undefined}
            onDelete={hasRole("operator") ? deleteFile : undefined}
            onRename={hasRole("operator") ? renameFile : undefined}
            onChmod={hasRole("operator") ? files.chmod : undefined}
            onUpload={hasRole("operator") ? files.upload : undefined}
            onDownload={downloadFile}
            popout={{ kind: "config", id: "-", name: "本机配置" }}
          />
        </div>
        <div class="sticky top-4 flex h-[calc(100vh-13rem)] flex-col">
          <div class="mb-1 flex items-center justify-between">
            <span class="truncate font-mono text-xs text-zinc-400">{openPath() || "未选择文件"}</span>
            <Show when={hasRole("operator") && openPath()}>
              <Button
                variant="primary"
                disabled={saving() || !canSaveFile(loadedPath() ? { id: "config", path: loadedPath() } : undefined, { id: "config", path: openPath() }, loadingFile(), loadError(), truncated())}
                title={truncated() ? "文件过大，内容已被截断，无法安全保存" : loadingFile() ? "文件加载中" : loadError() || undefined}
                onClick={save}
              >保存</Button>
            </Show>
          </div>
          <Show when={truncated()}>
            <p class="mb-1 text-xs text-amber-400">文件过大，仅加载了前 2MB，已禁用保存以免截断覆盖原文件。</p>
          </Show>
          <Show when={loadingFile()}><p class="mb-1 text-xs text-zinc-500">文件加载中…</p></Show>
          <Show when={loadError()}><p class="mb-1 text-xs text-red-400">{loadError()}</p></Show>
          <div class="min-h-0 flex-1">
            <Show when={openPath()} fallback={<div class="flex h-full items-center justify-center text-xs text-zinc-500">点击左侧文件开始编辑</div>}>
              <CodeEditor value={content()} onChange={setContent} language={langFor(openPath())} />
            </Show>
          </div>
        </div>
      </div>

      <UploadStatusWidget
        active={downloadState().active}
        label="下载"
        filename={downloadState().filename}
        bytesLabel={fmtBytes(downloadState().bytes)}
        done={downloadState().done}
        error={downloadState().error}
        onClose={() => { downloadGeneration++; downloadController?.abort(); setDownloadState((s) => ({ ...s, active: false })); }}
      />
    </div>
  );
};
