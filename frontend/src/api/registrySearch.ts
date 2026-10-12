import { getToken } from "./client";
import { authorizedGet, credsFor, parseImageRef, proxied, proxiedGet, readBounded, registryResponseError, type Creds, type RegistryCreds } from "./registryPull";

/** Where remote lookups go — the same path the chosen pull mode uses. */
export type RemoteRoute =
  | { kind: "worker"; workerUrl: string; creds?: RegistryCreds }
  | { kind: "server"; proxyUrl?: string; registryIds?: string[] };

const REPOSITORY_PAGE_SIZE = 20;
const HUB_TAG_PAGE_SIZE = 50;
const V2_TAG_PAGE_SIZE = 1000;
// ponytail: a V2 registry has no ordering, so tags are read whole and sorted
// here; capped so a repo with tens of thousands of tags stays bounded.
const V2_TAG_MAX_PAGES = 5;
const MAX_SEARCH_RESPONSE = 1024 * 1024;
export const MAX_SEARCH_KEYWORD_LENGTH = 128;
export const MAX_REGISTRY_REF_LENGTH = 512;
const repositoryPattern = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const tagPattern = /^[\w][\w.-]{0,127}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

export interface RegistryRepository {
  name: string;
  description: string;
  official: boolean;
  stars: number;
  pulls: number;
}

export interface RegistryTag {
  name: string;
  /** Unix seconds; Docker Hub only. */
  updated?: number;
  /** Compressed size of one platform; Docker Hub only. */
  size?: number;
  digest?: string;
  /** e.g. "amd64", "arm64/v8"; Docker Hub only. */
  platforms: string[];
}

export interface TagPage {
  repository: string;
  tags: RegistryTag[];
  /** Opaque cursor for the next page; "" when everything is loaded. */
  next: string;
  total?: number;
  /** Docker Hub sorts by last update and filters by name server-side. */
  hub: boolean;
  auth?: HubAuth;
  /** Why the listing is reduced, e.g. the Hub API rate limit forced the V2 API. */
  notice?: string;
}

/** Who the Hub API saw: the account, or anonymous after a failed login. */
export interface HubAuth {
  user?: string;
  error?: string;
}

// Registry APIs with their own token login (beside the V2 token service),
// keyed by registry host. The frontend owns the URL and body; phyless and the
// Worker only relay the POST.
const API_LOGINS: Record<string, { url: string; body: (creds: Creds) => string }> = {
  "docker.io": {
    url: "https://hub.docker.com/v2/auth/token",
    body: (creds) => JSON.stringify({ identifier: creds.username, secret: creds.secret }),
  },
};
// Tokens live until their JWT expiry (Docker Hub: 15 min), across reloads.
// ponytail: cleartext in localStorage, like the remembered accounts themselves.
const TOKENS_KEY = "phyless.registry-api-tokens";
type CachedToken = { token: string; expires: number };
let apiTokens: Record<string, CachedToken> | undefined;
// After a 429, the shared Worker IP is skipped for login until Retry-After.
let workerLoginBlockedUntil = 0;

function tokens(): Record<string, CachedToken> {
  if (!apiTokens) {
    try {
      apiTokens = JSON.parse(localStorage.getItem(TOKENS_KEY) ?? "{}") ?? {};
    } catch {
      apiTokens = {};
    }
  }
  const now = Date.now();
  for (const [key, value] of Object.entries(apiTokens!)) if (!(value?.expires > now)) delete apiTokens![key];
  return apiTokens!;
}

function saveTokens() {
  try {
    localStorage.setItem(TOKENS_KEY, JSON.stringify(apiTokens ?? {}));
  } catch {
    // Storage unavailable: the token still lives for this tab.
  }
}

function jwtExpiry(token: string): number {
  try {
    const exp = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).exp;
    if (typeof exp === "number") return exp * 1000 - 60_000;
  } catch {
    // Opaque token: fall through to a short default.
  }
  return Date.now() + 5 * 60_000;
}

async function tokenFrom(response: Response, label: string): Promise<string> {
  const data = await readSearchJSON(response);
  const token = typeof data.access_token === "string" ? data.access_token : typeof data.token === "string" ? data.token : "";
  if (!token) throw new Error(`${label}未返回访问令牌`);
  return token;
}

/** API bearer for a registry account: cached, else logged in over phyless's
 *  network, else over the Worker. A rejected account fails at once. */
