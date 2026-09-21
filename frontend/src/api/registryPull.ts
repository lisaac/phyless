// Browser-side OCI registry client. Runs the token dance and resolves an image
// to its config + layer descriptors, all through the user's CF worker (which
// adds CORS). Layers themselves are streamed later by dockerTar via layerBlobUrl.
//
// v1 constraints (mirrors the server-side proxy): tag references only (no
// digests), Linux only, manifest/config bounded at 16 MiB, non-distributable
// (foreign) layers rejected. gzip/zstd/uncompressed layers all pass through
// untouched — the daemon decompresses.

const dec = new TextDecoder();

const MAX_META = 16 << 20;
const MAX_ERROR_TEXT = 4096;
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export interface Creds {
  username: string;
  secret: string;
}

export interface ResolvedImage {
  repoTag: string;
  digest: string; // tag's top-level digest: the index for multi-arch images, else the manifest
  registryHost: string;
  repository: string;
  config: { hex: string; size: number; bytes: Uint8Array };
  layers: { hex: string; digest: string; size: number; mediaType: string }[];
  manifest: { mediaType: string; digest: string; size: number; bytes: Uint8Array };
  platform: { os: string; architecture: string; variant?: string };
  authHeader: string | null;
}

// What the registry serves for a tag, as digests. matchesRemote is the TS twin
// of the backend's RemoteImage.Matches — keep the rules identical.
export interface RemoteDigests { digest: string; manifest: string; config: string }

export const remoteDigests = (img: ResolvedImage): RemoteDigests =>
  ({ digest: img.digest, manifest: img.manifest.digest, config: `sha256:${img.config.hex}` });

/** Whether a local image is what the registry serves: classic store (ID =
 *  config digest), containerd store (ID = index or platform manifest digest)
 *  or a daemon pull (RepoDigests). Proxy/browser imports have no RepoDigests. */
export function matchesRemote(local: { Id?: string; RepoDigests?: string[] } | null | undefined, r: RemoteDigests): boolean {
  if (!local?.Id) return false;
  if ([r.config, r.digest, r.manifest].some((d) => d && d.toLowerCase() === local.Id!.toLowerCase())) return true;
  return !!r.digest && (local.RepoDigests ?? []).some((d) => d.endsWith(`@${r.digest}`));
}

export interface ParsedRef {
  registryHost: string; // host actually queried (registry-1.docker.io for Hub)
  repository: string; // API path, e.g. "library/nginx"
  tag: string;
  displayRef: string; // what the image is tagged as, e.g. "nginx:1.27"
}

export function parseImageRef(ref: string): ParsedRef {
  const trimmed = ref.trim();
  if (!trimmed) throw new Error("镜像引用为空");
  if (trimmed.includes("@")) throw new Error("暂不支持 digest 引用（仅支持 tag）");

  let remainder = trimmed;
  let host = "";
  const slash = trimmed.indexOf("/");
  const first = slash >= 0 ? trimmed.slice(0, slash) : "";
  // A registry host has a dot, a colon (port) or is "localhost".
  if (first && (first.includes(".") || first.includes(":") || first === "localhost")) {
    host = first;
    remainder = trimmed.slice(slash + 1);
  }

  const colon = remainder.lastIndexOf(":");
  const lastSlash = remainder.lastIndexOf("/");
  let repository = remainder;
  let tag = "latest";
  if (colon > lastSlash) {
    repository = remainder.slice(0, colon);
    tag = remainder.slice(colon + 1);
  }
  if (!repository) throw new Error("镜像引用无效");

  const isHub = host === "" || host === "docker.io" || host === "index.docker.io" || host === "registry-1.docker.io";
  if (isHub) {
    if (!repository.includes("/")) repository = "library/" + repository;
    const display = repository.startsWith("library/") ? repository.slice("library/".length) : repository;
    return { registryHost: "registry-1.docker.io", repository, tag, displayRef: `${display}:${tag}` };
  }
  return { registryHost: host, repository, tag, displayRef: `${host}/${repository}:${tag}` };
}

export function parseWWWAuthenticate(header: string): { scheme: string; realm: string; service?: string; scope?: string } {
  const scheme = (header.split(/\s+/, 1)[0] || "").toLowerCase();
  const params: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header))) params[m[1].toLowerCase()] = m[2];
  return { scheme, realm: params.realm || "", service: params.service, scope: params.scope };
}

export function proxied(workerUrl: string, target: string): string {
  return `${workerUrl.replace(/\/+$/, "")}?url=${encodeURIComponent(target)}`;
}

export function blobUrl(registryHost: string, repository: string, digest: string): string {
  return `https://${registryHost}/v2/${repository}/blobs/${digest}`;
}

export function layerBlobUrl(workerUrl: string, registryHost: string, repository: string, digest: string): string {
  return proxied(workerUrl, blobUrl(registryHost, repository, digest));
}

export function hexOf(digest: string): string {
  const i = digest.indexOf(":");
  return i >= 0 ? digest.slice(i + 1) : digest;
}

