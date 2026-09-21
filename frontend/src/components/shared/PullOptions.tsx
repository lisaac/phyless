import { Component, createResource, createSignal, createUniqueId, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { get } from "../../api/client";
import type { Registry } from "../../types";
import type { TaskSpec } from "../../stores/taskQueue";
import { toast } from "./Toast";
import { Ico } from "./ActionButton";
import {
  type DownloadMode,
  getDownloadMode,
  setDownloadMode,
  getWorkerUrl,
  getWorkerUrls,
  removeWorkerUrl,
  saveWorkerUrl,
  getRememberedCreds,
  rememberCreds,
  validWorkerUrl,
} from "../../stores/browserPullSettings";

export interface PullOptionsValue {
  proxyUrl?: string;
  // Derived from the selected mode; the remembered URL alone never sends a proxy.
  useProxy?: boolean;
  registryId?: string;
  registryIds?: string[];
  platform?: string;
  // Browser-download mode: pull the image in the browser (via the CF worker)
  // and stream it into the daemon, instead of the server-side proxy path.
  downloadMode?: DownloadMode;
  workerUrl?: string;
  creds?: { username: string; secret: string };
  rememberCreds?: boolean;
}

type PullMode = "none" | "server" | "browser";

const PULL_PROXY_STORAGE_KEY = "phyless_pull_proxy_url";
const PULL_PROXY_LIST_STORAGE_KEY = "phyless_pull_proxy_urls";

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
  return readPullProxyUrls()[0] ?? "";
}

function uniqueProxyUrls(values: unknown[]): string[] {
  return [...new Set(values.map((value) => typeof value === "string" ? rememberableProxyUrl(value) : "").filter(Boolean))];
}

export function readPullProxyUrls(): string[] {
  try {
    const raw = localStorage.getItem(PULL_PROXY_LIST_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return uniqueProxyUrls(parsed);
    }
    const legacy = rememberableProxyUrl(localStorage.getItem(PULL_PROXY_STORAGE_KEY) ?? "");
    if (legacy) {
      const urls = [legacy];
      localStorage.setItem(PULL_PROXY_LIST_STORAGE_KEY, JSON.stringify(urls));
      return urls;
    }
  } catch {
    // Browser storage may be disabled or contain malformed legacy data.
  }
  return [];
}

export function rememberPullProxyUrl(raw: string): void {
  const value = rememberableProxyUrl(raw);
  if (value) {
    savePullProxyUrl(value);
    return;
  }
  if (!raw.trim()) clearPullProxyUrls();
}

export function savePullProxyUrl(raw: string): string[] {
  const value = rememberableProxyUrl(raw);
  if (!value) return readPullProxyUrls();
  const urls = [value, ...readPullProxyUrls().filter((url) => url !== value)];
  try {
    localStorage.setItem(PULL_PROXY_LIST_STORAGE_KEY, JSON.stringify(urls));
    localStorage.setItem(PULL_PROXY_STORAGE_KEY, value);
  } catch {
    // Keep the current component value usable when storage is unavailable.
  }
  return urls;
}

export function removePullProxyUrl(raw: string): string[] {
  const value = raw.trim();
  const urls = readPullProxyUrls().filter((url) => url !== value);
  try {
    if (urls.length) {
      localStorage.setItem(PULL_PROXY_LIST_STORAGE_KEY, JSON.stringify(urls));
      localStorage.setItem(PULL_PROXY_STORAGE_KEY, urls[0]);
    } else {
      clearPullProxyUrls();
    }
  } catch {
    // Ignore storage failures; the caller still receives the new list.
  }
  return urls;
}

function clearPullProxyUrls(): void {
  try {
    localStorage.removeItem(PULL_PROXY_LIST_STORAGE_KEY);
    localStorage.removeItem(PULL_PROXY_STORAGE_KEY);
  } catch {
    // Browser storage may be disabled; the request still uses component state.
  }
}

