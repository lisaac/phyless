// Browser-pull runner: resolve → up-to-date check → assemble tar → stream to
// daemon. Kept out of taskQueue so it is unit-testable with injected deps; the
// queue wires note/progress/signal to a task's UI state.

import { buildDockerLoadTar } from "../api/dockerTar";
import { resolveImage, layerBlobUrl, authHeaderFromChallenge, type Creds, type ResolvedImage } from "../api/registryPull";
import { streamTarToDaemon } from "../api/imageLoadStream";
import { get } from "../api/client";

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
  inspectLocalId: (ref: string) => Promise<string | null>;
  // Daemon OS/arch (e.g. "linux/arm64"), used when the caller left platform blank.
  daemonPlatform: () => Promise<string>;
  openLayer: (img: ResolvedImage, index: number, workerUrl: string, signal: AbortSignal, creds?: Creds) => Promise<ReadableStream<Uint8Array>>;
}

export const defaultDeps: BrowserPullDeps = {
  resolveImage,
  buildDockerLoadTar,
  streamTarToDaemon,
  inspectLocalId: async (ref) => {
    try {
      const info = await get<{ Id?: string }>(`/api/images/inspect?id=${encodeURIComponent(ref)}`);
      return info?.Id ?? null;
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
    const url = layerBlobUrl(workerUrl, img.registryHost, img.repository, layer.digest);
    let resp = await fetch(url, { headers: img.authHeader ? { Authorization: img.authHeader } : {}, signal });
    if (resp.status === 401) {
      // The manifest-phase token can expire before a large image finishes; get a
      // fresh one from the challenge and reuse it for the remaining layers.
      const wa = resp.headers.get("WWW-Authenticate");
      if (wa) {
        img.authHeader = await authHeaderFromChallenge(workerUrl, wa, creds);
        resp = await fetch(url, { headers: { Authorization: img.authHeader }, signal });
      }
    }
    if (!resp.ok || !resp.body) throw new Error(`下载镜像层失败（${resp.status}）`);
    return resp.body;
  },
};

export async function runBrowserPull(params: BrowserPullParams, cb: BrowserPullCallbacks, deps: BrowserPullDeps = defaultDeps): Promise<void> {
  cb.note("解析镜像信息…");
  const platform = params.platform?.trim() || (await deps.daemonPlatform());
  const img = await deps.resolveImage(params.ref, platform, params.workerUrl, params.creds);

  const localId = await deps.inspectLocalId(img.repoTag);
  if (localId && localId === `sha256:${img.config.hex}`) {
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
  rejected: { service: string; ref: string; reason: string }[];
}

export interface BrowserPullComposeParams {
  id: string;
  mode: "pull" | "up";
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
}

const rejectReasonText: Record<string, string> = { build: "含 build", digest: "digest 引用" };

// Generic compose command streamer: POST /api/compose/<verb>, parse NDJSON,
// throw on an error event or non-ok status. Body/Content-Type only when a body
// is given (matches the XHR path — a bodyless verb sends no Content-Type).
export async function streamCompose(
  verb: string,
  id: string,
  opts: { body?: unknown; token: string; onProgress?: (line: string) => void; signal: AbortSignal },
): Promise<void> {
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.token}` };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(`/api/compose/${verb}?id=${encodeURIComponent(id)}`, {
    method: "POST",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (!resp.ok || !resp.body) throw new Error(`Compose ${verb} 失败（${resp.status}）`);
  const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      opts.onProgress?.(s);
      try {
        const evt = JSON.parse(s) as { error?: string; errorDetail?: { message?: string } };
        if (evt.error || evt.errorDetail) throw new Error(evt.error || evt.errorDetail?.message || `Compose ${verb} 失败`);
      } catch (e) {
        if (e instanceof SyntaxError) continue; // non-JSON progress line
        throw e;
      }
    }
  }
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
};

export async function runBrowserPullCompose(
  params: BrowserPullComposeParams,
  cb: BrowserPullCallbacks,
  deps: BrowserPullComposeDeps = defaultComposeDeps,
): Promise<void> {
  cb.note("解析 Compose 项目镜像…");
  const plan = await deps.fetchPlan(params.id);
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

// --- Compose update: build → pull/preload → down → up(never) ---
// One task, sequential, stop-on-failure. Covers both proxy modes: server pull
// (proxy opts in body) or browser preload (CF worker). build services in browser
// mode are handled server-side by the build step, so only non-"build" rejections
// (e.g. digest-pinned) abort the browser path.
// ponytail: browser mode + a build service whose FROM base is not local and the
// daemon can't reach the registry will fail at `compose build`. Pre-existing limit
// (today's Build button too). Upgrade path: browser-preload the FROM base first.

export interface ComposeUpdateParams {
  id: string;
  mode: "server" | "browser";
  canBuild: boolean;
  workerUrl?: string;
  token: string;
  creds?: Creds;
  pullOptions?: Record<string, unknown>;
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

  if (params.canBuild) {
    cb.note("构建镜像…");
    // Server mode carries the proxy payload (build honors it via composeRequest);
    // browser mode has no server proxy_url, so pullOptions is undefined → no body.
    await deps.streamCompose("build", id, { body: params.pullOptions, token, onProgress: cb.progress, signal });
  }

  if (params.mode === "browser") {
    cb.note("解析 Compose 项目镜像…");
    const plan = await deps.fetchPlan(id);
    const blocked = plan.rejected.filter((r) => r.reason !== "build");
    if (blocked.length) {
      const detail = blocked.map((r) => `${r.service}（${rejectReasonText[r.reason] ?? r.reason}）`).join("，");
      throw new Error(`以下服务无法用浏览器下载：${detail}。请改用服务端代理。`);
    }
    await preloadComposeImages(plan.images, { workerUrl: params.workerUrl ?? "", token, creds: params.creds }, cb, deps.runBrowserPull);
  } else {
    cb.note("拉取镜像…");
    await deps.streamCompose("pull", id, { body: params.pullOptions, token, onProgress: cb.progress, signal });
  }

  cb.note("停止并移除旧容器…");
  await deps.streamCompose("down", id, { token, onProgress: cb.progress, signal });

  cb.note("启动 Compose（使用本地镜像）…");
  await deps.streamCompose("up", id, { body: { pull_policy: "never" }, token, onProgress: cb.progress, signal });
}