export async function apiLogin(host: string, workerUrl: string, creds: Creds, signal: AbortSignal): Promise<string> {
  const login = API_LOGINS[host];
  if (!login) throw new Error(`${host} 没有 API 登录方式`);
  const key = `${host}\n${creds.username}`;
  const cached = tokens()[key];
  if (cached) return cached.token;
  const label = host === "docker.io" ? "Docker Hub " : `${host} `;
  const invalid = () => new Error(`${label}用户名或密码 / Token 无效`);
  const keep = (token: string) => {
    tokens()[key] = { token, expires: jwtExpiry(token) };
    saveTokens();
    return token;
  };

  let serverReason = "无法连接 phyless 服务端";
  let viaServer: Response | undefined;
  try {
    const token = getToken();
    viaServer = await fetch("/api/registries/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ url: login.url, content_type: "application/json", body: login.body(creds) }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
  }
  if (viaServer) {
    // 400/403 are the registry rejecting the account (401 arrives as 403).
    if (viaServer.status === 400 || viaServer.status === 403) {
      await viaServer.body?.cancel();
      throw invalid();
    }
    if (viaServer.ok) return keep(await tokenFrom(viaServer, label));
    serverReason = (await registryResponseError(viaServer, "服务端登录")).message;
  }

  if (workerLoginBlockedUntil > Date.now()) {
    throw new Error(`${serverReason}；经 Worker 登录过于频繁（429），请 ${Math.ceil((workerLoginBlockedUntil - Date.now()) / 1000)} 秒后重试`);
  }
  let response: Response;
  try {
    response = await fetch(proxied(workerUrl, login.url), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: login.body(creds),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(`${serverReason}；无法连接 CF Worker`);
  }
  if (response.status === 405) throw new Error(`${serverReason}；当前 Worker 不支持登录，请重新部署最新的 registry-proxy.js`);
  if (response.status === 401 || response.status === 400) {
    await response.body?.cancel();
    throw invalid();
  }
  if (response.status === 429) {
    const retry = Number(response.headers.get("Retry-After"));
    workerLoginBlockedUntil = Date.now() + (Number.isFinite(retry) && retry > 0 ? retry : 60) * 1000;
  }
  if (!response.ok) throw new Error(`${serverReason}；${(await registryResponseError(response, "经 Worker 登录")).message}`);
  return keep(await tokenFrom(response, label));
}

/** Forgets a token the registry no longer accepts. */
function dropApiToken(host: string, username: string) {
  if (delete tokens()[`${host}\n${username}`]) saveTokens();
}

// A failed login never blocks search: it falls back to anonymous and says so.
async function hubHeaders(workerUrl: string, creds: Creds | undefined, signal: AbortSignal) {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (!creds) return { headers, auth: {} as HubAuth };
  try {
    headers.Authorization = `Bearer ${await apiLogin("docker.io", workerUrl, creds, signal)}`;
    return { headers, auth: { user: creds.username } as HubAuth };
  } catch (error) {
    if (signal.aborted) throw error;
    return { headers, auth: { error: error instanceof Error ? error.message : "登录失败" } as HubAuth };
  }
}

/** Checks an account against its registry through the Worker. Docker Hub is
 *  checked through the registry token service (auth.docker.io), not the Hub
 *  API login: that one is rate-limited per (shared Worker) IP. */
export async function verifyRegistryCreds(workerUrl: string, host: string, creds: Creds, signal: AbortSignal): Promise<void> {
  const registry = host === "docker.io" ? "registry-1.docker.io" : host;
  const response = await authorizedGet(workerUrl, `https://${registry}/v2/`, "application/json", creds, { header: null }, signal);
  await response.body?.cancel();
}

// phyless relays the lookup over its own network or the request's pull proxy.
async function serverGet(route: Extract<RemoteRoute, { kind: "server" }>, target: string, signal: AbortSignal, accept?: string): Promise<Response> {
  const token = getToken();
  try {
    return await fetch("/api/images/remote", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ url: target, accept, proxy_url: route.proxyUrl?.trim() || undefined, registry_ids: route.registryIds?.length ? route.registryIds : undefined }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("无法连接 phyless 服务端");
  }
}

async function hubGet(route: RemoteRoute, target: URL, signal: AbortSignal) {
  if (route.kind === "server") return { response: await serverGet(route, target.href, signal), auth: {} as HubAuth };
  const creds = route.creds?.["docker.io"];
  const { headers, auth } = await hubHeaders(route.workerUrl, creds, signal);
  const response = await proxiedGet(route.workerUrl, target.href, headers, signal);
  if (response.status === 401 && creds && headers.Authorization) dropApiToken("docker.io", creds.username);
  return { response, auth };
}

async function readSearchJSON(response: Response): Promise<Record<string, unknown>> {
  const data: unknown = JSON.parse(new TextDecoder().decode(await readBounded(response, MAX_SEARCH_RESPONSE)));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("镜像仓库返回了无效的搜索结果");
  return data as Record<string, unknown>;
}

const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** Hub search over the route; on the Worker as its Docker Hub account, if any. */
export async function searchRepositories(query: string, route: RemoteRoute, signal: AbortSignal, page = 1) {
  const keyword = query.trim();
  if (keyword.length < 2 || keyword.length > MAX_SEARCH_KEYWORD_LENGTH) throw new Error("搜索关键词需为 2–128 个字符");
  const url = new URL("https://hub.docker.com/v2/search/repositories/");
  url.searchParams.set("query", keyword);
  url.searchParams.set("page_size", String(REPOSITORY_PAGE_SIZE));
  url.searchParams.set("page", String(page));
  const { response, auth } = await hubGet(route, url, signal);
  if (!response.ok) throw await registryResponseError(response, "搜索镜像");
  const data = await readSearchJSON(response);
  if (!Array.isArray(data.results)) throw new Error("镜像仓库返回了无效的搜索结果");
  const items: RegistryRepository[] = [];
  for (const result of data.results.slice(0, REPOSITORY_PAGE_SIZE)) {
    if (!result || typeof result !== "object") continue;
    const item = result as Record<string, unknown>;
    if (typeof item.repo_name !== "string" || item.repo_name.length > 255 || !repositoryPattern.test(item.repo_name)) continue;
    items.push({
      name: item.repo_name,
      description: typeof item.short_description === "string" ? item.short_description.slice(0, 300) : "",
      official: item.is_official === true,
      stars: count(item.star_count),
      pulls: count(item.pull_count),
    });
  }
  return { items, hasMore: typeof data.next === "string" && !!data.next, total: count(data.count), auth };
}

export function isHubRef(ref: string): boolean {
  try {
    return parseImageRef(ref).registryHost === "registry-1.docker.io";
  } catch {
    return false;
  }
}

function checkedRef(ref: string) {
  const parsed = parseImageRef(ref);
  const base = new URL(`https://${parsed.registryHost}`);
  // Validate the raw host while letting URL normalize case, ports and IPv6.
  if (!/^[\w.[\]:-]+$/.test(parsed.registryHost) || parsed.registryHost.endsWith(":") || base.pathname !== "/" || base.search || base.hash ||
      base.username || base.password || parsed.repository.length > 255 || !repositoryPattern.test(parsed.repository)) {
    throw new Error("请输入有效的镜像仓库名，例如 ghcr.io/owner/app");
  }
  return { ...parsed, base, display: parsed.displayRef.slice(0, parsed.displayRef.lastIndexOf(":")) };
}

/** "latest" first, then natural version order, newest first. */
export function sortTagNames(names: string[]): string[] {
  const collator = new Intl.Collator(undefined, { numeric: true });
  return [...names].sort((a, b) => (b === "latest" ? 1 : 0) - (a === "latest" ? 1 : 0) || collator.compare(b, a));
}

/** Hub's own tag API: newest first, sizes, platforms, server-side name filter. */
async function listHubTags(repository: string, display: string, route: RemoteRoute, signal: AbortSignal, cursor: string, filter: string): Promise<TagPage> {
  const page = Number(cursor) || 1;
  const slash = repository.indexOf("/");
  const url = new URL(`https://hub.docker.com/v2/namespaces/${repository.slice(0, slash)}/repositories/${repository.slice(slash + 1)}/tags`);
  url.searchParams.set("page_size", String(HUB_TAG_PAGE_SIZE));
  url.searchParams.set("page", String(page));
  url.searchParams.set("ordering", "last_updated");
  if (filter) url.searchParams.set("name", filter);
  const { response, auth } = await hubGet(route, url, signal);
  if (!response.ok) throw await registryResponseError(response, "获取标签");
  const data = await readSearchJSON(response);
  if (!Array.isArray(data.results)) throw new Error("镜像仓库返回了无效的标签列表");
  const tags: RegistryTag[] = [];
  for (const result of data.results.slice(0, HUB_TAG_PAGE_SIZE)) {
    if (!result || typeof result !== "object") continue;
    const item = result as Record<string, unknown>;
    if (typeof item.name !== "string" || !tagPattern.test(item.name)) continue;
    const updated = typeof item.last_updated === "string" ? Date.parse(item.last_updated) / 1000 : NaN;
    const images = (Array.isArray(item.images) ? item.images : []) as Record<string, unknown>[];
    const platforms = images
      .filter((image) => image && typeof image.architecture === "string" && image.architecture !== "unknown" && image.os !== "unknown")
      .map((image) => typeof image.variant === "string" && image.variant ? `${image.architecture}/${image.variant}` : String(image.architecture));
    tags.push({
      name: item.name,
      updated: Number.isFinite(updated) ? updated : undefined,
      size: count(item.full_size) || undefined,
      digest: typeof item.digest === "string" && digestPattern.test(item.digest) ? item.digest : undefined,
      platforms: [...new Set(platforms)].slice(0, 12),
    });
  }
  return { repository: display, tags, next: data.next ? String(page + 1) : "", total: count(data.count), hub: true, auth };
}

function tagNames(data: Record<string, unknown>, after = ""): string[] {
  if (data.tags !== null && data.tags !== undefined && !Array.isArray(data.tags)) throw new Error("镜像仓库返回了无效的标签列表");
  return ((data.tags ?? []) as unknown[]).filter((tag): tag is string => typeof tag === "string" && tagPattern.test(tag) && tag > after);
}

/** Any V2 registry: names only, read whole (bounded) and sorted locally. */
async function listV2Tags(parsed: ReturnType<typeof checkedRef>, route: RemoteRoute, signal: AbortSignal): Promise<TagPage> {
  const names = new Set<string>();
  const listUrl = (last: string) => {
    const url = new URL(`/v2/${parsed.repository}/tags/list`, parsed.base);
    url.searchParams.set("n", String(V2_TAG_PAGE_SIZE));
    if (last) url.searchParams.set("last", last);
    return url.href;
  };
  if (route.kind === "server") {
    // The server follows the registry's pagination itself.
    const response = await serverGet(route, listUrl(""), signal);
    if (!response.ok) throw await registryResponseError(response, "获取标签");
    for (const tag of tagNames(await readSearchJSON(response)).slice(0, V2_TAG_PAGE_SIZE * V2_TAG_MAX_PAGES)) names.add(tag);
  } else {
    const creds = credsFor(route.creds, `${parsed.registryHost}/${parsed.repository}`);
    const token = { header: null as string | null };
    let last = "";
    for (let i = 0; i < V2_TAG_MAX_PAGES; i++) {
      const data = await readSearchJSON(await authorizedGet(route.workerUrl, listUrl(last), "application/json", creds, token, signal));
      // The Worker hides Link, so keep asking until a page brings nothing new.
      const before = names.size;
      for (const tag of tagNames(data, last)) names.add(tag);
      if (names.size === before) break;
      last = [...names].reduce((a, b) => (a > b ? a : b));
    }
  }
  return { repository: parsed.display, tags: sortTagNames([...names]).map((name) => ({ name, platforms: [] })), next: "", total: names.size, hub: false };
}

export async function listRegistryTags(ref: string, route: RemoteRoute, signal: AbortSignal, cursor = "", filter = ""): Promise<TagPage> {
  const parsed = checkedRef(ref);
  if (parsed.registryHost !== "registry-1.docker.io") return listV2Tags(parsed, route, signal);
  try {
    return await listHubTags(parsed.repository, parsed.display, route, signal, cursor, filter.trim().slice(0, 128));
  } catch (error) {
    if (signal.aborted || cursor) throw error;
    const text = String(error);
    // The registry API counts per account (or per pull quota), not per shared IP.
    if (/（429）/.test(text)) {
      return { ...await listV2Tags(parsed, route, signal), notice: "Docker Hub API 限额已满，已改用 registry 接口：仅显示标签名，按版本号排序" };
    }
    // Private Hub repositories are invisible to the anonymous Hub API.
    const hasAccount = route.kind === "worker" ? !!credsFor(route.creds, ref) : !!route.registryIds?.length;
    if (hasAccount && /（40[134]）/.test(text)) return listV2Tags(parsed, route, signal);
    throw error;
  }
}

/** What a tag's manifest and config say, for registries without a Hub-style API. */
export interface TagDetails {
  updated?: number;
  /** Compressed size (config + layers) of one platform's image. */
  size?: number;
  platforms: string[];
  digest?: string;
  /** Image labels and OCI annotations, e.g. org.opencontainers.image.description. */
  labels: Record<string, string>;
}

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
// Worker route: one token per repository, reused across a page of tags.
const describeTokens = new Map<string, { header: string | null }>();

async function registryObject(route: RemoteRoute, ref: string, url: string, accept: string, signal: AbortSignal): Promise<Response> {
  if (route.kind === "server") {
    const response = await serverGet(route, url, signal, accept);
    if (!response.ok) throw await registryResponseError(response, "读取镜像信息");
    return response;
  }
  const key = `${route.workerUrl}\n${url.replace(/\/(manifests|blobs)\/.*$/, "")}`;
  const token = describeTokens.get(key) ?? { header: null };
  describeTokens.set(key, token);
  return authorizedGet(route.workerUrl, url, accept, credsFor(route.creds, ref), token, signal);
}

const platformName = (p: Record<string, unknown> | undefined) =>
  p && typeof p.architecture === "string" ? (typeof p.variant === "string" && p.variant ? `${p.architecture}/${p.variant}` : p.architecture) : "";

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([k, v]) => typeof v === "string" && k.length < 200).map(([k, v]) => [k, (v as string).slice(0, 500)]));
}

