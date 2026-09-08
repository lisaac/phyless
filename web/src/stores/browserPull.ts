// Browser-pull runner: resolve → up-to-date check → assemble tar → stream to
// daemon. Kept out of taskQueue so it is unit-testable with injected deps; the
// queue wires note/progress/signal to a task's UI state.

import { buildDockerLoadTar } from "../api/dockerTar";
import { resolveImage, layerBlobUrl, type Creds, type ResolvedImage } from "../api/registryPull";
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
  openLayer: (img: ResolvedImage, index: number, workerUrl: string, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
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
  openLayer: async (img, index, workerUrl, signal) => {
    const layer = img.layers[index];
    const resp = await fetch(layerBlobUrl(workerUrl, img.registryHost, img.repository, layer.digest), {
      headers: img.authHeader ? { Authorization: img.authHeader } : {},
      signal,
    });
    if (!resp.ok || !resp.body) throw new Error(`下载镜像层失败（${resp.status}）`);
    return resp.body;
  },
};

export async function runBrowserPull(params: BrowserPullParams, cb: BrowserPullCallbacks, deps: BrowserPullDeps = defaultDeps): Promise<void> {
  cb.note("解析镜像信息…");
  const img = await deps.resolveImage(params.ref, params.platform, params.workerUrl, params.creds);

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
    openLayer: (i) => deps.openLayer(img, i, params.workerUrl, cb.signal),
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

async function composeUpNever(id: string, token: string, onProgress: ((line: string) => void) | undefined, signal: AbortSignal): Promise<void> {
  const resp = await fetch(`/api/compose/up?id=${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ pull_policy: "never" }),
    signal,
  });
  if (!resp.ok || !resp.body) throw new Error(`Compose up 失败（${resp.status}）`);
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
      onProgress?.(s);
      try {
        const evt = JSON.parse(s) as { error?: string; errorDetail?: { message?: string } };
        if (evt.error || evt.errorDetail) throw new Error(evt.error || evt.errorDetail?.message || "Compose up 失败");
      } catch (e) {
        if (e instanceof SyntaxError) continue; // non-JSON progress line
        throw e;
      }
    }
  }
}

export const defaultComposeDeps: BrowserPullComposeDeps = {
  fetchPlan: (id) => get<ComposePullPlan>(`/api/compose/pull-plan?id=${encodeURIComponent(id)}`),
  runBrowserPull: (params, cb) => runBrowserPull(params, cb),
  composeUp: composeUpNever,
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
  for (const img of plan.images) {
    cb.note(`拉取 ${img.service}：${img.ref}`);
    await deps.runBrowserPull(
      { ref: img.ref, platform: img.platform ?? "", workerUrl: params.workerUrl, token: params.token, creds: params.creds },
      { note: cb.note, progress: cb.progress, signal: cb.signal },
    );
  }
  if (params.mode === "up") {
    cb.note("启动 Compose（使用本地镜像）…");
    await deps.composeUp(params.id, params.token, cb.progress, cb.signal);
  } else {
    cb.note("镜像预加载完成");
  }
}
