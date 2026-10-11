import { type Component, createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import {
  describeTag, isHubRef, listRegistryTags, searchRepositories, MAX_SEARCH_KEYWORD_LENGTH, MAX_REGISTRY_REF_LENGTH,
  type RegistryRepository, type RegistryTag, type RemoteRoute, type TagDetails,
} from "../../api/registrySearch";
import { credsFor } from "../../api/registryPull";
import { fmtBytes } from "../../api/download";
import { fmtRelTime } from "../containers/containerActions";
import { validWorkerUrl } from "../../stores/browserPullSettings";

const TAG_STEP = 50;
const compact = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });

// One debounced, abortable, time-limited request per effect run. Results are
// applied only while the run is current, even if fetch ignores the signal.
function request<T>(delay: number, fetch: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void,
  setLoading: (v: boolean) => void, setError: (v: string) => void) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  setLoading(true); setError("");
  const debounce = setTimeout(async () => {
    timeout = setTimeout(() => {
      controller.abort();
      setError("请求超时，请检查 Worker 地址和网络后重试");
      setLoading(false);
    }, 15000);
    try {
      const value = await fetch(controller.signal);
      if (!controller.signal.aborted) apply(value);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "远程搜索失败");
    } finally {
      clearTimeout(timeout);
      if (!controller.signal.aborted) setLoading(false);
    }
  }, delay);
  onCleanup(() => { clearTimeout(debounce); clearTimeout(timeout); controller.abort(); });
}

const Skeleton: Component<{ rows: number }> = (props) => (
  <div class="space-y-px" aria-hidden="true">
    <For each={Array.from({ length: props.rows })}>{() => (
      <div class="flex animate-pulse items-center gap-3 px-3 py-3">
        <div class="h-3 w-1/3 rounded bg-zinc-800" />
        <div class="ml-auto h-3 w-16 rounded bg-zinc-800/70" />
      </div>
    )}</For>
  </div>
);

const ErrorLine: Component<{ message: string; onRetry: () => void }> = (props) => (
  <div class="m-3 flex items-start gap-2 border border-red-900/50 bg-red-950/20 px-3 py-2 text-xs text-red-300">
    <span class="min-w-0 flex-1 break-words">{props.message}</span>
    <button type="button" class="shrink-0 text-indigo-400 hover:text-indigo-300" onClick={props.onRetry}>重试</button>
  </div>
);

const Hint: Component<{ title: string; children?: string }> = (props) => (
  <div class="flex flex-1 flex-col items-center justify-center gap-1 px-6 py-10 text-center">
    <span class="text-sm text-zinc-400">{props.title}</span>
    <Show when={props.children}><span class="text-xs text-zinc-600">{props.children}</span></Show>
  </div>
);