/** Reads one tag's manifest (and, for an index, one platform's) plus its
 *  config: 2–3 small requests. Not for Docker Hub, where manifest GETs count
 *  against the pull quota and the Hub API already has this. */
export async function describeTag(ref: string, route: RemoteRoute, signal: AbortSignal): Promise<TagDetails> {
  const parsed = checkedRef(ref);
  const base = `${parsed.base.origin}/v2/${parsed.repository}`;
  const first = await registryObject(route, ref, `${base}/manifests/${encodeURIComponent(parseImageRef(ref).tag)}`, MANIFEST_TYPES, signal);
  const headerDigest = first.headers.get("Docker-Content-Digest") ?? "";
  let doc = await readSearchJSON(first);
  let labels = stringMap(doc.annotations);
  let platforms: string[] = [];
  if (Array.isArray(doc.manifests)) {
    const entries = (doc.manifests as Record<string, unknown>[]).filter((m) => {
      const platform = m?.platform as Record<string, unknown> | undefined;
      const annotations = m?.annotations as Record<string, unknown> | undefined;
      return platform && platform.os !== "unknown" && !annotations?.["vnd.docker.reference.type"] && typeof m.digest === "string" && digestPattern.test(m.digest);
    });
    platforms = [...new Set(entries.map((m) => platformName(m.platform as Record<string, unknown>)).filter(Boolean))].slice(0, 12);
    const pick = entries.find((m) => (m.platform as Record<string, unknown>).architecture === "amd64") ?? entries[0];
    if (!pick) return { platforms, labels, digest: digestPattern.test(headerDigest) ? headerDigest : undefined };
    doc = await readSearchJSON(await registryObject(route, ref, `${base}/manifests/${pick.digest}`, MANIFEST_TYPES, signal));
    labels = { ...labels, ...stringMap(doc.annotations) };
  }
  const config = doc.config as Record<string, unknown> | undefined;
  const layers = Array.isArray(doc.layers) ? doc.layers as Record<string, unknown>[] : [];
  const size = [config, ...layers].reduce((sum, d) => sum + count(d?.size), 0) || undefined;
  let updated: number | undefined;
  if (config && typeof config.digest === "string" && digestPattern.test(config.digest)) {
    const cfg = await readSearchJSON(await registryObject(route, ref, `${base}/blobs/${config.digest}`, "application/json, */*", signal));
    const created = typeof cfg.created === "string" ? Date.parse(cfg.created) / 1000 : NaN;
    if (Number.isFinite(created) && created > 0) updated = created;
    if (!platforms.length && platformName(cfg)) platforms = [platformName(cfg)];
    labels = { ...stringMap((cfg.config as Record<string, unknown> | undefined)?.Labels), ...labels };
  }
  return { updated, size, platforms, digest: digestPattern.test(headerDigest) ? headerDigest : undefined, labels };
}
