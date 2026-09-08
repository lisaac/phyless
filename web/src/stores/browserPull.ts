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
