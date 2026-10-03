import { authorizedGet, parseImageRef, proxiedGet, readBounded, registryResponseError, type Creds } from "./registryPull";

const REPOSITORY_PAGE_SIZE = 10;
const TAG_PAGE_SIZE = 20;
const MAX_SEARCH_RESPONSE = 256 * 1024;
export const MAX_SEARCH_KEYWORD_LENGTH = 128;
export const MAX_REGISTRY_REF_LENGTH = 512;
const repositoryPattern = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const tagPattern = /^[\w][\w.-]{0,127}$/;

export interface RegistryRepository {
  name: string;
  description: string;
  official: boolean;
}

async function readSearchJSON(response: Response): Promise<Record<string, unknown>> {
  const data: unknown = JSON.parse(new TextDecoder().decode(await readBounded(response, MAX_SEARCH_RESPONSE)));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("镜像仓库返回了无效的搜索结果");
  return data as Record<string, unknown>;
}

/** Public Hub search deliberately sends no private-registry credentials. */
export async function searchRepositories(query: string, workerUrl: string, signal: AbortSignal, page = 1) {
  const keyword = query.trim();
  if (keyword.length < 2 || keyword.length > MAX_SEARCH_KEYWORD_LENGTH) throw new Error("搜索关键词需为 2–128 个字符");
  const url = new URL("https://hub.docker.com/v2/search/repositories/");
  url.searchParams.set("query", keyword);
  url.searchParams.set("page_size", String(REPOSITORY_PAGE_SIZE));
  url.searchParams.set("page", String(page));
  const response = await proxiedGet(workerUrl, url.href, { Accept: "application/json" }, signal);
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
      description: typeof item.short_description === "string" ? item.short_description.slice(0, 200) : "",
      official: item.is_official === true,
    });
  }
  return { items, hasMore: typeof data.next === "string" && !!data.next };
}

/** V2 tag names only: no manifests, layer metadata, catalog scans or prefetch. */
export async function listRegistryTags(ref: string, workerUrl: string, creds: Creds | undefined, signal: AbortSignal, last = "") {
  const parsed = parseImageRef(ref);
  const base = new URL(`https://${parsed.registryHost}`);
  // Validate the raw host while letting URL normalize case, ports and IPv6.
  if (!/^[\w.[\]:-]+$/.test(parsed.registryHost) || parsed.registryHost.endsWith(":") || base.pathname !== "/" || base.search || base.hash ||
      base.username || base.password || parsed.repository.length > 255 || !repositoryPattern.test(parsed.repository)) {
    throw new Error("请输入有效的镜像仓库名，例如 ghcr.io/owner/app");
  }
  const url = new URL(`/v2/${parsed.repository}/tags/list`, base);
  url.searchParams.set("n", String(TAG_PAGE_SIZE));
  if (last) url.searchParams.set("last", last);
  const response = await authorizedGet(workerUrl, url.href, "application/json", creds, { header: null }, signal);
  const data = await readSearchJSON(response);
  if (data.tags !== null && !Array.isArray(data.tags)) throw new Error("镜像仓库返回了无效的标签列表");
  const tags: string[] = [];
  for (const tag of (data.tags ?? []) as unknown[]) {
    if (typeof tag !== "string" || !tagPattern.test(tag) || tag <= last) continue;
    tags.push(tag);
    if (tags.length === TAG_PAGE_SIZE) break;
  }
  // The existing Worker does not expose Link. A registry may return fewer
  // than n tags, so any advancing page offers an explicit next request.
  return {
    repository: parsed.displayRef.slice(0, parsed.displayRef.lastIndexOf(":")),
    tags,
    next: tags.length ? tags[tags.length - 1] : "",
  };
}