// isForeignLayer rejects non-distributable/foreign layers, which cannot be
// pulled from the registry the way normal layers can.
export function isForeignLayer(mediaType: string): boolean {
  return /foreign|nondistributable/i.test(mediaType);
}

interface TokenCache {
  header: string | null;
}

export async function proxiedGet(workerUrl: string, target: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(proxied(workerUrl, target), { headers, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = error instanceof Error && error.message ? `：${error.message}` : "";
    throw new Error(`无法连接 CF Worker，请检查地址、CORS 和网络${message}`);
  }
}

function responseErrorText(raw: string): string {
  const text = raw.trim();
  if (!text || text.startsWith("<")) return "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return text.slice(0, MAX_ERROR_TEXT);
    const body = parsed as Record<string, unknown>;
    if (typeof body.error === "string" && body.error.trim()) return body.error.trim();
    if (typeof body.message === "string" && body.message.trim()) return body.message.trim();
    if (Array.isArray(body.errors)) {
      const messages = body.errors.map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        const error = item as Record<string, unknown>;
        return typeof error.message === "string" ? error.message : typeof error.code === "string" ? error.code : "";
      }).filter(Boolean);
      if (messages.length) return messages.join("；");
    }
  } catch {
    // Plain-text registry errors are useful too.
  }
  return text.slice(0, MAX_ERROR_TEXT);
}

export async function registryResponseError(resp: Response, action: string): Promise<Error> {
  const detail = responseErrorText(await resp.text().catch(() => ""));
  const suffix = detail ? `：${detail}` : "";
  if (resp.status === 401) return new Error(`镜像仓库认证失败（401）${suffix}`);
  if (resp.status === 404) return new Error(`镜像、标签或镜像层不存在（404）${suffix}`);
  if (resp.status === 429) {
    const retryAfter = resp.headers.get("Retry-After");
    const retry = retryAfter && /^\d+$/.test(retryAfter) ? `，请 ${retryAfter} 秒后重试` : "，请稍后重试";
    return new Error(`镜像仓库请求过于频繁（429）${retry}${suffix}`);
  }
  return new Error(`${action}失败（${resp.status}）${suffix}`);
}

async function authorizedGet(
  workerUrl: string,
  target: string,
  accept: string,
  creds: Creds | undefined,
  cache: TokenCache,
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = { Accept: accept };
  if (cache.header) headers.Authorization = cache.header;
  let resp = await proxiedGet(workerUrl, target, headers, signal);
  if (resp.status === 401) {
    const wa = resp.headers.get("WWW-Authenticate");
    if (!wa) throw await registryResponseError(resp, "镜像仓库请求");
    const challenge = parseWWWAuthenticate(wa);
    if (challenge.scheme === "basic") {
      if (!creds) throw new Error("该镜像需要登录凭据");
      cache.header = "Basic " + btoa(`${creds.username}:${creds.secret}`);
    } else {
      cache.header = "Bearer " + (await fetchToken(workerUrl, challenge, creds, signal));
    }
    headers.Authorization = cache.header;
    resp = await proxiedGet(workerUrl, target, headers, signal);
  }
  if (!resp.ok) throw await registryResponseError(resp, "镜像仓库请求");
  return resp;
}

async function fetchToken(
  workerUrl: string,
  challenge: { realm: string; service?: string; scope?: string },
  creds: Creds | undefined,
  signal?: AbortSignal,
): Promise<string> {
  if (!challenge.realm) throw new Error("registry 认证信息不完整");
  const url = new URL(challenge.realm);
  if (challenge.service) url.searchParams.set("service", challenge.service);
  if (challenge.scope) url.searchParams.set("scope", challenge.scope);
  const headers: Record<string, string> = {};
  if (creds) headers.Authorization = "Basic " + btoa(`${creds.username}:${creds.secret}`);
  const resp = await proxiedGet(workerUrl, url.toString(), headers, signal);
  if (!resp.ok) throw await registryResponseError(resp, "获取镜像仓库访问令牌");
  const body = (await resp.json()) as { token?: string; access_token?: string };
  const token = body.token || body.access_token;
  if (!token) throw new Error("registry 未返回访问令牌");
  return token;
}

// authHeaderFromChallenge turns a 401's WWW-Authenticate header into a fresh
// Authorization header. Used to re-authorize a layer blob fetch whose token has
// expired mid-pull (registry tokens are short-lived; a large image can outlive
// the one obtained during the manifest phase).
export async function authHeaderFromChallenge(workerUrl: string, wwwAuthenticate: string, creds?: Creds, signal?: AbortSignal): Promise<string> {
  const challenge = parseWWWAuthenticate(wwwAuthenticate);
  if (challenge.scheme === "basic") {
    if (!creds) throw new Error("该镜像需要登录凭据");
    return "Basic " + btoa(`${creds.username}:${creds.secret}`);
  }
  return "Bearer " + (await fetchToken(workerUrl, challenge, creds, signal));
}

