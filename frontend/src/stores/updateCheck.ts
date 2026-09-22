import { createSignal } from "solid-js";
import { get, imageInspectUrl, request } from "../api/client";
import { resolveImage, matchesRemote, remoteDigests, type Creds, type RemoteDigests } from "../api/registryPull";
import { upgradeImageRef, imagePlatform, envDifferingFromImage, type EnvCandidate } from "../api/inspect";
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

// Earlier phyless upgrades copied the whole Config, including the previous
// image's ENV, into the replacement. On such a container (marked by the pin
// label) a variable differing from the current image may be a stale default
// or a deliberate override — only the user can tell, so the upgrade dialog asks.
export async function staleEnvCandidates(
  id: string,
  fetch: <T>(path: string) => Promise<T> = get,
): Promise<EnvCandidate[]> {
  type EnvInspect = { Image?: string; Config?: { Env?: string[] | null } };
  const info = await fetch<EnvInspect>(`/api/containers/${encodeURIComponent(id)}/inspect`);
  if (!info.Image) return [];
  const image = await fetch<EnvInspect>(imageInspectUrl(info.Image));
  return envDifferingFromImage(info.Config?.Env, image.Config?.Env);
}

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
  post: (body: unknown, signal: AbortSignal) => Promise<Omit<UpdateCheck, "checkedAt">[]>;
  inspectContainer: (id: string, signal: AbortSignal) => Promise<Inspect>;
  inspectImage: (ref: string, signal: AbortSignal) => Promise<ImageInfo | null>;
  resolve: (ref: string, platform: string, workerUrl: string, creds: Creds | undefined, signal: AbortSignal) => Promise<RemoteDigests>;
}

export const defaultUpdateCheckDeps: UpdateCheckDeps = {
  post: (body, signal) => request("POST", "/api/containers/check-updates", body, signal),
  inspectContainer: (id, signal) => get<Inspect>(`/api/containers/${encodeURIComponent(id)}/inspect`, signal),
  inspectImage: (ref, signal) => get<ImageInfo>(imageInspectUrl(ref), signal).catch(() => null),
  resolve: async (ref, platform, workerUrl, creds, signal) => {
    // ponytail: resolveImage also fetches the (small) config blob; a manifest-only variant saves one request per image.
    return remoteDigests(await resolveImage(ref, platform, workerUrl, creds, signal));
  },
};

const tagRef = (ref: string) => !!ref && !ref.startsWith("sha256:") && !ref.includes("@");


export async function runUpdateCheck(p: UpdateCheckParams, cb: BrowserPullCallbacks, deps: UpdateCheckDeps = defaultUpdateCheckDeps): Promise<void> {
  const aborted = () => { if (cb.signal.aborted) throw new Error("已取消"); };
  let results: Omit<UpdateCheck, "checkedAt">[];
  if (p.mode === "server") {
    cb.note(`服务端检查 ${p.ids.length} 个容器…`);
    results = await deps.post({ ids: p.ids, ...p.pullOptions }, cb.signal);
  } else {
    if (!p.workerUrl?.trim()) throw new Error("未配置 CF worker 地址");
    results = [];
    const remotes = new Map<string, Promise<RemoteDigests>>();
    // Containers commonly share images and tags; inspect each once.
    const images = new Map<string, Promise<ImageInfo | null>>();
    const inspectImage = (ref: string) => {
      if (!images.has(ref)) images.set(ref, deps.inspectImage(ref, cb.signal));
      return images.get(ref)!;
    };
    for (const [i, id] of p.ids.entries()) {
      aborted();
      const r: Omit<UpdateCheck, "checkedAt"> = { id, ref: "", status: "error", local_id: "" };
      results.push(r);
      try {
        const info = await deps.inspectContainer(id, cb.signal);
        r.id = info.Id || id;
        r.local_id = info.Image ?? "";
        r.ref = upgradeImageRef(info);
        if (!tagRef(r.ref) || r.ref === r.local_id) { r.status = "unsupported"; r.error = "镜像不是 registry tag 引用"; continue; }
        const cur = await inspectImage(r.local_id);
        if (!cur?.Id) throw new Error("无法读取容器当前镜像");
        const platform = imagePlatform(cur);
        const key = `${r.ref}|${platform}`;
        cb.note(`检查 ${i + 1}/${p.ids.length}：${r.ref}`);
        const tag = await inspectImage(r.ref);
        const tagMoved = !!tag?.Id && tag.Id !== r.local_id;
        let remote: RemoteDigests;
        try {
          if (!remotes.has(key)) remotes.set(key, deps.resolve(r.ref, platform, p.workerUrl, p.creds, cb.signal));
          remote = await remotes.get(key)!;
        } catch (e) {
          aborted();
          if (tagMoved) { r.status = "local-newer"; continue; }
          throw e;
        }
        r.remote_id = remote.config;
        r.status = matchesRemote(cur, remote) ? "latest" : tagMoved && matchesRemote(tag, remote) ? "local-newer" : "update";
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
