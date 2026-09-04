import { Component, createResource, createUniqueId, For, Show, onMount } from "solid-js";
import { get } from "../../api/client";
import type { Registry } from "../../types";

export interface PullOptionsValue {
  proxyUrl?: string;
  registryId?: string;
  registryIds?: string[];
  platform?: string;
}

const PULL_PROXY_STORAGE_KEY = "phyless_pull_proxy_url";

function rememberableProxyUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)) return "";
    if (!url.hostname || url.username || url.password || url.search || url.hash) return "";
    if (url.host.endsWith(":")) return "";
    if ((url.protocol === "socks5:" || url.protocol === "socks5h:") && !url.port) return "";
    if (url.pathname !== "" && url.pathname !== "/") return "";
    return value;
  } catch {
    return "";
  }
}

export function readPullProxyUrl(): string {
  try {
    return rememberableProxyUrl(localStorage.getItem(PULL_PROXY_STORAGE_KEY) ?? "");
  } catch {
    return "";
  }
}

export function rememberPullProxyUrl(raw: string): void {
  try {
    const value = rememberableProxyUrl(raw);
    if (value) localStorage.setItem(PULL_PROXY_STORAGE_KEY, value);
    else if (!raw.trim()) localStorage.removeItem(PULL_PROXY_STORAGE_KEY);
  } catch {
    // Browser storage may be disabled; the request still uses component state.
  }
}

// Keep request-only pull settings out of the run/compose model. Callers own
// the short-lived values so closing a modal can release them immediately.
export function pullOptionsPayload(value: PullOptionsValue): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value.proxyUrl?.trim()) out.proxy_url = value.proxyUrl.trim();
  if (value.registryId) out.registry_id = value.registryId;
  if (value.registryIds?.length) out.registry_ids = value.registryIds;
  if (value.platform?.trim()) out.platform = value.platform.trim();
  return out;
}

const PLATFORM_HINTS = ["linux/amd64", "linux/arm64", "linux/arm/v7"];

export const PullOptions: Component<{
  proxyUrl: string;
  registryId?: string;
  registryIds?: string[];
  platform?: string;
  showPlatform?: boolean;
  multipleRegistries?: boolean;
  onProxyUrlChange: (value: string) => void;
  onRegistryIdChange?: (value: string) => void;
  onRegistryIdsChange?: (value: string[]) => void;
  onPlatformChange?: (value: string) => void;
}> = (props) => {
  const [registries] = createResource(() => get<Registry[]>("/api/registries"));
  const platformListId = createUniqueId();
  const selectedIds = () => props.registryIds ?? [];

  onMount(() => {
    if (!props.proxyUrl.trim()) {
      const stored = readPullProxyUrl();
      if (stored) props.onProxyUrlChange(stored);
    }
  });

  const toggleRegistry = (id: string) => {
    const ids = selectedIds();
    props.onRegistryIdsChange?.(ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id]);
  };

  return (
    <div class="space-y-3 border-t border-zinc-800 pt-3">
      <div class="text-xs text-zinc-400">本次拉取选项</div>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label class="block">
          <span class="mb-1 block text-xs text-zinc-500" title="只对本次请求生效，不会写入容器、Compose 文件或全局设置">代理地址（记住此浏览器）</span>
          <input
            class="w-full border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm outline-none transition-colors focus:border-indigo-500"
            placeholder="http://host.docker.internal:7890"
            autocomplete="off"
            spellcheck={false}
            value={props.proxyUrl}
            onInput={(e) => {
              const value = e.currentTarget.value;
              props.onProxyUrlChange(value);
              rememberPullProxyUrl(value);
            }}
          />
          <p class="mt-1 text-[11px] text-zinc-600">地址需从 phyless 容器可达；有效的无认证地址会记住，含用户名/密码的地址不会保存。</p>
        </label>

        <Show when={props.multipleRegistries} fallback={
          <label class="block">
            <span class="mb-1 block text-xs text-zinc-500" title="为本次请求选择仓库凭据，留空不发送应用侧凭据">适用 Registry</span>
            <div class="relative">
              <select
                class="w-full appearance-none border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 pr-8 text-sm outline-none focus:border-indigo-500"
                value={props.registryId ?? ""}
                onChange={(e) => props.onRegistryIdChange?.(e.currentTarget.value)}
              >
                <option value="">不指定（匿名）</option>
                <For each={registries() ?? []}>
                  {(registry) => <option value={registry.id}>{registry.url}{registry.username ? `（${registry.username}）` : ""}</option>}
                </For>
              </select>
              <span class="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-zinc-500">▾</span>
            </div>
            <Show when={registries.error}>
              <p class="mt-1 text-[11px] text-red-400">仓库加载失败</p>
            </Show>
          </label>
        }>
          <div>
            <span class="mb-1 block text-xs text-zinc-500" title="可选择多个仓库凭据；同一 host 的多个账号会被后端拒绝">适用 Registry（可多选）</span>
            <div class="flex min-h-[2.25rem] flex-wrap gap-x-3 gap-y-1 border border-zinc-700 bg-zinc-800 px-2.5 py-1.5">
              <Show when={registries.error}>
                <span class="text-xs text-red-400">仓库加载失败</span>
              </Show>
              <Show when={!registries.error && (registries() ?? []).length > 0} fallback={<Show when={!registries.error}><span class="text-xs text-zinc-500">无已配置仓库</span></Show>}>
                <For each={registries() ?? []}>
                  {(registry) => (
                    <label class="flex items-center gap-1 text-xs text-zinc-300">
                      <input
                        type="checkbox"
                        checked={selectedIds().includes(registry.id)}
                        onChange={() => toggleRegistry(registry.id)}
                      />
                      <span>{registry.url}{registry.username ? `（${registry.username}）` : ""}</span>
                    </label>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </Show>
      </div>

      <Show when={props.showPlatform}>
        <label class="block">
          <span class="mb-1 block text-xs text-zinc-500" title="留空由 Docker daemon 选择目标平台；格式 linux/amd64 或 linux/arm/v7">平台（可选）</span>
          <input
            list={platformListId}
            class="w-full border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 font-mono text-sm outline-none transition-colors focus:border-indigo-500"
            placeholder="留空使用 Docker daemon 平台"
            value={props.platform ?? ""}
            onInput={(e) => props.onPlatformChange?.(e.currentTarget.value)}
          />
          <datalist id={platformListId}>
            <For each={PLATFORM_HINTS}>{(platform) => <option value={platform} />}</For>
          </datalist>
        </label>
      </Show>
    </div>
  );
};