// Keep request-only pull settings out of the run/compose model. Callers own
// the short-lived values so closing a modal can release them immediately.
export function pullOptionsPayload(value: PullOptionsValue): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value.useProxy && value.proxyUrl?.trim()) out.proxy_url = value.proxyUrl.trim();
  if (value.registryId) out.registry_id = value.registryId;
  if (value.registryIds?.length) out.registry_ids = value.registryIds;
  if (value.platform?.trim()) out.platform = value.platform.trim();
  return out;
}

// One state holder shared by every pull form (image pull, create container,
// upgrade, compose up/pull). reset() is what callers run on close: the proxy
// mode is off per open, while saved URLs come back from this browser's memory.
export function createPullOptions() {
  const fresh = (): Required<PullOptionsValue> => {
    const workerUrl = getWorkerUrl();
    const remembered = getRememberedCreds(workerUrl);
    return {
      proxyUrl: readPullProxyUrl(), useProxy: false, registryId: "", registryIds: [], platform: "",
      downloadMode: getDownloadMode(), workerUrl,
      creds: remembered ?? { username: "", secret: "" }, rememberCreds: !!remembered,
    };
  };
  const [value, set] = createStore(fresh());
  return { value, set, payload: () => pullOptionsPayload(value), reset: () => set(fresh()) };
}
export type PullOptionsState = ReturnType<typeof createPullOptions>;

export function isBrowserDownload(value: PullOptionsValue): boolean {
  return value.downloadMode === "browser";
}

// Every pull entry point's submit guard: browser mode is unusable without a
// worker. Toasts and returns false when it is missing.
export function browserWorkerReady(value: PullOptionsValue): boolean {
  if (!isBrowserDownload(value) || value.workerUrl?.trim()) return true;
  toast.error("请先填写 CF worker 地址");
  return false;
}

// Build a browser-pull task spec. Credentials go in `secret` (never persisted
// to task history); ref/platform/workerUrl are non-sensitive and ride in meta.
export function browserPullSpec(title: string, ref: string, key: string, value: PullOptionsValue): TaskSpec {
  return {
    title,
    url: "",
    key,
    meta: { type: "browser-pull", ref, platform: value.platform?.trim() ?? "", workerUrl: value.workerUrl ?? "" },
    secret: value.creds?.secret ? { creds: value.creds } : undefined,
  };
}

const PLATFORM_HINTS = ["linux/amd64", "linux/arm64", "linux/arm/v7"];