async function readBounded(resp: Response, limit: number): Promise<Uint8Array> {
  const len = resp.headers.get("Content-Length");
  if (len && Number(len) > limit) throw new Error("registry 响应过大");
  const buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.byteLength > limit) throw new Error("registry 响应过大");
  return buf;
}

async function sha256Digest(bytes: Uint8Array): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return "sha256:" + hex;
}

export function parsePlatform(raw: string): { os: string; architecture: string; variant?: string } {
  const [os, architecture, variant] = (raw || "linux/amd64").split("/");
  return { os: os || "linux", architecture: architecture || "amd64", ...(variant ? { variant } : {}) };
}

function isIndex(mediaType: string, doc: { manifests?: unknown }): boolean {
  return /image\.index|manifest\.list/.test(mediaType) || Array.isArray(doc.manifests);
}

interface PlatformDesc {
  digest: string;
  platform?: { os?: string; architecture?: string; variant?: string };
}

function selectPlatform(manifests: PlatformDesc[], want: { os: string; architecture: string; variant?: string }): PlatformDesc | undefined {
  return manifests.find(
    (m) =>
      m.platform?.os === want.os &&
      m.platform?.architecture === want.architecture &&
      (!want.variant || m.platform?.variant === want.variant),
  );
}

export async function resolveImage(ref: string, platform: string, workerUrl: string, creds?: Creds, signal?: AbortSignal): Promise<ResolvedImage> {
  if (!workerUrl.trim()) throw new Error("未配置下载代理地址");
  const parsed = parseImageRef(ref);
  const want = parsePlatform(platform);
  if (want.os !== "linux") throw new Error("浏览器下载仅支持 Linux 镜像");

  const cache: TokenCache = { header: null };
  const manifestUrl = `https://${parsed.registryHost}/v2/${parsed.repository}/manifests/${parsed.tag}`;
  let resp = await authorizedGet(workerUrl, manifestUrl, MANIFEST_ACCEPT, creds, cache, signal);
  let raw = await readBounded(resp, MAX_META);
  const topDigest = await sha256Digest(raw);
  let doc = JSON.parse(dec.decode(raw)) as {
    mediaType?: string;
    manifests?: PlatformDesc[];
    config?: { digest: string; size: number; mediaType: string };
    layers?: { digest: string; size: number; mediaType: string }[];
  };
  let mediaType = doc.mediaType || (resp.headers.get("Content-Type") || "").split(";")[0].trim();

  if (isIndex(mediaType, doc)) {
    const pick = selectPlatform(doc.manifests || [], want);
    if (!pick) throw new Error("镜像不包含目标平台");
    const byDigest = `https://${parsed.registryHost}/v2/${parsed.repository}/manifests/${pick.digest}`;
    resp = await authorizedGet(workerUrl, byDigest, MANIFEST_ACCEPT, creds, cache, signal);
    raw = await readBounded(resp, MAX_META);
    doc = JSON.parse(dec.decode(raw));
    mediaType = doc.mediaType || (resp.headers.get("Content-Type") || "").split(";")[0].trim();
  }

  if (!doc.config || !Array.isArray(doc.layers)) throw new Error("不支持的镜像 manifest");
  if (doc.config.size > MAX_META) throw new Error("镜像 config 过大");
  for (const layer of doc.layers) {
    if (isForeignLayer(layer.mediaType)) throw new Error(`不支持的镜像层类型：${layer.mediaType}`);
    if (layer.size < 0) throw new Error("镜像层大小无效");
  }

  // Compute the manifest digest from the exact bytes we received rather than
  // trusting Docker-Content-Digest: dockerTar names the manifest blob and the
  // index.json entry by this digest, so a header that disagrees with the bytes
  // would make `docker load`'s OCI path fail digest verification.
  const manifestDigest = await sha256Digest(raw);

  const configResp = await authorizedGet(workerUrl, blobUrl(parsed.registryHost, parsed.repository, doc.config.digest), "*/*", creds, cache, signal);
  const configBytes = await readBounded(configResp, MAX_META);
  const cfg = JSON.parse(dec.decode(configBytes)) as { os?: string; architecture?: string; variant?: string };
  if ((cfg.os || "") !== want.os) throw new Error("镜像 OS 与目标平台不符");
  if ((cfg.architecture || "") !== want.architecture) throw new Error("镜像架构与目标平台不符");

  return {
    repoTag: parsed.displayRef,
    digest: topDigest,
    registryHost: parsed.registryHost,
    repository: parsed.repository,
    config: { hex: hexOf(doc.config.digest), size: doc.config.size, bytes: configBytes },
    layers: doc.layers.map((l) => ({ hex: hexOf(l.digest), digest: l.digest, size: l.size, mediaType: l.mediaType })),
    manifest: { mediaType: mediaType || "application/vnd.oci.image.manifest.v1+json", digest: manifestDigest, size: raw.byteLength, bytes: raw },
    platform: want,
    authHeader: cache.header,
  };
}
