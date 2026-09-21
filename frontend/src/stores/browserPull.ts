// Browser-pull runner: resolve → up-to-date check → assemble tar → stream to
// daemon. Kept out of taskQueue so it is unit-testable with injected deps; the
// queue wires note/progress/signal to a task's UI state.

import { buildDockerLoadTar } from "../api/dockerTar";
import { resolveImage, matchesRemote, remoteDigests, blobUrl, proxiedGet, authHeaderFromChallenge, registryResponseError, type Creds, type ResolvedImage } from "../api/registryPull";
import { streamTarToDaemon } from "../api/imageLoadStream";
import { get, imageInspectUrl } from "../api/client";
import { upgradeImageRef, imagePlatform } from "../api/inspect";

export interface BrowserPullParams {
  ref: string;
  platform: string;
  workerUrl: string;
  token: string;
  creds?: Creds;
}

export interface BrowserPullCallbacks {
  note: (msg: string) => void;
  progress?: (line: string) => void;
  signal: AbortSignal;
}

export interface BrowserPullDeps {
  resolveImage: typeof resolveImage;
  buildDockerLoadTar: typeof buildDockerLoadTar;
  streamTarToDaemon: typeof streamTarToDaemon;
  inspectLocal: (ref: string) => Promise<{ Id?: string; RepoDigests?: string[] } | null>;
  // Daemon OS/arch (e.g. "linux/arm64"), used when the caller left platform blank.
  daemonPlatform: () => Promise<string>;
  openLayer: (img: ResolvedImage, index: number, workerUrl: string, signal: AbortSignal, creds?: Creds) => Promise<ReadableStream<Uint8Array>>;
}

export const defaultDeps: BrowserPullDeps = {
  resolveImage,
  buildDockerLoadTar,
  streamTarToDaemon,
  inspectLocal: async (ref) => {
    try {
      return await get<{ Id?: string; RepoDigests?: string[] }>(imageInspectUrl(ref));
    } catch {
      return null; // not present locally (or inspect failed) — proceed to pull
    }
  },
  daemonPlatform: async () => {
    try {
      const p = await get<{ os?: string; architecture?: string }>("/api/system/platform");
      if (p?.os && p?.architecture) return `${p.os}/${p.architecture}`;
    } catch {
      /* fall back below */
    }
    return "linux/amd64";
  },
  openLayer: async (img, index, workerUrl, signal, creds) => {
    const layer = img.layers[index];
    const target = blobUrl(img.registryHost, img.repository, layer.digest);
    let resp = await proxiedGet(workerUrl, target, img.authHeader ? { Authorization: img.authHeader } : {}, signal);
    if (resp.status === 401) {
      // The manifest-phase token can expire before a large image finishes; get a
      // fresh one from the challenge and reuse it for the remaining layers.
      const wa = resp.headers.get("WWW-Authenticate");
      if (wa) {
        img.authHeader = await authHeaderFromChallenge(workerUrl, wa, creds, signal);
        resp = await proxiedGet(workerUrl, target, { Authorization: img.authHeader }, signal);
      }
    }
    if (!resp.ok) throw await registryResponseError(resp, "下载镜像层");
    if (!resp.body) throw new Error("下载镜像层失败：响应为空");
    return resp.body;
  },
};

export async function runBrowserPull(params: BrowserPullParams, cb: BrowserPullCallbacks, deps: BrowserPullDeps = defaultDeps): Promise<void> {
  if (cb.signal.aborted) throw new Error("已取消");
  cb.note("解析镜像信息…");
  const platform = params.platform?.trim() || (await deps.daemonPlatform());
  const img = await deps.resolveImage(params.ref, platform, params.workerUrl, params.creds, cb.signal);
  if (cb.signal.aborted) throw new Error("已取消");

  const local = await deps.inspectLocal(img.repoTag);
  if (cb.signal.aborted) throw new Error("已取消");
  if (matchesRemote(local, remoteDigests(img))) {
    cb.note("镜像已是最新，无需下载");
    return;
  }

  cb.note("经浏览器下载并流式导入…");
  const tar = deps.buildDockerLoadTar({
    configHex: img.config.hex,
    configBytes: img.config.bytes,
    layers: img.layers.map((l) => ({ hex: l.hex, size: l.size })),
    repoTag: img.repoTag,
    manifest: img.manifest,
    platform: img.platform,
    openLayer: (i) => deps.openLayer(img, i, params.workerUrl, cb.signal, params.creds),
  });
  await deps.streamTarToDaemon({ tar, token: params.token, onProgress: cb.progress, signal: cb.signal });
}

// --- Compose: preload every project image, then orchestrate locally ---

