import { createSignal } from "solid-js";
import { get, imageInspectUrl, request } from "../api/client";
import { resolveImage, type Creds } from "../api/registryPull";
import type { BrowserPullCallbacks } from "./browserPull";

// "Is there a newer image?" results, keyed by container id. Server mode asks
// POST /api/containers/check-updates (same network path as a pull with the
// chosen proxy); browser mode resolves manifests through the CF worker. Both
// land here and are persisted per browser — a viewer convenience, not truth.

export type UpdateStatus = "update" | "local-newer" | "latest" | "unsupported" | "error";
export interface UpdateCheck {
  id: string;
  ref: string;
  status: UpdateStatus;
  local_id: string;
  remote_id?: string;
  error?: string;
  checkedAt: number;
}

const KEY = "phyless_update_checks";
const MAX_AGE = 30 * 24 * 3600_000;

function load(): Record<string, UpdateCheck> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, UpdateCheck>;
    const now = Date.now();
    return Object.fromEntries(Object.entries(raw).filter(([, c]) => c && now - c.checkedAt < MAX_AGE));
  } catch {
    return {};
  }
}

const [checks, setChecks] = createSignal<Record<string, UpdateCheck>>(load());

export function recordChecks(results: Omit<UpdateCheck, "checkedAt">[]): void {
  const checkedAt = Date.now();
  const next = { ...checks() };
  for (const r of results) next[r.id] = { ...r, checkedAt };
  setChecks(next);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage disabled — memory still works */ }
}

// A result only describes the image the container had when it was checked:
// once the container runs another image (upgraded / recreated) it no longer applies.
export function updateCheckFor(id: string, imageId?: string): UpdateCheck | undefined {
  const c = checks()[id];
  return c && (!imageId || c.local_id === imageId) ? c : undefined;
}

export const isUpgradable = (c?: UpdateCheck) => c?.status === "update" || c?.status === "local-newer";

export const UPDATE_LABEL: Record<UpdateStatus, string> = {
  update: "可升级", "local-newer": "待重建", latest: "已是最新", unsupported: "不支持", error: "检查失败",
};

// ── Runner (executed by taskQueue as a "update-check" task) ──────────────────

export interface UpdateCheckParams {
  ids: string[];
  mode: "server" | "browser";
  pullOptions?: Record<string, unknown>;
  workerUrl?: string;
  creds?: Creds;
}

type Inspect = { Id?: string; Image?: string; Config?: { Image?: string; Labels?: Record<string, string> } };
type ImageInfo = { Id?: string; Os?: string; Architecture?: string; Variant?: string; RepoDigests?: string[] };

export interface UpdateCheckDeps {
  post: (body: unknown) => Promise<Omit<UpdateCheck, "checkedAt">[]>;
  inspectContainer: (id: string) => Promise<Inspect>;
  inspectImage: (ref: string) => Promise<ImageInfo | null>;
  resolve: (ref: string, platform: string, workerUrl: string, creds: Creds | undefined, signal: AbortSignal) => Promise<{ config: string; manifest: string }>;
}

export const defaultUpdateCheckDeps: UpdateCheckDeps = {
  post: (body) => request("POST", "/api/containers/check-updates", body),
  inspectContainer: (id) => get<Inspect>(`/api/containers/${encodeURIComponent(id)}/inspect`),
  inspectImage: (ref) => get<ImageInfo>(imageInspectUrl(ref)).catch(() => null),
  resolve: async (ref, platform, workerUrl, creds, signal) => {
    // ponytail: resolveImage also fetches the (small) config blob; a manifest-only variant saves one request per image.
    const img = await resolveImage(ref, platform, workerUrl, creds, signal);
    return { config: `sha256:${img.config.hex}`, manifest: img.manifest.digest };
  },
};

const tagRef = (ref: string) => !!ref && !ref.startsWith("sha256:") && !ref.includes("@");

// Browser-mode equivalent of the backend's matchesRemote. Images loaded by the
// browser/proxy paths have no RepoDigests, so the config digest is the anchor.
function sameImage(img: ImageInfo | null, r: { config: string; manifest: string }): boolean {
  if (!img?.Id) return false;
  if (img.Id === r.config || img.Id === r.manifest) return true;
  return (img.RepoDigests ?? []).some((d) => d.endsWith(`@${r.manifest}`));
}

export async function runUpdateCheck(p: UpdateCheckParams, cb: BrowserPullCallbacks, deps: UpdateCheckDeps = defaultUpdateCheckDeps): Promise<void> {
  const aborted = () => { if (cb.signal.aborted) throw new Error("已取消"); };
  let results: Omit<UpdateCheck, "checkedAt">[];
  if (p.mode === "server") {
    cb.note(`服务端检查 ${p.ids.length} 个容器…`);
    results = await deps.post({ ids: p.ids, ...p.pullOptions });
  } else {
    if (!p.workerUrl?.trim()) throw new Error("未配置 CF worker 地址");
    results = [];
    const remotes = new Map<string, Promise<{ config: string; manifest: string }>>();
    for (const [i, id] of p.ids.entries()) {
      aborted();
      const r: Omit<UpdateCheck, "checkedAt"> = { id, ref: "", status: "error", local_id: "" };
      results.push(r);
      try {
        const info = await deps.inspectContainer(id);
        r.id = info.Id || id;
        r.local_id = info.Image ?? "";
        r.ref = info.Config?.Labels?.["io.phyless.upgrade-image-ref"] || info.Config?.Image || "";
        if (!tagRef(r.ref) || r.ref === r.local_id) { r.status = "unsupported"; r.error = "镜像不是 registry tag 引用"; continue; }
        const cur = await deps.inspectImage(r.local_id);
        const platform = cur?.Os && cur.Architecture ? `${cur.Os}/${cur.Architecture}${cur.Variant ? `/${cur.Variant}` : ""}` : "";
        const key = `${r.ref}|${platform}`;
        cb.note(`检查 ${i + 1}/${p.ids.length}：${r.ref}`);
        if (!remotes.has(key)) remotes.set(key, deps.resolve(r.ref, platform, p.workerUrl, p.creds, cb.signal));
        const tag = await deps.inspectImage(r.ref);
        const tagMoved = !!tag?.Id && tag.Id !== r.local_id;
        let remote: { config: string; manifest: string };
        try {
          remote = await remotes.get(key)!;
        } catch (e) {
          aborted();
          if (tagMoved) { r.status = "local-newer"; continue; }
          throw e;
        }
        r.remote_id = remote.config;
        r.status = sameImage(cur, remote) ? "latest" : tagMoved && sameImage(tag, remote) ? "local-newer" : "update";
      } catch (e) {
        aborted();
        r.status = "error";
        r.error = e instanceof Error ? e.message : String(e);
      }
    }
  }
  aborted();
  recordChecks(results);
  const n = (s: UpdateStatus) => results.filter((r) => r.status === s).length;
  cb.note(`可升级 ${n("update") + n("local-newer")} · 已是最新 ${n("latest")} · 不支持 ${n("unsupported")} · 失败 ${n("error")}`);
}
