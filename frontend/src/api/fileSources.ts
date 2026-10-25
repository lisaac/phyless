import { get, getToken, request } from "./client";
import { enqueue, queued } from "../stores/taskQueue";
import type { FileEntry, FileListing } from "../types";
import type { ChmodBody } from "../components/shared/PermissionModal";
import type { TarMeta } from "./dockerTar";

// Every FileBrowser in the app browses one of these. The endpoint table lives
// here once so the in-page browsers and the standalone window
// (FilesWindowPage) hit exactly the same API — closures can't cross into a
// window.open()'d popup, so the popup rebuilds its handlers from (kind, id).
export type FileSourceKind = "container" | "image" | "volume" | "compose" | "config";
export interface FileSourceRef { kind: FileSourceKind; id: string; name: string }

const e = encodeURIComponent;

// `stopped`: a container that is not running. Listing, download and upload
// still work (archive API); delete/rename/chmod only inside its mounts — the
// backend changes those through a browse container (see docs/file-browsing.md).
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
  const writable = kind !== "image";
  // Container and volume files go through the archive API (one tar file);
  // host files are a raw PUT of the content.
  const viaArchive = kind === "container" || kind === "volume";
  const joinName = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : dir + "/" + name);

  return {
    // Container/image/volume listings may run in a self-removing browse container;
    // the backend names it in X-Phyless-Helper so the browser can say so.
    listPath: async (sub: string): Promise<FileListing> => {
      let helper: FileListing["helper"];
      const entries = await request<FileEntry[]>("GET", url("", `path=${e(sub)}`), undefined, undefined, (h) => {
        const name = h.get("X-Phyless-Helper");
        if (name) helper = { name, life: Number(h.get("X-Phyless-Helper-Life")) || 0 };
      });
      return Object.assign(entries, { helper });
    },
    // Only what changed relative to the image (docker diff), directories kept.
    listDiff: kind !== "container" ? undefined : (sub: string) => get<FileEntry[]>(url("", `path=${e(sub)}&diff=1`)),
    // Names and change kinds only (no stat): marks A/C on a normal listing.
    listMarks: kind !== "container" ? undefined : (sub: string) => get<FileEntry[]>(url("", `path=${e(sub)}&diff=marks`)),
    // Tar stream of a file/dir — also what the read-only viewer opens files through.
    downloadUrl: (sub: string) => url("/download", `path=${e(sub)}&token=${e(getToken() ?? "")}`),
    upload: !writable ? undefined : async (dir: string, file: File) => {
      const t = await enqueue(viaArchive
        ? { title: `上传 ${file.name}`, url: url("/upload", `path=${e(dir)}&name=${e(file.name)}`), file, key }
        : { title: `上传 ${file.name}`, url: url("/content", `path=${e(joinName(dir, file.name))}`), method: "PUT", file, key }).done;
      if (t.status !== "done") throw new Error(t.error);
    },
    // The text editor's save: overwrite one file. Through the archive API the
    // original mode/owner ride along, or the tar entry would reset it to root 0644.
    saveText: !writable ? undefined : async (path: string, text: string, meta?: TarMeta) => {
      const slash = path.lastIndexOf("/");
      const dir = path.slice(0, slash) || "/", name = path.slice(slash + 1);
      const keep = meta ? `&mode=${meta.mode.toString(8)}&uid=${meta.uid}&gid=${meta.gid}` : "";
      const t = await enqueue(viaArchive
        ? { title: `保存 ${path}`, url: url("/upload", `path=${e(dir)}&name=${e(name)}${keep}`), file: new File([text], name), key }
        : { title: `保存 ${path}`, url: url("/content", `path=${e(path)}`), method: "PUT", file: new File([text], name), key }).done;
      if (t.status !== "done") throw new Error(t.error);
    },
    // Creating is a PUT with empty content — same endpoint the editors save through.
    create: kind === "compose" || kind === "config"
      ? async (path: string) => { await queued(`新建 ${path}`, "PUT", url("/content", `path=${e(path)}`), "", { key }); }
      : undefined,
    remove: !writable ? undefined : async (path: string) => {
      await queued(`删除 ${path}`, "DELETE", url("", `path=${e(path)}`), undefined, { key });
    },
    rename: !writable ? undefined : async (oldPath: string, newPath: string) => {
      await queued(`重命名 ${oldPath}`, "POST", url("/rename"), { old_path: oldPath, new_path: newPath }, { key });
    },
    chmod: !writable ? undefined : async (body: ChmodBody) => {
      await queued(`修改权限 ${body.path}`, "POST", url("/chmod"), body, { key });
    },
    // Writes reach only entries inside a mount (FileEntry.mount).
    mountsOnly: kind === "container" && !!opts.stopped,
  };
}

export const filesWindowUrl = (ref: FileSourceRef, path: string) =>
  `/files/${ref.kind}/${e(ref.id)}?${new URLSearchParams({ name: ref.name, path })}`;

// Shared by the console and file-browser "独立窗口" buttons.
export function openPopup(url: string, width = 960, height = 600) {
  window.open(url, "_blank", `width=${width},height=${height},menubar=no,toolbar=no,location=no,status=no,resizable=yes`);
}
