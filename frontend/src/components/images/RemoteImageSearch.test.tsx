import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { RemoteImageSearch } from "./RemoteImageSearch";

const { search, tags, describe: describeTagMock } = vi.hoisted(() => ({ search: vi.fn(), tags: vi.fn(), describe: vi.fn() }));
vi.mock("../../api/registrySearch", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api/registrySearch")>(), searchRepositories: search, listRegistryTags: tags, describeTag: describeTagMock,
}));

const W = "https://worker.example";
const repo = (name: string, official = false) => ({ name, description: `${name} image`, official, stars: 1200, pulls: 3_400_000 });
const page = (repository: string, names: string[], extra: Record<string, unknown> = {}) =>
  ({ repository, tags: names.map((name) => ({ name, platforms: [] })), next: "", hub: false, total: names.length, ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  search.mockReset().mockResolvedValue({ items: [], hasMore: false, total: 0 });
  tags.mockReset().mockResolvedValue(page("nginx", []));
  describeTagMock.mockReset().mockResolvedValue({ platforms: [], labels: {} });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const tick = () => vi.advanceTimersByTimeAsync(300);
const input = () => screen.getByLabelText("搜索关键词 / 完整仓库名");
const tagButton = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name.replace(/[.]/g, "\\.")}`) });

describe("remote image search", () => {
  it("lists tags of a complete reference directly, fills on click and pulls on double-click or the row action", async () => {
    const ref = `registry.example/team/${"a".repeat(140)}`;
    tags.mockResolvedValue(page(ref, ["latest", "v1"]));
    const select = vi.fn();
    const pull = vi.fn();
    render(() => <RemoteImageSearch initialRef={ref} route={{ kind: "worker", workerUrl: W }} onSelect={select} onPull={pull} isLocal={(r) => r === `${ref}:v1`} />);
    expect((input() as HTMLInputElement).maxLength).toBeGreaterThanOrEqual(ref.length);
    await tick();
    expect(tags).toHaveBeenCalledWith(ref, { kind: "worker", workerUrl: W }, expect.any(AbortSignal), "", "");
    expect(search).not.toHaveBeenCalled();
    fireEvent.click(tagButton("latest"));
    expect(select).toHaveBeenCalledWith(`${ref}:latest`);
    expect(pull).not.toHaveBeenCalled();
    fireEvent.dblClick(tagButton("latest"));
    fireEvent.click(screen.getByRole("button", { name: `拉取 ${ref}:v1` }));
    expect(pull.mock.calls).toEqual([[`${ref}:latest`], [`${ref}:v1`]]);
    expect(screen.getAllByText("本地已有")).toHaveLength(1);
    expect(screen.getByText("按版本号", { exact: false })).toBeTruthy();
  });

  it("keeps the Hub keyword limit when allowing longer repository references", async () => {
    render(() => <RemoteImageSearch initialRef="" route={{ kind: "worker", workerUrl: W }} onSelect={vi.fn()} />);
    fireEvent.input(input(), { target: { value: "a".repeat(129) } });
    await tick();
    expect(screen.getByText("搜索内容不能超过 128 个字符")).toBeTruthy();
    expect(search).not.toHaveBeenCalled();
    expect(tags).not.toHaveBeenCalled();
  });

  it("waits for two characters, debounces rapid input, and skips IME composition", async () => {
    render(() => <RemoteImageSearch initialRef="" route={{ kind: "worker", workerUrl: W }} onSelect={vi.fn()} />);
    fireEvent.input(input(), { target: { value: "n" } });
    await tick();
    expect(search).not.toHaveBeenCalled();
    fireEvent.input(input(), { target: { value: "ng" } });
    await vi.advanceTimersByTimeAsync(150);
    fireEvent.input(input(), { target: { value: "nginx" } });
    await vi.advanceTimersByTimeAsync(299);
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(search).toHaveBeenCalledTimes(1);
    fireEvent.compositionStart(input());
    fireEvent.input(input(), { target: { value: "redis" } });
    await tick();
    expect(search).toHaveBeenCalledTimes(1);
    fireEvent.compositionEnd(input());
    await tick();
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("aborts old requests and ignores late results even when the fetch mock ignores abort", async () => {
    let complete!: (result: unknown) => void;
    search.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }))
      .mockResolvedValueOnce({ items: [repo("redis", true)], hasMore: false, total: 1 });
    render(() => <RemoteImageSearch initialRef="nginx" route={{ kind: "worker", workerUrl: W }} onSelect={vi.fn()} />);
    await tick();
    const oldSignal = search.mock.calls[0][2] as AbortSignal;
    fireEvent.input(input(), { target: { value: "redis" } });
    expect(oldSignal.aborted).toBe(true);
    await tick();
    complete({ items: [repo("stale")], hasMore: false, total: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByText("stale")).toBeNull();
    expect(screen.getByRole("button", { name: /redis/ })).toBeTruthy();
  });

  it("shows repository stats, appends Hub pages on demand and restarts for a new query", async () => {
    search.mockResolvedValueOnce({ items: [repo("nginx", true)], hasMore: true, total: 300 })
      .mockResolvedValueOnce({ items: [repo("bitnami/nginx")], hasMore: false, total: 300 })
      .mockResolvedValue({ items: [], hasMore: false, total: 0 });
    render(() => <RemoteImageSearch initialRef="nginx" route={{ kind: "worker", workerUrl: W }} onSelect={vi.fn()} />);
    await tick();
    expect(screen.getByText("官方")).toBeTruthy();
    expect(screen.getByText("★ 1200")).toBeTruthy();
    expect(screen.getByText(/↓ 340万/)).toBeTruthy();
    await vi.advanceTimersByTimeAsync(2000);
    expect(search).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "加载更多仓库" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(search.mock.calls[1][3]).toBe(2);
    expect(screen.getByRole("button", { name: /^nginx/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^bitnami\/nginx/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "加载更多仓库" })).toBeNull();
    fireEvent.input(input(), { target: { value: "redis" } });
    await tick();
    expect(search.mock.calls[2][3]).toBe(1);
    expect(screen.getByText("没有匹配的仓库")).toBeTruthy();
  });

  it("loads Hub tags after repository selection, pages with the cursor and filters by name on the server", async () => {
    search.mockResolvedValue({ items: [repo("nginx", true)], hasMore: false, total: 1 });
    tags.mockResolvedValueOnce(page("nginx", ["1.27"], { next: "2", hub: true, total: 2 }))
      .mockResolvedValueOnce(page("nginx", ["latest"], { hub: true, total: 2 }))
      .mockResolvedValue(page("nginx", ["1.26-alpine"], { hub: true, total: 1 }));
    const select = vi.fn();
    render(() => <RemoteImageSearch initialRef="nginx" route={{ kind: "worker", workerUrl: W }} onSelect={select} selectedRef="nginx:latest" />);
    await tick();
    expect(tags).not.toHaveBeenCalled();
    expect(screen.getByText("选择左侧仓库查看标签")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^nginx/ }));
    await tick();
    expect(tags.mock.calls[0].slice(3)).toEqual(["", ""]);
    expect(screen.getByText("按更新时间", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "加载更多标签" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(tags.mock.calls[1][3]).toBe("2");
    expect(tagButton("1.27")).toBeTruthy();
    expect(tagButton("latest").closest("[role=listitem]")!.className).toContain("border-l-indigo-500");
    fireEvent.click(tagButton("latest"));
    expect(select).toHaveBeenCalledWith("nginx:latest");
    fireEvent.input(screen.getByLabelText("过滤标签"), { target: { value: "alpine" } });
    await tick();
    expect(tags.mock.calls[2].slice(3)).toEqual(["", "alpine"]);
    expect(tagButton("1.26-alpine")).toBeTruthy();
  });

  it("filters and pages a V2 tag list locally without refetching", async () => {
    tags.mockResolvedValue(page("ghcr.io/o/app", Array.from({ length: 60 }, (_, i) => `v${i}`)));
    render(() => <RemoteImageSearch initialRef="ghcr.io/o/app" route={{ kind: "worker", workerUrl: W }} onSelect={vi.fn()} />);
    await tick();
    expect(screen.getAllByRole("listitem")).toHaveLength(50);
    fireEvent.click(screen.getByRole("button", { name: "加载更多标签" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(60);
    fireEvent.input(screen.getByLabelText("过滤标签"), { target: { value: "v5" } });
    await tick();
    expect(screen.getAllByRole("listitem").map((el) => el.textContent?.match(/^v\d+/)?.[0])).toEqual(["v5", ...Array.from({ length: 10 }, (_, i) => `v5${i}`)]);
    expect(tags).toHaveBeenCalledTimes(1);
  });

  it("sends only the target registry's credentials and restarts paging only when those change", async () => {
    const hub = { username: "hub", secret: "h" };
    const [creds, setCreds] = createSignal<Record<string, { username: string; secret: string }>>({ "docker.io": hub });
    tags.mockResolvedValue(page("registry.example/app", ["v1"], { next: "2", hub: true }));
    render(() => <RemoteImageSearch initialRef="registry.example/app" route={{ kind: "worker", workerUrl: W, creds: creds() }} onSelect={vi.fn()} />);
    await tick();
    expect(tags.mock.calls[0][1].creds).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "加载更多标签" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(tags.mock.calls[1][3]).toBe("2");
    setCreds({ "docker.io": { username: "hub", secret: "changed" } });
    await tick();
    expect(tags).toHaveBeenCalledTimes(2);
    const oldSignal = tags.mock.calls[1][2] as AbortSignal;
    setCreds({ "docker.io": hub, "registry.example": { username: "user", secret: "secret" } });
    expect(oldSignal.aborted).toBe(true);
    await tick();
    expect(tags.mock.calls[2][1].creds).toEqual({ "registry.example": { username: "user", secret: "secret" } });
    expect(tags.mock.calls[2][3]).toBe("");
  });

  it("keeps requests disabled without a valid Worker and cancels on configuration change or unmount", async () => {
    const [worker, setWorker] = createSignal("");
    const mounted = render(() => <RemoteImageSearch initialRef="ghcr.io/owner/app" route={{ kind: "worker", workerUrl: worker() }} onSelect={vi.fn()} />);
    await tick();
    expect(tags).not.toHaveBeenCalled();
    expect(screen.getByText("搜索需要 CF Worker")).toBeTruthy();
    setWorker(W);
    await tick();
    const firstSignal = tags.mock.calls[0][2] as AbortSignal;
    setWorker("https://other-worker.example");
    expect(firstSignal.aborted).toBe(true);
    await tick();
    const secondSignal = tags.mock.calls[1][2] as AbortSignal;
    mounted.unmount();
    expect(secondSignal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(20000);
    expect(tags).toHaveBeenCalledTimes(2);
  });

  it("times out, exposes an explicit retry, and cancels a pending debounce on unmount", async () => {
    search.mockImplementationOnce(() => new Promise(() => {}));
    const mounted = render(() => <RemoteImageSearch initialRef="nginx" route={{ kind: "worker", workerUrl: W }} onSelect={vi.fn()} />);
    await tick();
    await vi.advanceTimersByTimeAsync(15000);
    expect(screen.getByText(/请求超时/)).toBeTruthy();
    expect(search.mock.calls[0][2].aborted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await tick();
    expect(search).toHaveBeenCalledTimes(2);
    fireEvent.input(input(), { target: { value: "redis" } });
    mounted.unmount();
    await tick();
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("shows errors without polling", async () => {
    search.mockRejectedValue(new Error("镜像仓库请求过于频繁（429）"));
    render(() => <RemoteImageSearch initialRef="nginx" route={{ kind: "worker", workerUrl: W }} onSelect={vi.fn()} />);
    await tick();
    expect(screen.getByText("镜像仓库请求过于频繁（429）")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(30000);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("searches as the Docker Hub account only, shows who is searching, and offers to add an account", async () => {
    const add = vi.fn();
    const [creds, setCreds] = createSignal<Record<string, { username: string; secret: string }>>({ "ghcr.io": { username: "gh", secret: "g" } });
    search.mockResolvedValue({ items: [], hasMore: false, total: 0, auth: {} });
    render(() => <RemoteImageSearch initialRef="nginx" route={{ kind: "worker", workerUrl: W, creds: creds() }} onSelect={vi.fn()} onAddAccount={add} />);
    await tick();
    expect(search.mock.calls[0][1].creds).toBeUndefined();
    expect(screen.getByText("匿名")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "添加 Docker Hub 账号" }));
    expect(add).toHaveBeenCalledWith("docker.io");
    setCreds({ "docker.io": { username: "alice", secret: "pat" } });
    await tick();
    expect(search.mock.calls[1][1].creds).toEqual({ "docker.io": { username: "alice", secret: "pat" } });
    expect(screen.getByText("已登录")).toBeTruthy();
    expect(screen.getByText("alice")).toBeTruthy();
    search.mockResolvedValue({ items: [], hasMore: false, total: 0, auth: { error: "Docker Hub 用户名或密码 / Token 无效" } });
    fireEvent.input(input(), { target: { value: "redis" } });
    await tick();
    expect(screen.getByText("登录失败")).toBeTruthy();
    expect(screen.getByText(/Token 无效，已改为匿名访问/)).toBeTruthy();
  });

  it("follows a server route without any Worker, and says which path it uses", async () => {
    const [route, setRoute] = createSignal<{ kind: "server"; proxyUrl?: string; registryIds?: string[] }>({ kind: "server" });
    search.mockResolvedValue({ items: [repo("nginx", true)], hasMore: false, total: 1, auth: {} });
    render(() => <RemoteImageSearch initialRef="nginx" route={route()} onSelect={vi.fn()} onAddAccount={vi.fn()} />);
    await tick();
    expect(search.mock.calls[0][1]).toEqual({ kind: "server", proxyUrl: "" });
    expect(screen.getByText("服务端直连")).toBeTruthy();
    expect(screen.queryByText("搜索需要 CF Worker")).toBeNull();
    expect(screen.queryByRole("button", { name: "添加 Docker Hub 账号" })).toBeNull();
    setRoute({ kind: "server", registryIds: ["reg-1"] });
    await tick();
    expect(search).toHaveBeenCalledTimes(1);
    setRoute({ kind: "server", proxyUrl: "http://proxy.lan:7890" });
    await tick();
    expect(search.mock.calls[1][1]).toEqual({ kind: "server", proxyUrl: "http://proxy.lan:7890" });
    expect(screen.getByText("服务端代理")).toBeTruthy();
    expect(screen.getByText("proxy.lan:7890")).toBeTruthy();
  });

  it("shows why a Hub tag list was reduced", async () => {
    tags.mockResolvedValue(page("nginx", ["latest"], { notice: "Docker Hub API 限额已满，已改用 registry 接口：仅显示标签名，按版本号排序" }));
    render(() => <RemoteImageSearch initialRef="nginx:latest" route={{ kind: "server" }} onSelect={vi.fn()} />);
    await tick();
    expect(screen.getByText(/限额已满，已改用 registry 接口/)).toBeTruthy();
  });

  it("fills GHCR rows from manifests (4 at a time), shows repo labels, and never describes Docker Hub", async () => {
    const names = Array.from({ length: 6 }, (_, i) => `v${6 - i}`);
    tags.mockResolvedValue(page("ghcr.io/o/app", ["latest", ...names]));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    describeTagMock.mockImplementation(async (ref: string) => {
      await gate;
      return ref.endsWith(":latest")
        ? { updated: Date.now() / 1000 - 7200, size: 31_000_000, platforms: ["amd64", "arm64"], labels: {
          "org.opencontainers.image.description": "Home automation", "org.opencontainers.image.source": "https://github.com/o/app", "org.opencontainers.image.licenses": "Apache-2.0",
        } }
        : { platforms: ["amd64"], labels: { "org.opencontainers.image.source": "javascript:alert(1)" } };
    });
    render(() => <RemoteImageSearch initialRef="ghcr.io/o/app" route={{ kind: "server" }} onSelect={vi.fn()} />);
    await tick();
    expect(describeTagMock).toHaveBeenCalledTimes(4);
    expect(describeTagMock.mock.calls[0].slice(0, 2)).toEqual(["ghcr.io/o/app:latest", { kind: "server", proxyUrl: "", registryIds: [] }]);
    expect(screen.getAllByLabelText("读取镜像信息")).toHaveLength(7);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(describeTagMock).toHaveBeenCalledTimes(7);
    expect(screen.queryByLabelText("读取镜像信息")).toBeNull();
    expect(screen.getByText("Home automation")).toBeTruthy();
    expect(screen.getByRole("link", { name: "源码 ↗" }).getAttribute("href")).toBe("https://github.com/o/app");
    expect(screen.getByText("许可证 Apache-2.0")).toBeTruthy();
    expect(screen.getByText("31.0 MB")).toBeTruthy();
    expect(screen.getByText("2h 前")).toBeTruthy();
    // Filtering reuses what is already known.
    fireEvent.input(screen.getByLabelText("过滤标签"), { target: { value: "v1" } });
    await tick();
    expect(describeTagMock).toHaveBeenCalledTimes(7);

    cleanup();
    describeTagMock.mockClear();
    tags.mockResolvedValue(page("nginx", ["latest"], { hub: true }));
    render(() => <RemoteImageSearch initialRef="nginx:latest" route={{ kind: "server" }} onSelect={vi.fn()} />);
    await tick();
    tags.mockResolvedValue({ ...page("nginx", ["latest"]), notice: "限额" });
    expect(describeTagMock).not.toHaveBeenCalled();
  });

  it("cancels detail reads when the repository changes", async () => {
    tags.mockResolvedValueOnce(page("ghcr.io/o/app", ["v1"])).mockResolvedValueOnce(page("ghcr.io/o/other", ["v2"]));
    describeTagMock.mockImplementation(() => new Promise(() => {}));
    render(() => <RemoteImageSearch initialRef="ghcr.io/o/app" route={{ kind: "server" }} onSelect={vi.fn()} />);
    await tick();
    const first = describeTagMock.mock.calls[0][2] as AbortSignal;
    fireEvent.input(input(), { target: { value: "ghcr.io/o/other" } });
    expect(first.aborted).toBe(true);
    await tick();
    expect(describeTagMock.mock.calls[1][0]).toBe("ghcr.io/o/other:v2");
  });
});