export const RemoteImageSearch: Component<{
  initialRef: string;
  /** Same path as the chosen pull mode: phyless server (direct/proxy) or Worker. */
  route: RemoteRoute;
  /** The ref currently in the pull field, highlighted in the tag list. */
  selectedRef?: string;
  isLocal?: (ref: string) => boolean;
  onSelect: (ref: string) => void;
  onPull?: (ref: string) => void;
  /** Opens the account form for a registry host (Docker Hub here). */
  onAddAccount?: (host: string) => void;
}> = (props) => {
  const [query, setQuery] = createSignal(props.initialRef);
  const [composing, setComposing] = createSignal(false);
  const [repository, setRepository] = createSignal("");
  // Memos: the route prop is a fresh object per change, so only real changes may refetch.
  const worker = createMemo(() => props.route.kind === "worker" ? validWorkerUrl(props.route.workerUrl) : "");
  const viaWorker = createMemo(() => props.route.kind === "worker");
  const ready = createMemo(() => !viaWorker() || !!worker());
  const proxyLabel = () => {
    if (props.route.kind !== "server" || !props.route.proxyUrl?.trim()) return "";
    try { return new URL(props.route.proxyUrl.trim()).host; } catch { return props.route.proxyUrl.trim(); }
  };
  const keyword = () => query().trim();
  // A "/" or ":" means a complete reference: skip Hub search, list its tags.
  const refQuery = () => /[/:]/.test(keyword()) ? keyword() : "";
  const tagTarget = () => repository() || refQuery();
  const queryLimit = () => refQuery() ? MAX_REGISTRY_REF_LENGTH : MAX_SEARCH_KEYWORD_LENGTH;
  const queryValid = () => keyword().length >= 2 && keyword().length <= queryLimit();

  // Repositories (Docker Hub search), appended page by page.
  const [repos, setRepos] = createSignal<RegistryRepository[]>([]);
  const [repoPage, setRepoPage] = createSignal(1);
  const [repoMore, setRepoMore] = createSignal(false);
  const [repoTotal, setRepoTotal] = createSignal(0);
  const [repoLoading, setRepoLoading] = createSignal(false);
  const [repoError, setRepoError] = createSignal("");
  const [repoAttempt, setRepoAttempt] = createSignal(0);
  // Last Docker Hub login problem; search then ran anonymously.
  const [hubError, setHubError] = createSignal("");
  const hubUser = () => props.route.kind === "worker" ? props.route.creds?.["docker.io"]?.username ?? "" : "";
  // Routes serialized to just what each lookup uses, so unrelated edits
  // (another registry's account, a Worker setting in server mode) don't refetch.
  const repoRoute = createMemo(() => {
    const r = props.route;
    return JSON.stringify(r.kind === "server"
      ? { kind: "server", proxyUrl: r.proxyUrl?.trim() ?? "" }
      : { kind: "worker", workerUrl: worker(), creds: r.creds?.["docker.io"] ? { "docker.io": r.creds["docker.io"] } : undefined });
  });

  // Tags of the chosen repository.
  const [tags, setTags] = createSignal<RegistryTag[]>([]);
  const [tagRepo, setTagRepo] = createSignal("");
  const [tagCursor, setTagCursor] = createSignal("");
  const [tagNext, setTagNext] = createSignal("");
  const [tagTotal, setTagTotal] = createSignal<number | undefined>();
  const [tagHub, setTagHub] = createSignal(false);
  const [tagFilter, setTagFilter] = createSignal("");
  const [tagShown, setTagShown] = createSignal(TAG_STEP);
  const [tagLoading, setTagLoading] = createSignal(false);
  const [tagError, setTagError] = createSignal("");
  const [tagAttempt, setTagAttempt] = createSignal(0);

  // Per-tag manifest/config details for registries without a Hub-style API.
  const [details, setDetails] = createStore<Record<string, TagDetails | "pending" | "error" | undefined>>({});
  const resetTags = () => { setTags([]); setTagCursor(""); setTagNext(""); setTagTotal(undefined); setTagShown(TAG_STEP); setTagError(""); setDetails(reconcile({})); };
  // Only the target registry's account; serialized so unrelated edits don't refetch.
  const tagRoute = createMemo(() => {
    const r = props.route;
    if (r.kind === "server") return JSON.stringify({ kind: "server", proxyUrl: r.proxyUrl?.trim() ?? "", registryIds: r.registryIds ?? [] });
    const mine = credsFor(r.creds, tagTarget());
    return JSON.stringify({ kind: "worker", workerUrl: worker(), creds: mine ? Object.fromEntries(Object.entries(r.creds ?? {}).filter(([, c]) => c === mine)) : undefined });
  });
  const [tagNotice, setTagNotice] = createSignal("");
  // A changed endpoint/account restarts pagination as well as cancelling work.
  createEffect(on(repoRoute, () => { setRepoPage(1); setRepos([]); setHubError(""); }, { defer: true }));
  createEffect(on(tagRoute, resetTags, { defer: true }));

  createEffect(() => {
    const term = keyword(); const route = JSON.parse(repoRoute()) as RemoteRoute; const page = repoPage();
    repoAttempt();
    if (!ready() || refQuery() || !queryValid() || composing()) { setRepoLoading(false); setRepoError(""); return; }
    request(page === 1 ? 300 : 0, (signal) => searchRepositories(term, route, signal, page), (result) => {
      setHubError(result.auth?.error ?? "");
      setRepos((prev) => page === 1 ? result.items : [...prev, ...result.items]);
      setRepoMore(result.hasMore); setRepoTotal(result.total);
    }, setRepoLoading, setRepoError);
  });

  createEffect(() => {
    const ref = tagTarget(); const route = JSON.parse(tagRoute()) as RemoteRoute; const cursor = tagCursor();
    // Hub filters by name server-side; other registries filter the loaded list.
    const filter = isHubRef(ref) ? tagFilter().trim() : "";
    tagAttempt();
    if (!ready() || !ref || ref.length > MAX_REGISTRY_REF_LENGTH || composing()) { setTagLoading(false); setTagError(""); return; }
    request(cursor ? 0 : 300, (signal) => listRegistryTags(ref, route, signal, cursor, filter), (page) => {
      if (!cursor) setTagNotice(page.notice ?? "");
      if (page.hub) setHubError(page.auth?.error ?? "");
      setTagRepo(page.repository); setTagHub(page.hub); setTagNext(page.next); setTagTotal(page.total);
      setTags((prev) => cursor ? [...prev, ...page.tags] : page.tags);
    }, setTagLoading, setTagError);
  });

  const visibleTags = createMemo(() => {
    const f = tagFilter().trim().toLowerCase();
    return f ? tags().filter((tag) => tag.name.toLowerCase().includes(f)) : tags();
  });
  // Fill in the shown rows top-down, 4 at a time. Docker Hub is skipped: its
  // API already has this, and manifest GETs there count as pulls.
  createEffect(() => {
    const repo = tagRepo();
    if (!repo || tagHub() || isHubRef(repo) || tagLoading()) return;
    const route = JSON.parse(tagRoute()) as RemoteRoute;
    const names = visibleTags().slice(0, tagShown()).map((t) => t.name).filter((n) => untrack(() => details[n]) === undefined);
    if (!names.length) return;
    const controller = new AbortController();
    for (const n of names) setDetails(n, "pending");
    let next = 0;
    const run = async () => {
      while (next < names.length && !controller.signal.aborted) {
        const name = names[next++];
        try {
          const d = await describeTag(`${repo}:${name}`, route, controller.signal);
          if (!controller.signal.aborted) setDetails(name, d);
        } catch {
          if (!controller.signal.aborted) setDetails(name, "error");
        }
      }
    };
    for (let i = 0; i < 4; i++) void run();
    onCleanup(() => {
      controller.abort();
      for (const n of names) if (untrack(() => details[n]) === "pending") setDetails(n, undefined);
    });
  });
  const detailOf = (name: string) => { const d = details[name]; return typeof d === "object" ? d : undefined; };
  // Repository facts from image labels (latest first): description, source, license.
  const repoInfo = createMemo(() => {
    const names = ["latest", ...visibleTags().map((t) => t.name)];
    for (const n of names) {
      const labels = detailOf(n)?.labels;
      if (!labels) continue;
      const source = labels["org.opencontainers.image.source"] ?? labels["org.opencontainers.image.url"] ?? "";
      const info = {
        description: labels["org.opencontainers.image.description"] ?? "",
        source: /^https:\/\//.test(source) ? source : "",
        license: labels["org.opencontainers.image.licenses"] ?? "",
      };
      if (info.description || info.source || info.license) return info;
    }
    return undefined;
  });

  const moreTags = () => visibleTags().length > tagShown() || !!tagNext();
  const showMoreTags = () => {
    if (visibleTags().length > tagShown()) setTagShown((n) => n + TAG_STEP);
    else if (tagNext()) { setTagShown((n) => n + TAG_STEP); setTagCursor(tagNext()); }
  };

  const chooseRepository = (name: string) => { setRepository(name); setTagFilter(""); resetTags(); };
  const onQuery = (value: string) => {
    setQuery(value); setRepository(""); setRepoPage(1); setRepos([]); setTagFilter(""); resetTags();
  };

  const showRepos = () => !refQuery();
  const tagsPane = () => !!tagTarget();

  return (
    <section class="flex min-w-0 flex-col gap-3" aria-label="远程镜像搜索">
      <label class="relative block">
        <span class="sr-only">搜索关键词 / 完整仓库名</span>
        <svg class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
        </svg>
        <input
          class="w-full rounded-md border border-zinc-700 bg-zinc-800/80 py-2.5 pl-9 pr-3 text-sm outline-none transition-colors focus:border-indigo-500"
          placeholder="搜索 Docker Hub，或输入完整仓库名，如 ghcr.io/owner/app"
          aria-label="搜索关键词 / 完整仓库名"
          autocomplete="off"
          spellcheck={false}
          maxlength={MAX_REGISTRY_REF_LENGTH}
          value={query()}
          onInput={(e) => onQuery(e.currentTarget.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
        />
      </label>

      <Show when={!viaWorker()}>
        <div class="flex min-h-[1.5rem] flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          <span class="rounded bg-zinc-800 px-1.5 leading-5 text-zinc-300">{proxyLabel() ? "服务端代理" : "服务端直连"}</span>
          <span class="min-w-0 break-all text-zinc-500">由 phyless 服务端{proxyLabel() ? <>经 <span class="font-mono text-zinc-400">{proxyLabel()}</span> </> : "直接"}访问，与当前拉取方式一致</span>
        </div>
      </Show>
      <Show when={worker()}>
        <div class="flex min-h-[1.5rem] flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          <Show when={hubUser()} fallback={
            <>
              <span class="rounded bg-amber-500/10 px-1.5 leading-5 text-amber-300">匿名</span>
              <span class="text-zinc-500">Docker Hub 匿名访问共享 Worker 出口 IP 的限额，容易出现 429。</span>
              <Show when={props.onAddAccount}>
                <button type="button" class="text-indigo-400 hover:text-indigo-300" onClick={() => props.onAddAccount!("docker.io")}>添加 Docker Hub 账号</button>
              </Show>
            </>
          }>
            <Show when={hubError()} fallback={
              <>
                <span class="rounded bg-emerald-500/10 px-1.5 leading-5 text-emerald-300">已登录</span>
                <span class="text-zinc-500">以 <span class="font-mono text-zinc-300">{hubUser()}</span> 访问 Docker Hub</span>
              </>
            }>
              <span class="rounded bg-red-500/10 px-1.5 leading-5 text-red-300">登录失败</span>
              <span class="min-w-0 break-words text-zinc-500">{hubError()}，已改为匿名访问。</span>
              <Show when={props.onAddAccount}>
                <button type="button" class="text-indigo-400 hover:text-indigo-300" onClick={() => props.onAddAccount!("docker.io")}>修改账号</button>
              </Show>
            </Show>
          </Show>
        </div>
      </Show>

      <Show when={ready()} fallback={
        <div class="flex min-h-[16rem] flex-col items-center justify-center gap-2 rounded-md border border-dashed border-zinc-700 px-6 text-center">
          <span class="text-sm text-zinc-300">搜索需要 CF Worker</span>
          <span class="max-w-sm text-xs text-zinc-500">在「前端代理地址（CF worker）」中填写有效的 HTTPS 地址，Worker 白名单需允许 hub.docker.com 与目标 registry。也可以直接在下方填写镜像引用拉取。</span>
        </div>
      }>
        <Show when={keyword().length > queryLimit()}>
          <p class="text-xs text-amber-400">搜索内容不能超过 {queryLimit()} 个字符</p>
        </Show>
        <div class={`grid min-h-[20rem] grid-cols-1 overflow-hidden rounded-md border border-zinc-800 sm:h-[28rem] ${showRepos() ? "sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" : ""}`}>
          {/* Repositories */}
          <Show when={showRepos()}>
            <div class={`min-h-0 flex-col border-zinc-800 sm:flex sm:border-r ${tagsPane() ? "hidden" : "flex"}`}>
              <div class="flex h-9 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900/60 px-3 text-[11px] text-zinc-500">
                <span>Docker Hub 仓库</span>
                <Show when={repoTotal() > 0}><span>{compact.format(repoTotal())} 个结果</span></Show>
              </div>
              <div class={`min-h-0 flex-1 overflow-y-auto transition-opacity ${repoLoading() && repos().length ? "opacity-50" : ""}`}>
                <Show when={repoError()}><ErrorLine message={repoError()} onRetry={() => setRepoAttempt((n) => n + 1)} /></Show>
                <Show when={!queryValid()}>
                  <Hint title="输入至少 2 个字符开始搜索">关键词搜索 Docker Hub 公开镜像</Hint>
                </Show>
                <Show when={queryValid() && repoLoading() && !repos().length}><Skeleton rows={6} /></Show>
                <Show when={queryValid() && !repoLoading() && !repoError() && !repos().length}>
                  <Hint title="没有匹配的仓库">可直接在下方填写镜像引用</Hint>
                </Show>
                <For each={repos()}>{(item) => (
                  <button
                    type="button"
                    aria-current={repository() === item.name}
                    class={`block w-full border-b border-l-2 border-b-zinc-800/70 px-3 py-2.5 text-left transition-colors hover:bg-zinc-800/60 focus-visible:bg-zinc-800/60 focus-visible:outline-none ${
                      repository() === item.name ? "border-l-indigo-500 bg-indigo-500/10" : "border-l-transparent"
                    }`}
                    onClick={() => chooseRepository(item.name)}
                  >
                    <span class="flex items-center gap-2">
                      <span class="min-w-0 truncate font-mono text-[13px] text-zinc-100">{item.name}</span>
                      <Show when={item.official}>
                        <span class="shrink-0 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 text-[10px] leading-4 text-emerald-300">官方</span>
                      </Show>
                    </span>
                    <span class="mt-1 flex gap-3 text-[11px] text-zinc-500">
                      <span title="Stars">★ {compact.format(item.stars)}</span>
                      <span title="下载次数">↓ {compact.format(item.pulls)}</span>
                    </span>
                    <Show when={item.description}>
                      <span class="mt-1 line-clamp-2 text-[11px] leading-4 text-zinc-500">{item.description}</span>
                    </Show>
                  </button>
                )}</For>
                <Show when={repoMore() && repos().length}>
                  <button type="button" class="w-full py-2.5 text-xs text-indigo-400 hover:bg-zinc-800/50 disabled:text-zinc-600" disabled={repoLoading()} onClick={() => setRepoPage((n) => n + 1)}>
                    {repoLoading() ? "加载中…" : "加载更多仓库"}
                  </button>
                </Show>
              </div>
            </div>
          </Show>

          {/* Tags */}
          <div class={`min-h-0 flex-col sm:flex ${tagsPane() || !showRepos() ? "flex" : "hidden"}`}>
            <Show when={tagsPane()} fallback={<Hint title="选择左侧仓库查看标签" />}>
              <div class="flex h-9 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 text-[11px] text-zinc-500">
                <Show when={repository()}>
                  <button type="button" class="shrink-0 text-indigo-400 sm:hidden" onClick={() => chooseRepository("")}>← 返回</button>
                </Show>
                <span class="min-w-0 truncate font-mono text-zinc-300" title={tagRepo() || tagTarget()}>{tagRepo() || tagTarget()}</span>
                <span class="ml-auto shrink-0">
                  <Show when={tagTotal() !== undefined}>{tagTotal()} 个标签 · </Show>
                  {tagHub() ? "按更新时间" : "按版本号"}
                </span>
              </div>
              <div class="shrink-0 border-b border-zinc-800 px-3 py-2">
                <input
                  class="w-full rounded border border-zinc-700 bg-zinc-800/80 px-2.5 py-1 font-mono text-xs outline-none focus:border-indigo-500"
                  placeholder="过滤标签，如 1.27 或 alpine"
                  aria-label="过滤标签"
                  autocomplete="off"
                  spellcheck={false}
                  maxlength={128}
                  value={tagFilter()}
                  onInput={(e) => { setTagFilter(e.currentTarget.value); setTagShown(TAG_STEP); setTagCursor(""); }}
                />
              </div>
              <div role="list" class={`min-h-0 flex-1 overflow-y-auto transition-opacity ${tagLoading() && tags().length ? "opacity-50" : ""}`}>
                <Show when={repoInfo()}>
                  {(info) => (
                    <div class="border-b border-zinc-800 bg-zinc-950/40 px-3 py-2 text-[11px] text-zinc-500">
                      <Show when={info().description}><p class="line-clamp-2 text-zinc-400">{info().description}</p></Show>
                      <div class="mt-0.5 flex flex-wrap gap-x-3">
                        <Show when={info().source}>
                          <a class="min-w-0 truncate text-indigo-400 hover:text-indigo-300" href={info().source} target="_blank" rel="noopener noreferrer">源码 ↗</a>
                        </Show>
                        <Show when={info().license}><span>许可证 {info().license}</span></Show>
                      </div>
                    </div>
                  )}
                </Show>
                <Show when={tagNotice() && !tagError()}>
                  <p class="border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-300">{tagNotice()}</p>
                </Show>
                <Show when={tagError()}><ErrorLine message={tagError()} onRetry={() => setTagAttempt((n) => n + 1)} /></Show>
                <Show when={tagLoading() && !tags().length}><Skeleton rows={8} /></Show>
                <Show when={!tagLoading() && !tagError() && !visibleTags().length}>
                  <Hint title={tagFilter().trim() ? "没有匹配的标签" : "该仓库没有可用标签"} />
                </Show>
                <For each={visibleTags().slice(0, tagShown())}>{(tag) => {
                  const ref = () => `${tagRepo()}:${tag.name}`;
                  const selected = () => props.selectedRef?.trim() === ref();
                  const local = () => !!props.isLocal?.(ref());
                  // Hub rows carry their facts; other registries fill in from details.
                  const updated = () => tag.updated ?? detailOf(tag.name)?.updated;
                  const size = () => tag.size ?? detailOf(tag.name)?.size;
                  const platforms = () => tag.platforms.length ? tag.platforms : detailOf(tag.name)?.platforms ?? [];
                  const digest = () => tag.digest ?? detailOf(tag.name)?.digest;
                  const pending = () => details[tag.name] === "pending";
                  return (
                    <div role="listitem" class={`group flex items-stretch border-b border-l-2 border-b-zinc-800/70 transition-colors hover:bg-zinc-800/50 ${selected() ? "border-l-indigo-500 bg-indigo-500/10" : "border-l-transparent"}`}>
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2 text-left focus-visible:outline-none"
                        title={digest() ? `${ref()}\n${digest()}` : ref()}
                        onClick={() => props.onSelect(ref())}
                        onDblClick={() => props.onPull?.(ref())}
                      >
                        <span class="flex min-w-0 items-center gap-2">
                          <span class="min-w-0 truncate font-mono text-[13px] text-zinc-100">{tag.name}</span>
                          <Show when={local()}>
                            <span class="shrink-0 rounded border border-sky-500/30 bg-sky-500/10 px-1.5 text-[10px] leading-4 text-sky-300">本地已有</span>
                          </Show>
                          <Show when={updated()}>
                            <span class="ml-auto shrink-0 text-[11px] tabular-nums text-zinc-500" title={new Date(updated()! * 1000).toLocaleString()}>{fmtRelTime(updated()!)}</span>
                          </Show>
                        </span>
                        <Show when={pending()}>
                          <span class="flex animate-pulse gap-1" aria-label="读取镜像信息"><span class="h-3 w-24 rounded bg-zinc-800" /><span class="ml-auto h-3 w-12 rounded bg-zinc-800" /></span>
                        </Show>
                        <Show when={platforms().length || size()}>
                          <span class="flex min-w-0 items-center gap-1 overflow-hidden text-[11px] text-zinc-500">
                            <For each={platforms().slice(0, 4)}>{(p) => <span class="shrink-0 rounded bg-zinc-800 px-1 font-mono text-[10px] text-zinc-400">{p}</span>}</For>
                            <Show when={platforms().length > 4}>
                              <span class="shrink-0 text-[10px]" title={platforms().join(", ")}>+{platforms().length - 4}</span>
                            </Show>
                            <Show when={size()}><span class="ml-auto shrink-0 pl-2 tabular-nums">{fmtBytes(size()!)}</span></Show>
                          </span>
                        </Show>
                      </button>
                      <Show when={props.onPull}>
                        <button
                          type="button"
                          class="shrink-0 px-3 text-xs text-indigo-400 transition-opacity hover:text-indigo-300 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                          aria-label={`拉取 ${ref()}`}
                          onClick={() => props.onPull!(ref())}
                        >拉取</button>
                      </Show>
                    </div>
                  );
                }}</For>
                <Show when={moreTags() && visibleTags().length}>
                  <button type="button" class="w-full py-2.5 text-xs text-indigo-400 hover:bg-zinc-800/50 disabled:text-zinc-600" disabled={tagLoading()} onClick={showMoreTags}>
                    {tagLoading() ? "加载中…" : "加载更多标签"}
                  </button>
                </Show>
              </div>
            </Show>
          </div>
        </div>
        <p class="text-[11px] text-zinc-600">单击标签填入镜像引用，双击或点「拉取」直接拉取。私有仓库自动使用对应 registry 的「仓库账号」。</p>
      </Show>
    </section>
  );
};
