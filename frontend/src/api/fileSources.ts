import { get, getToken } from "./client";
import { enqueue, queued } from "../stores/taskQueue";
import type { FileEntry } from "../types";

// Every FileBrowser in the app browses one of these. The endpoint table lives
// here once so the in-page browsers and the standalone window
// (FilesWindowPage) hit exactly the same API — closures can't cross into a
// window.open()'d popup, so the popup rebuilds its handlers from (kind, id).
export type FileSourceKind = "container" | "image" | "volume" | "compose" | "config";
export interface FileSourceRef { kind: FileSourceKind; id: string; name: string }

const e = encodeURIComponent;

// `stopped`: a container that is not running. Listing, download and upload
// still work (archive API); delete/rename exec rm/mv inside it, so they don't.
export function fileSource(kind: FileSourceKind, id: string, opts: { stopped?: boolean } = {}) {
  const base = {
    container: `/api/containers/${e(id)}/files`,
    image: "/api/images/files",
    volume: `/api/volumes/${e(id)}/files`,
    compose: "/api/compose/files",
    config: "/api/config/files",
  }[kind];
  const idq = kind === "image" || kind === "compose" ? `id=${e(id)}&` : "";
  const url = (suffix: string, query = "") => `${base}${suffix}?${idq}${query}`;
  const key = kind === "compose" ? `compose:${id}` : kind === "config" ? "config" : id;
  const writable = kind === "container" || kind === "compose" || kind === "config";
  const execWrites = writable && !(kind === "container" && opts.stopped);
  const joinName = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : dir + "/" + name);

  return {
    listPath: (sub: string) => get<FileEntry[]>(url("", `path=${e(sub)}`)),
    // Only what changed relative to the image (docker diff), directories kept.
    listDiff: kind !== "container" ? undefined : (sub: string) => get<FileEntry[]>(url("", `path=${e(sub)}&diff=1`)),
    // Tar stream of a file/dir — also what the read-only viewer opens files through.
    downloadUrl: (sub: string) => url("/download", `path=${e(sub)}&token=${e(getToken() ?? "")}`),
    upload: !writable ? undefined : async (dir: string, file: File) => {
      const t = await enqueue(kind === "container"
        ? { title: `上传 ${file.name}`, url: url("/upload", `path=${e(dir)}&name=${e(file.name)}`), file, key }
        : { title: `上传 ${file.name}`, url: url("/content", `path=${e(joinName(dir, file.name))}`), method: "PUT", file, key }).done;
      if (t.status !== "done") throw new Error(t.error);
    },
    // Creating is a PUT with empty content — same endpoint the editors save through.
    create: kind === "compose" || kind === "config"
      ? async (path: string) => { await queued(`新建 ${path}`, "PUT", url("/content", `path=${e(path)}`), "", { key }); }
      : undefined,
    remove: !execWrites ? undefined : async (path: string) => {
      await queued(`删除 ${path}`, "DELETE", url("", `path=${e(path)}`), undefined, { key });
    },
    rename: !execWrites ? undefined : async (oldPath: string, newPath: string) => {
      await queued(`重命名 ${oldPath}`, "POST", url("/rename"), { old_path: oldPath, new_path: newPath }, { key });
    },
  };
}

export const filesWindowUrl = (ref: FileSourceRef, path: string) =>
  `/files/${ref.kind}/${e(ref.id)}?${new URLSearchParams({ name: ref.name, path })}`;

// Shared by the console and file-browser "独立窗口" buttons.
export function openPopup(url: string, width = 960, height = 600) {
  window.open(url, "_blank", `width=${width},height=${height},menubar=no,toolbar=no,location=no,status=no,resizable=yes`);
}
