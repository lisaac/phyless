import { Component, createSignal, Show } from "solid-js";
import { FileBrowser } from "../shared/FileBrowser";
import { CodeEditor } from "../shared/CodeEditor";
import { Button } from "../shared/Button";
import { UploadStatusWidget } from "../shared/UploadStatusWidget";
import { get, put, post, del, getToken, setToken } from "../../api/client";
import { looksTextFile, fetchTextFile } from "../../api/textFile";
import { streamDownload, fmtBytes } from "../../api/download";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import type { FileEntry } from "../../types";

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
  const [saving, setSaving] = createSignal(false);

  const listFiles = (sub: string) =>
    get<FileEntry[]>(`/api/config/files?path=${encodeURIComponent(sub)}`);

  const openFile = async (path: string) => {
    if (!looksTextFile(path) && !confirm(`${path.split("/").pop()} 看起来不是文本文件，仍要打开？`)) return;
    try {
      const result = await fetchTextFile(`/api/config/files/content?path=${encodeURIComponent(path)}`);
      if (!result) return;
      setOpenPath(path);
      setContent(result.text);
      setTruncated(result.truncated);
    } catch (e) { toast.error((e as Error).message); }
  };

  const save = async () => {
    setSaving(true);
    try {
      await put(`/api/config/files/content?path=${encodeURIComponent(openPath())}`, content());
      toast.success("已保存");
    } catch (e) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  // Create/delete/rename operate directly on /etc (internal/api/config.go's
  // handleConfig{Delete,Rename}File) — creating is just a PUT with empty
  // content, same endpoint the editor already saves through.
  const createFile = async (path: string) => {
    await put(`/api/config/files/content?path=${encodeURIComponent(path)}`, "");
  };
  const deleteFile = async (path: string) => {
    await del(`/api/config/files?path=${encodeURIComponent(path)}`);
    if (openPath() === path) setOpenPath("");
  };
  const renameFile = async (oldPath: string, newPath: string) => {
    await post("/api/config/files/rename", { old_path: oldPath, new_path: newPath });
    if (openPath() === oldPath) setOpenPath(newPath);
  };

  // Upload/download — same PUT-raw-bytes endpoint the editor saves through
  // for upload (XHR, since fetch() has no upload-progress events), and the
  // tar-streaming endpoint for download (fetch + a reader loop, since the
  // exact tar size isn't known upfront to compute a percentage).
  const [uploadState, setUploadState] = createSignal({ active: false, filename: "", progress: 0, done: false, error: "" });
  let uploadXhr: XMLHttpRequest | undefined;
  const uploadFile = (sub: string, file: File) => new Promise<void>((resolve, reject) => {
    setUploadState({ active: true, filename: file.name, progress: 0, done: false, error: "" });
    const xhr = new XMLHttpRequest();
    uploadXhr = xhr;
    xhr.open("PUT", `/api/config/files/content?path=${encodeURIComponent(sub.endsWith("/") ? sub + file.name : sub + "/" + file.name)}`);
    xhr.setRequestHeader("Authorization", `Bearer ${getToken() ?? ""}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setUploadState((s) => ({ ...s, progress: (e.loaded / e.total) * 100 }));
    };
    xhr.onload = () => {
      if (xhr.status === 401) {
        setToken(null);
        window.dispatchEvent(new CustomEvent("phyless:unauthorized"));
        setUploadState((s) => ({ ...s, done: true, error: "未授权" }));
        reject(new Error("unauthorized"));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        setUploadState((s) => ({ ...s, progress: 100, done: true }));
        resolve();
      } else {
        const msg = xhr.responseText || `上传失败 (${xhr.status})`;
        setUploadState((s) => ({ ...s, done: true, error: msg }));
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => {
      setUploadState((s) => ({ ...s, done: true, error: "网络错误" }));
      reject(new Error("network error"));
    };
    xhr.onabort = () => {
      setUploadState((s) => ({ ...s, done: true }));
      reject(new Error("aborted"));
    };
    xhr.send(file);
  });

  const [downloadState, setDownloadState] = createSignal({ active: false, filename: "", bytes: 0, done: false, error: "" });
  const downloadFile = async (sub: string, name: string) => {
    const filename = `${name}.tar`;
    setDownloadState({ active: true, filename, bytes: 0, done: false, error: "" });
    try {
      await streamDownload(
        `/api/config/files/download?path=${encodeURIComponent(sub)}`,
        filename,
        (bytes) => setDownloadState((s) => ({ ...s, bytes })),
      );
      setDownloadState((s) => ({ ...s, done: true }));
    } catch (e) { setDownloadState((s) => ({ ...s, done: true, error: (e as Error).message })); }
  };

  return (
    <div>
      <h1 class="mb-3 text-xl font-semibold">配置文件</h1>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="h-[calc(100vh-13rem)] overflow-auto border border-zinc-800 p-2">
          <FileBrowser
            listPath={listFiles}
            onOpenFile={openFile}
            onCreate={hasRole("operator") ? createFile : undefined}
            onDelete={hasRole("operator") ? deleteFile : undefined}
            onRename={hasRole("operator") ? renameFile : undefined}
            onUpload={hasRole("operator") ? uploadFile : undefined}
            onDownload={downloadFile}
          />
        </div>
        <div class="sticky top-4 flex h-[calc(100vh-13rem)] flex-col">
          <div class="mb-1 flex items-center justify-between">
            <span class="truncate font-mono text-xs text-zinc-400">{openPath() || "未选择文件"}</span>
            <Show when={hasRole("operator") && openPath()}>
              <Button
                variant="primary"
                disabled={saving() || truncated()}
                title={truncated() ? "文件过大，内容已被截断，无法安全保存" : undefined}
                onClick={save}
              >保存</Button>
            </Show>
          </div>
          <Show when={truncated()}>
            <p class="mb-1 text-xs text-amber-400">文件过大，仅加载了前 2MB，已禁用保存以免截断覆盖原文件。</p>
          </Show>
          <div class="min-h-0 flex-1">
            <Show when={openPath()} fallback={<div class="flex h-full items-center justify-center text-xs text-zinc-500">点击左侧文件开始编辑</div>}>
              <CodeEditor value={content()} onChange={setContent} language={langFor(openPath())} />
            </Show>
          </div>
        </div>
      </div>

      <UploadStatusWidget
        active={uploadState().active}
        filename={uploadState().filename}
        progress={uploadState().progress}
        done={uploadState().done}
        error={uploadState().error}
        onClose={() => { uploadXhr?.abort(); setUploadState((s) => ({ ...s, active: false })); }}
      />
      <UploadStatusWidget
        active={downloadState().active}
        label="下载"
        filename={downloadState().filename}
        bytesLabel={fmtBytes(downloadState().bytes)}
        done={downloadState().done}
        error={downloadState().error}
        onClose={() => setDownloadState((s) => ({ ...s, active: false }))}
      />
    </div>
  );
};