export interface ComposePullPlan {
  images: { service: string; ref: string; platform?: string }[];
  build_bases?: { service: string; ref: string; platform?: string }[];
  rejected: { service: string; ref: string; reason: string }[];
}

export interface BrowserPullComposeParams {
  id: string;
  mode: "pull" | "up" | "build";
  workerUrl: string;
  token: string;
  creds?: Creds;
}

export interface BrowserPullComposeDeps {
  fetchPlan: (id: string) => Promise<ComposePullPlan>;
  runBrowserPull: (params: BrowserPullParams, cb: BrowserPullCallbacks) => Promise<void>;
  // Runs `compose up` with pull_policy=never so the daemon uses the just-loaded
  // local images and never reaches out to the registry.
  composeUp: (id: string, token: string, onProgress: ((line: string) => void) | undefined, signal: AbortSignal) => Promise<void>;
  composeBuild: (id: string, token: string, onProgress: ((line: string) => void) | undefined, signal: AbortSignal) => Promise<void>;
}

const rejectReasonText: Record<string, string> = { build: "含 build", digest: "digest 引用" };

const MAX_STREAM_LINE = 256 * 1024;

// Shared streamed mutation path for browser-preload follow-up actions. It
// keeps body/progress parsing in one place for Compose, create and upgrade.
export async function streamPost(
  path: string,
  opts: { body?: unknown; token: string; onProgress?: (line: string) => void; signal: AbortSignal },
): Promise<void> {
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.token}` };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(path, {
    method: "POST",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (!resp.ok) throw await streamResponseError(resp);
  if (!resp.body) throw new Error("请求未返回进度流");
  const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  const consume = (line: string) => {
    const s = line.trim();
    if (!s) return;
    try {
      const evt = JSON.parse(s) as { error?: string; errorDetail?: { message?: string }; status?: string; stream?: string };
      if (evt.error || evt.errorDetail) throw new Error(evt.error || evt.errorDetail?.message || "请求失败");
      const progress = evt.stream ?? evt.status;
      if (progress) opts.onProgress?.(progress.trim());
    } catch (e) {
      if (e instanceof SyntaxError) { opts.onProgress?.(s); return; } // plain progress
      throw e;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      if (buf.length > MAX_STREAM_LINE) throw new Error("进度行过大");
      lines.forEach(consume);
    }
    if (buf) consume(buf);
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
}

async function streamResponseError(resp: Response): Promise<Error> {
  const raw = await resp.text().catch(() => "");
  let detail = raw.trim().slice(0, 4096);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError();
    const body = parsed as Record<string, unknown>;
    if (typeof body.error === "string") detail = body.error;
    else if (typeof body.message === "string") detail = body.message;
  } catch {
    // Keep a useful plain-text backend error.
  }
  const prefix = resp.status === 401 ? "未授权" : resp.status === 404 ? "请求目标不存在" : resp.status === 429 ? "请求过于频繁" : "请求失败";
  return new Error(`${prefix}（${resp.status}）${detail ? `：${detail}` : ""}`);
}

// Generic compose command streamer: POST /api/compose/<verb>, parse NDJSON,
// throw on an error event or non-ok status. Body/Content-Type only when a body
// is given (matches the XHR path — a bodyless verb sends no Content-Type).
export async function streamCompose(
  verb: string,
  id: string,
  opts: { body?: unknown; token: string; onProgress?: (line: string) => void; signal: AbortSignal },
): Promise<void> {
  return streamPost(`/api/compose/${verb}?id=${encodeURIComponent(id)}`, opts);
}

// Browser-preload a list of already-resolved service images (loops runBrowserPull).
// Reject policy stays with the caller — this only pulls what it is handed.
export async function preloadComposeImages(
  images: { service: string; ref: string; platform?: string }[],
  opts: { workerUrl: string; token: string; creds?: Creds },
  cb: BrowserPullCallbacks,
  runPull: (params: BrowserPullParams, cb: BrowserPullCallbacks) => Promise<void>,
): Promise<void> {
  for (const img of images) {
    cb.note(`拉取 ${img.service}：${img.ref}`);
    await runPull(
      { ref: img.ref, platform: img.platform ?? "", workerUrl: opts.workerUrl, token: opts.token, creds: opts.creds },
      { note: cb.note, progress: cb.progress, signal: cb.signal },
    );
  }
}

export const defaultComposeDeps: BrowserPullComposeDeps = {
  fetchPlan: (id) => get<ComposePullPlan>(`/api/compose/pull-plan?id=${encodeURIComponent(id)}`),
  runBrowserPull: (params, cb) => runBrowserPull(params, cb),
  composeUp: (id, token, onProgress, signal) => streamCompose("up", id, { body: { pull_policy: "never" }, token, onProgress, signal }),
  composeBuild: (id, token, onProgress, signal) => streamCompose("build", id, { token, onProgress, signal }),
};

export async function runBrowserPullCompose(
  params: BrowserPullComposeParams,
  cb: BrowserPullCallbacks,
  deps: BrowserPullComposeDeps = defaultComposeDeps,
): Promise<void> {
  cb.note("解析 Compose 项目镜像…");
  const plan = await deps.fetchPlan(params.id);
  if (cb.signal.aborted) throw new Error("已取消");
  if (params.mode === "build") {
    await preloadComposeImages(plan.build_bases ?? [], { workerUrl: params.workerUrl, token: params.token, creds: params.creds }, cb, deps.runBrowserPull);
    cb.note("构建 Compose 镜像…");
    await deps.composeBuild(params.id, params.token, cb.progress, cb.signal);
    return;
  }
  if (plan.rejected.length) {
    const detail = plan.rejected.map((r) => `${r.service}（${rejectReasonText[r.reason] ?? r.reason}）`).join("，");
    throw new Error(`以下服务无法用浏览器下载：${detail}。请改用服务端代理。`);
  }
  await preloadComposeImages(plan.images, { workerUrl: params.workerUrl, token: params.token, creds: params.creds }, cb, deps.runBrowserPull);
  if (params.mode === "up") {
    cb.note("启动 Compose（使用本地镜像）…");
    await deps.composeUp(params.id, params.token, cb.progress, cb.signal);
  } else {
    cb.note("镜像预加载完成");
  }
}

// Browser container create/upgrade keep the same serial preload → local mutation
// shape. The follow-up request always forces the server to use local images.
export interface BrowserActionParams {
  pull: BrowserPullParams;
  path: string;
  body: Record<string, unknown>;
  note?: string;
}

export interface BrowserActionDeps {
  runBrowserPull: (params: BrowserPullParams, cb: BrowserPullCallbacks) => Promise<void>;
  streamPost: typeof streamPost;
}

export const defaultActionDeps: BrowserActionDeps = { runBrowserPull, streamPost };

export async function runBrowserAction(
  params: BrowserActionParams,
  cb: BrowserPullCallbacks,
  deps: BrowserActionDeps = defaultActionDeps,
): Promise<void> {
  await deps.runBrowserPull(params.pull, cb);
  if (cb.signal.aborted) throw new Error("已取消");
  if (params.note) cb.note(params.note);
  await deps.streamPost(params.path, {
    body: params.body,
    token: params.pull.token,
    onProgress: cb.progress,
    signal: cb.signal,
  });
}

export interface BrowserCreateParams {
  ref: string;
  platform: string;
  workerUrl: string;
  token: string;
  creds?: Creds;
  body: Record<string, unknown>;
}

export async function runBrowserCreate(
  params: BrowserCreateParams,
  cb: BrowserPullCallbacks,
  deps: BrowserActionDeps = defaultActionDeps,
): Promise<void> {
  await runBrowserAction({
    pull: { ref: params.ref, platform: params.platform, workerUrl: params.workerUrl, token: params.token, creds: params.creds },
    path: "/api/containers",
    body: { ...params.body, pull_policy: "never" },
    note: "创建容器（使用本地镜像）…",
  }, cb, deps);
}

type UpgradeInspect = {
  Image?: string;
  Config?: { Image?: string; Labels?: Record<string, string> };
};
type ImageInspect = { Os?: string; Architecture?: string; Variant?: string };

function upgradeTarget(info: UpgradeInspect, image: ImageInspect): { ref: string; platform: string } {
  const ref = upgradeImageRef(info);
  const platform = imagePlatform(image);
  if (!ref.trim()) throw new Error("容器缺少可升级的镜像引用");
  if (!platform) throw new Error("原镜像平台信息缺失");
  return { ref, platform };
}

export interface BrowserUpgradeParams {
  id: string;
  envFromImage?: string[];
  workerUrl: string;
  token: string;
  creds?: Creds;
}

export interface BrowserUpgradeDeps {
  inspectContainer: (id: string) => Promise<UpgradeInspect>;
  inspectImage: (id: string) => Promise<ImageInspect>;
  runBrowserPull: (params: BrowserPullParams, cb: BrowserPullCallbacks) => Promise<void>;
  streamPost: typeof streamPost;
}

export const defaultUpgradeDeps: BrowserUpgradeDeps = {
  inspectContainer: (id) => get<UpgradeInspect>(`/api/containers/${encodeURIComponent(id)}/inspect`),
  inspectImage: (id) => get<ImageInspect>(imageInspectUrl(id)),
  ...defaultActionDeps,
};

export async function runBrowserUpgrade(
  params: BrowserUpgradeParams,
  cb: BrowserPullCallbacks,
  deps: BrowserUpgradeDeps = defaultUpgradeDeps,
): Promise<void> {
  cb.note("读取容器镜像信息…");
  const info = await deps.inspectContainer(params.id);
  if (cb.signal.aborted) throw new Error("已取消");
  const imageID = info.Image?.trim();
  if (!imageID) throw new Error("容器缺少可升级的镜像引用");
  const image = await deps.inspectImage(imageID);
  if (cb.signal.aborted) throw new Error("已取消");
  const target = upgradeTarget(info, image);
  await runBrowserAction({
    pull: { ref: target.ref, platform: target.platform, workerUrl: params.workerUrl, token: params.token, creds: params.creds },
    path: `/api/containers/${encodeURIComponent(params.id)}/upgrade`,
    body: { pull_policy: "never", ...(params.envFromImage?.length ? { env_from_image: params.envFromImage } : {}) },
    note: "升级容器（使用本地镜像）…",
  }, cb, deps);
}

// --- Compose pull/build and update ---
// One task, sequential, stop-on-failure. Update adds Down/Up after the image
// work; pull/build leaves existing containers untouched.

export interface ComposeUpdateParams {
  id: string;
  mode: "server" | "browser";
  canBuild: boolean;
  workerUrl?: string;
  token: string;
  creds?: Creds;
  pullOptions?: Record<string, unknown>;
  restart?: boolean;
}

export interface ComposeUpdateDeps {
  fetchPlan: (id: string) => Promise<ComposePullPlan>;
  runBrowserPull: (params: BrowserPullParams, cb: BrowserPullCallbacks) => Promise<void>;
  streamCompose: typeof streamCompose;
}

export const defaultUpdateDeps: ComposeUpdateDeps = {
  fetchPlan: (id) => get<ComposePullPlan>(`/api/compose/pull-plan?id=${encodeURIComponent(id)}`),
  runBrowserPull: (params, cb) => runBrowserPull(params, cb),
  streamCompose,
};

export async function runComposeUpdate(
  params: ComposeUpdateParams,
  cb: BrowserPullCallbacks,
  deps: ComposeUpdateDeps = defaultUpdateDeps,
): Promise<void> {
  const { id, token } = params;
  const signal = cb.signal;
  let plan: ComposePullPlan | undefined;

  if (params.canBuild || params.mode === "browser") {
    cb.note("解析 Compose 项目镜像…");
    plan = await deps.fetchPlan(id);
    if (signal.aborted) throw new Error("已取消");
    if (params.mode === "browser") {
      const blocked = plan.rejected.filter((r) => r.reason !== "build");
      if (blocked.length) {
        const detail = blocked.map((r) => `${r.service}（${rejectReasonText[r.reason] ?? r.reason}）`).join("，");
        throw new Error(`以下服务无法用浏览器下载：${detail}。请改用服务端代理。`);
      }
    }
  }

  if (params.mode === "browser") {
    if (params.canBuild) {
      await preloadComposeImages(plan?.build_bases ?? [], { workerUrl: params.workerUrl ?? "", token, creds: params.creds }, cb, deps.runBrowserPull);
      cb.note("构建镜像…");
      await deps.streamCompose("build", id, { token, onProgress: cb.progress, signal });
    }
    await preloadComposeImages(plan?.images ?? [], { workerUrl: params.workerUrl ?? "", token, creds: params.creds }, cb, deps.runBrowserPull);
  } else {
    // The plan tells the frontend whether this project also has pull-only
    // services. Pull first so a service declaring both image and build still
    // ends with the locally built image.
    if (!params.canBuild || (plan?.images.length ?? 0) > 0) {
      cb.note("拉取镜像…");
      await deps.streamCompose("pull", id, { body: params.pullOptions, token, onProgress: cb.progress, signal });
    }
    if (params.canBuild) {
      cb.note("构建镜像…");
      await deps.streamCompose("build", id, { body: params.pullOptions, token, onProgress: cb.progress, signal });
    }
  }

  if (!params.restart) return;

  cb.note("停止并移除旧容器…");
  await deps.streamCompose("down", id, { token, onProgress: cb.progress, signal });

  cb.note("启动 Compose（使用本地镜像）…");
  await deps.streamCompose("up", id, { body: { pull_policy: "never" }, token, onProgress: cb.progress, signal });

}