const SavedAddressInput: Component<{
  value: string;
  urls: string[];
  placeholder: string;
  disabled?: boolean;
  onInput: (value: string) => void;
  onBlur: () => void;
  onSelect: (value: string) => void;
  onDelete: (value: string) => void;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;
  const onFocusOut = (e: FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (!next || !root?.contains(next)) setTimeout(() => setOpen(false), 0);
  };
  return (
    <div ref={root} class="relative flex min-w-0" onFocusOut={onFocusOut}>
      <input
        class="min-w-0 flex-1 border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm outline-none transition-colors focus:border-indigo-500 disabled:opacity-40"
        placeholder={props.placeholder}
        autocomplete="off"
        spellcheck={false}
        disabled={props.disabled}
        value={props.value}
        onFocus={() => setOpen(true)}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onBlur={props.onBlur}
      />
      <button
        type="button"
        class="shrink-0 border border-l-0 border-zinc-700 bg-zinc-800 px-2 text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-40"
        aria-label="显示已保存地址"
        disabled={props.disabled}
        onMouseDown={(e) => { e.preventDefault(); setOpen((value) => !value); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((value) => !value);
          }
        }}
      >▾</button>
      <Show when={open() && props.urls.length > 0}>
        <div class="absolute left-0 right-0 top-full z-30 mt-0.5 border border-zinc-700 bg-zinc-900 shadow-xl">
          <For each={props.urls}>
            {(url) => (
              <div class="flex items-center border-b border-zinc-800 last:border-b-0">
                <button
                  type="button"
                  class="min-w-0 flex-1 truncate px-2.5 py-1.5 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { props.onSelect(url); setOpen(false); }}
                >{url}</button>
                <button
                  type="button"
                  class="shrink-0 px-2 py-1.5 text-zinc-500 transition-colors hover:bg-red-950/40 hover:text-red-400"
                  aria-label={`删除地址 ${url}`}
                  title={`删除地址 ${url}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => { e.stopPropagation(); props.onDelete(url); }}
                ><Ico path="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export const PullOptions: Component<{
  options: PullOptionsState;
  showPlatform?: boolean;
  multipleRegistries?: boolean;
  // Expose the browser-download mode. Only entry points that actually handle a
  // browser-pull task (image pull, compose) set this; others stay proxy-only.
  allowBrowser?: boolean;
}> = (props) => {
  const [registries] = createResource(() => get<Registry[]>("/api/registries"));
  const platformListId = createUniqueId();
  const modeName = createUniqueId();
  const { value, set } = props.options;
  const [localWorkerUrls, setLocalWorkerUrls] = createSignal(getWorkerUrls());
  const [localProxyUrls, setLocalProxyUrls] = createSignal(readPullProxyUrls());
  const workerUrls = localWorkerUrls;
  const proxyUrls = localProxyUrls;

  const toggleRegistry = (id: string) => {
    const ids = value.registryIds;
    set("registryIds", ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id]);
  };

  const pullMode = (): PullMode => {
    if (props.allowBrowser && value.downloadMode === "browser") return "browser";
    return value.useProxy ? "server" : "none";
  };
  const setPullMode = (mode: PullMode) => {
    const browser = mode === "browser";
    set("downloadMode", browser ? "browser" : "proxy");
    set("useProxy", mode === "server");
    setDownloadMode(browser ? "browser" : "proxy");
  };
  const browserMode = () => pullMode() === "browser";
  const serverProxyMode = () => pullMode() === "server";

  const setWorker = (workerUrl: string) => {
    const creds = getRememberedCreds(workerUrl);
    set("workerUrl", workerUrl);
    set("creds", creds ?? { username: "", secret: "" });
    set("rememberCreds", !!creds);
  };

  const saveWorker = () => {
    const url = validWorkerUrl(value.workerUrl);
    if (!value.workerUrl.trim()) return;
    if (!url) {
      toast.error("请输入合法的 HTTPS Worker 地址");
      return;
    }
    setLocalWorkerUrls(saveWorkerUrl(url));
    setWorker(url);
  };

  const deleteWorker = (url: string) => {
    const urls = removeWorkerUrl(url);
    setLocalWorkerUrls(urls);
    if (value.workerUrl.trim() === url.trim()) setWorker(urls[0] ?? "");
  };

  const saveProxy = () => {
    const url = rememberableProxyUrl(value.proxyUrl);
    if (!value.proxyUrl.trim()) return;
    if (!url) {
      toast.error("请输入合法的代理地址（http/https/socks5）");
      return;
    }
    setLocalProxyUrls(savePullProxyUrl(url));
    set("proxyUrl", url);
  };

  const deleteProxy = (url: string) => {
    const urls = removePullProxyUrl(url);
    setLocalProxyUrls(urls);
    if (value.proxyUrl.trim() === url.trim()) set("proxyUrl", urls[0] ?? "");
  };

  const setCreds = (creds: { username: string; secret: string }) => {
    set("creds", creds);
    if (value.rememberCreds) rememberCreds(value.workerUrl, creds);
  };

  return (
    <div class="space-y-3 border-t border-zinc-800 pt-3">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span class="text-xs text-zinc-400">本次拉取选项</span>
        <label class="flex items-center gap-1.5 text-xs text-zinc-400" title="直接使用服务端现有网络连接">
          <input type="radio" name={modeName} checked={pullMode() === "none"} onChange={() => setPullMode("none")} />
          不使用代理
        </label>
        <label class="flex items-center gap-1.5 text-xs text-zinc-400" title="phyless 服务端经代理拉取镜像">
          <input type="radio" name={modeName} checked={pullMode() === "server"} onChange={() => setPullMode("server")} />
          服务端代理
        </label>
        <Show when={props.allowBrowser}>
          <label class="flex items-center gap-1.5 text-xs text-zinc-400" title="浏览器经 CF worker 下载并导入镜像">
            <input type="radio" name={modeName} checked={pullMode() === "browser"} onChange={() => setPullMode("browser")} />
            浏览器代理导入
          </label>
        </Show>
      </div>

      <Show when={browserMode()}>
        <div class="space-y-3">
          <div>
            <span class="mb-1 block text-xs text-zinc-500">CF worker 地址</span>
            <SavedAddressInput
              value={value.workerUrl}
              urls={workerUrls()}
              placeholder="https://your-worker.workers.dev"
              onInput={setWorker}
              onBlur={saveWorker}
              onSelect={setWorker}
              onDelete={deleteWorker}
            />
            <p class="mt-1 text-[11px] text-zinc-600">浏览器经此 worker 访问 registry；地址列表仅保存在此浏览器，且不含用户名/密码。</p>
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label class="block">
              <span class="mb-1 block text-xs text-zinc-500">私有镜像用户名（可选）</span>
              <input
                class="w-full border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm outline-none focus:border-indigo-500"
                autocomplete="off"
                value={value.creds?.username ?? ""}
                onInput={(e) => setCreds({ username: e.currentTarget.value, secret: value.creds?.secret ?? "" })}
              />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs text-zinc-500">密码 / Token（可选）</span>
              <input
                type="password"
                class="w-full border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm outline-none focus:border-indigo-500"
                autocomplete="off"
                value={value.creds?.secret ?? ""}
                onInput={(e) => setCreds({ username: value.creds?.username ?? "", secret: e.currentTarget.value })}
              />
            </label>
          </div>
          <label class="flex items-center gap-1.5 text-xs text-zinc-500">
            <input
              type="checkbox"
              checked={!!value.rememberCreds}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                set("rememberCreds", on);
                rememberCreds(value.workerUrl, on ? value.creds ?? null : null);
              }}
            />
            记住凭据（仅此浏览器，明文存于 localStorage，XSS 可读取）
          </label>
          <p class="text-[11px] text-zinc-600">凭据按 CF worker 地址保存；切换地址会载入对应凭据，新地址保持为空。凭据不会发送给 phyless 服务端。</p>
          <p class="text-[11px] text-zinc-600">限制：仅支持 Linux 的 tag 镜像；digest、foreign layer 不支持。Compose Build 仅预拉可静态解析的 Dockerfile FROM。</p>
        </div>
      </Show>

      <Show when={!browserMode()}>
        <div class="space-y-3">
          <Show when={serverProxyMode()}>
            <div>
              <span class="mb-1 block text-xs text-zinc-500">服务端代理地址</span>
              <SavedAddressInput
                value={value.proxyUrl}
                urls={proxyUrls()}
                placeholder="http://host.docker.internal:7890"
                onInput={(url) => set("proxyUrl", url)}
                onBlur={saveProxy}
                onSelect={(url) => set("proxyUrl", url)}
                onDelete={deleteProxy}
              />
              <p class="mt-1 text-[11px] text-zinc-600">地址需从 phyless 容器可达；无认证地址会记住在此浏览器，含用户名/密码的地址不会保存。</p>
            </div>
          </Show>

        <Show when={props.multipleRegistries} fallback={
          <label class="block">
            <span class="mb-1 block text-xs text-zinc-500" title="为本次请求选择仓库凭据，留空不发送应用侧凭据">适用 Registry</span>
            <div class="relative">
              <select
                class="w-full appearance-none border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 pr-8 text-sm outline-none focus:border-indigo-500"
                value={value.registryId}
                onChange={(e) => set("registryId", e.currentTarget.value)}
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
                        checked={value.registryIds.includes(registry.id)}
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
      </Show>

      <Show when={props.showPlatform}>
        <label class="block">
          <span class="mb-1 block text-xs text-zinc-500" title="留空由 Docker daemon 选择目标平台；格式 linux/amd64 或 linux/arm/v7">平台（可选）</span>
          <input
            list={platformListId}
            class="w-full border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 font-mono text-sm outline-none transition-colors focus:border-indigo-500"
            placeholder="留空使用 Docker daemon 平台"
            value={value.platform}
            onInput={(e) => set("platform", e.currentTarget.value)}
          />
          <datalist id={platformListId}>
            <For each={PLATFORM_HINTS}>{(platform) => <option value={platform} />}</For>
          </datalist>
        </label>
      </Show>
    </div>
  );
};
