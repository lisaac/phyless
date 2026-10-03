import { type Component, createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { listRegistryTags, searchRepositories, MAX_SEARCH_KEYWORD_LENGTH, MAX_REGISTRY_REF_LENGTH, type RegistryRepository } from "../../api/registrySearch";
import type { Creds } from "../../api/registryPull";
import { validWorkerUrl } from "../../stores/browserPullSettings";

export const RemoteImageSearch: Component<{
  initialRef: string;
  workerUrl: string;
  creds?: Creds;
  onSelect: (ref: string) => void;
}> = (props) => {
  const [query, setQuery] = createSignal(props.initialRef);
  const [repository, setRepository] = createSignal("");
  const [page, setPage] = createSignal(1);
  const [cursor, setCursor] = createSignal("");
  const [composing, setComposing] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [repositories, setRepositories] = createSignal<RegistryRepository[]>([]);
  const [tags, setTags] = createSignal<string[]>([]);
  const [tagRepository, setTagRepository] = createSignal("");
  const [next, setNext] = createSignal("");
  const [hasMore, setHasMore] = createSignal(false);
  const [attempt, setAttempt] = createSignal(0);
  const worker = () => validWorkerUrl(props.workerUrl);
  const tagRef = () => repository() || (/[/:]/.test(query().trim()) ? query().trim() : "");
  const queryLimit = () => tagRef() ? MAX_REGISTRY_REF_LENGTH : MAX_SEARCH_KEYWORD_LENGTH;

  const resetPage = () => { setPage(1); setCursor(""); };
  createEffect(() => {
    // A changed endpoint/account must restart pagination as well as cancel work.
    worker(); props.creds?.username; props.creds?.secret;
    resetPage();
  });

  createEffect(() => {
    const keyword = query().trim();
    const ref = tagRef();
    const workerUrl = worker();
    const currentPage = page();
    const last = cursor();
    const isComposing = composing();
    attempt();
    const credentials = ref && props.creds?.username && props.creds?.secret ? { ...props.creds } : undefined;
    setRepositories([]); setTags([]); setError(""); setHasMore(false); setNext(""); setLoading(false);
    if (!workerUrl || keyword.length < 2 || keyword.length > queryLimit() || isComposing) return;

    const controller = new AbortController();
    setLoading(true);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const debounce = setTimeout(async () => {
      timeout = setTimeout(() => {
        setError("搜索超时，请检查 Worker 地址和网络后重试");
        setLoading(false);
        controller.abort();
      }, 15000);
      try {
        if (ref) {
          const result = await listRegistryTags(ref, workerUrl, credentials, controller.signal, last);
          if (controller.signal.aborted) return;
          setTagRepository(result.repository); setTags(result.tags); setNext(result.next);
        } else {
          const result = await searchRepositories(keyword, workerUrl, controller.signal, currentPage);
          if (controller.signal.aborted) return;
          setRepositories(result.items); setHasMore(result.hasMore);
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "远程搜索失败");
      } finally {
        clearTimeout(timeout);
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 300);
    onCleanup(() => { clearTimeout(debounce); clearTimeout(timeout); controller.abort(); });
  });

  return (
    <div class="mb-3 space-y-2 border border-zinc-800 bg-zinc-950/40 p-3">
      <label class="block">
        <span class="mb-1 block text-xs text-zinc-400">搜索关键词 / 完整仓库名</span>
        <input
          class="w-full border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm outline-none focus:border-indigo-500"
          placeholder="nginx 或 ghcr.io/owner/app"
          autocomplete="off"
          spellcheck={false}
          maxlength={MAX_REGISTRY_REF_LENGTH}
          value={query()}
          onInput={(e) => { setQuery(e.currentTarget.value); setRepository(""); resetPage(); }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
        />
      </label>
      <p class="text-[11px] text-zinc-500">关键词搜索 Docker Hub 公开镜像；完整仓库名查询标签。选择标签后回填，点击「拉取」提交。</p>
      <Show when={!worker()}>
        <p class="text-xs text-amber-400">请在下方填写有效的 HTTPS CF worker 地址以启用搜索。</p>
      </Show>
      <Show when={worker()}>
        <p class="text-[11px] text-zinc-500">Worker 需允许 hub.docker.com、目标 registry 和认证域名。私有仓库使用下方浏览器凭据。</p>
        <Show when={tagRef()}>
          <div class="flex items-center justify-between gap-2 text-xs text-zinc-400">
            <span class="min-w-0 truncate">标签：{tagRef()}</span>
            <Show when={repository()}>
              <button type="button" class="shrink-0 text-indigo-400" onClick={() => { setRepository(""); resetPage(); }}>返回搜索</button>
            </Show>
          </div>
        </Show>
        <div role="status" class="text-xs text-zinc-500">
          <Show when={query().trim().length < 2}>输入至少 2 个字符开始搜索</Show>
          <Show when={query().trim().length > queryLimit()}>搜索内容不能超过 {queryLimit()} 个字符</Show>
          <Show when={loading()}>搜索中…</Show>
          <Show when={error()}>
            <span class="text-red-400">{error()}</span>
            <button type="button" class="ml-2 text-indigo-400" onClick={() => setAttempt((value) => value + 1)}>重试</button>
          </Show>
          <Show when={!loading() && !error() && tags().length === 0 && repositories().length === 0 && query().trim().length >= 2 && query().trim().length <= queryLimit()}>
            暂无候选结果，可继续手动填写镜像引用
          </Show>
        </div>
        <div class="max-h-56 overflow-y-auto">
          <For each={repositories()}>{(item) => (
            <button
              type="button"
              class="block w-full border-b border-zinc-800 px-2 py-2 text-left transition-colors hover:bg-zinc-800 focus-visible:outline focus-visible:outline-indigo-500"
              onClick={() => { setRepository(item.name); resetPage(); }}
            >
              <span class="block font-mono text-xs text-zinc-200">{item.name}{item.official ? " · 官方" : ""}</span>
              <Show when={item.description}><span class="block truncate text-[11px] text-zinc-500">{item.description}</span></Show>
            </button>
          )}</For>
          <div class="flex flex-wrap gap-1.5">
            <For each={tags()}>{(tag) => (
              <button type="button" class="border border-zinc-700 px-2 py-1 font-mono text-xs text-zinc-300 hover:border-indigo-500 hover:text-indigo-300" onClick={() => props.onSelect(`${tagRepository()}:${tag}`)}>{tag}</button>
            )}</For>
          </div>
        </div>
        <Show when={hasMore() || next()}>
          <button type="button" class="text-xs text-indigo-400" onClick={() => { if (tagRef()) setCursor(next()); else setPage((value) => value + 1); }}>下一页</button>
        </Show>
      </Show>
    </div>
  );
};
