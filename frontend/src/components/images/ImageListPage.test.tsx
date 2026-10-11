import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { ImageListPage } from "./ImageListPage";

const { get, enqueue, search, tags } = vi.hoisted(() => ({ get: vi.fn().mockResolvedValue([]), enqueue: vi.fn(), search: vi.fn(), tags: vi.fn() }));
vi.mock("../../api/registrySearch", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api/registrySearch")>(), searchRepositories: search, listRegistryTags: tags,
  describeTag: async () => ({ platforms: [], labels: {} }),
}));
vi.mock("@solidjs/router", () => ({ A: (props: { children: unknown }) => props.children }));
vi.mock("../../api/client", () => ({ get, getToken: () => "token" }));
vi.mock("../../stores/auth", () => ({ hasRole: () => true }));
vi.mock("../../stores/taskQueue", () => ({ enqueue, queued: vi.fn(), isPending: () => false, SETTLED_EVENT: "settled" }));
vi.mock("../../stores/resource", () => ({ createResourceStore: () => ({
  items: () => [{ Id: "sha256:abc", RepoTags: ["example/app:v2"], RepoDigests: [], Size: 123, Created: 1, UsedBy: [] }],
  loading: () => false, error: () => "", startPolling: vi.fn(), stopPolling: vi.fn(), refresh: vi.fn(),
}) }));

beforeEach(() => { vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); localStorage.clear(); });

describe("ImageListPage 升级按钮", () => {
  it("预填镜像 tag，展示拉取选项，并提交该 tag", async () => {
    render(() => <ImageListPage />);
    fireEvent.click(screen.getByTitle("升级：重新拉取该镜像标签"));
    expect(screen.getByRole("heading", { name: "拉取镜像" })).toBeTruthy();
    expect((screen.getByPlaceholderText("nginx:latest") as HTMLInputElement).value).toBe("example/app:v2");
    expect(await screen.findByText("服务端代理")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "拉取" }));
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      url: "/api/images/pull", body: expect.objectContaining({ image: "example/app:v2" }),
    }));
  });
});

describe("ImageListPage 远程搜索", () => {
  it.each(["不使用代理", "服务端代理", "浏览器代理导入"])("选择标签只回填，保留%s的拉取方式", async (mode) => {
    vi.useFakeTimers();
    localStorage.setItem("phyless_pull_worker_url", "https://worker.example");
    search.mockResolvedValue({ items: [{ name: "nginx", description: "Official image", official: true, stars: 1, pulls: 1 }], hasMore: false, total: 1 });
    tags.mockResolvedValue({ repository: "nginx", tags: [{ name: "1.27", platforms: [] }], next: "", hub: true });
    render(() => <ImageListPage />);
    expect(search).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "+ 拉取" }));
    fireEvent.click(screen.getByLabelText(mode));
    if (mode === "服务端代理") {
      fireEvent.input(screen.getByPlaceholderText("http://host.docker.internal:7890"), { target: { value: "http://proxy.example:8080" } });
    }
    expect(screen.queryByLabelText("搜索关键词 / 完整仓库名")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /搜索远程镜像/ }));
    expect(!!screen.queryByPlaceholderText("https://your-worker.workers.dev")).toBe(mode === "浏览器代理导入");
    fireEvent.input(screen.getByLabelText("搜索关键词 / 完整仓库名"), { target: { value: "nginx" } });
    await vi.advanceTimersByTimeAsync(300);
    // Search follows the pull mode: Worker only for browser import, else the server (with its proxy).
    expect(search.mock.calls[0][1]).toEqual(mode === "浏览器代理导入"
      ? { kind: "worker", workerUrl: "https://worker.example", creds: undefined }
      : { kind: "server", proxyUrl: mode === "服务端代理" ? "http://proxy.example:8080" : "" });
    fireEvent.click(screen.getByRole("button", { name: /^nginx/ }));
    await vi.advanceTimersByTimeAsync(300);
    fireEvent.click(screen.getByRole("button", { name: /^1\.27/ }));
    expect(enqueue).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText("nginx:latest") as HTMLInputElement).value).toBe("nginx:1.27");
    expect((screen.getByLabelText(mode) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "拉取" }));
    if (mode === "浏览器代理导入") {
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ url: "", meta: expect.objectContaining({ type: "browser-pull", ref: "nginx:1.27", workerUrl: "https://worker.example" }) }));
    } else {
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ url: "/api/images/pull", body: mode === "服务端代理" ? { image: "nginx:1.27", proxy_url: "http://proxy.example:8080" } : { image: "nginx:1.27" } }));
    }
  });

  it("标签行直接拉取，并标出本地已有的标签", async () => {
    vi.useFakeTimers();
    localStorage.setItem("phyless_pull_worker_url", "https://worker.example");
    tags.mockResolvedValue({ repository: "example/app", tags: [{ name: "v2", platforms: [] }, { name: "v3", platforms: [] }], next: "", hub: true });
    render(() => <ImageListPage />);
    fireEvent.click(screen.getByTitle("升级：重新拉取该镜像标签"));
    fireEvent.click(screen.getByRole("button", { name: /搜索远程镜像/ }));
    await vi.advanceTimersByTimeAsync(300);
    expect(tags.mock.calls[0][0]).toBe("example/app:v2");
    expect(screen.getAllByText("本地已有")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "拉取 example/app:v3" }));
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ body: { image: "example/app:v3" } }));
    expect(screen.queryByRole("heading", { name: "拉取镜像" })).toBeNull();
  });

  it("默认小窗，点击搜索切换大窗，收起后回到小窗；添加账号入口打开账号表单", async () => {
    localStorage.setItem("phyless_pull_worker_url", "https://worker.example");
    render(() => <ImageListPage />);
    fireEvent.click(screen.getByRole("button", { name: "+ 拉取" }));
    const dialog = () => screen.getByRole("heading", { name: "拉取镜像" }).closest("div")!.parentElement!;
    expect(dialog().className).toContain("sm:max-w-md");
    fireEvent.input(screen.getByLabelText("镜像引用"), { target: { value: "redis:7" } });
    fireEvent.click(screen.getByRole("button", { name: /搜索远程镜像/ }));
    expect(dialog().className).toContain("sm:max-w-6xl");
    expect((screen.getByLabelText("搜索关键词 / 完整仓库名") as HTMLInputElement).value).toBe("redis:7");
    expect(screen.queryByRole("button", { name: "添加 Docker Hub 账号" })).toBeNull();
    fireEvent.click(screen.getByLabelText("浏览器代理导入"));
    fireEvent.click(screen.getByRole("button", { name: "添加 Docker Hub 账号" }));
    expect((screen.getByLabelText("Registry 地址") as HTMLInputElement).value).toBe("docker.io");
    fireEvent.click(screen.getByRole("button", { name: "收起搜索" }));
    expect(dialog().className).toContain("sm:max-w-md");
    expect((screen.getByLabelText("镜像引用") as HTMLInputElement).value).toBe("redis:7");
  });

  it("搜索失败仍可手动拉取，关闭弹窗取消请求", async () => {
    vi.useFakeTimers();
    localStorage.setItem("phyless_pull_worker_url", "https://worker.example");
    search.mockRejectedValueOnce(new Error("Worker 白名单未允许 hub.docker.com"))
      .mockImplementationOnce(() => new Promise(() => {}));
    render(() => <ImageListPage />);
    fireEvent.click(screen.getByRole("button", { name: "+ 拉取" }));
    fireEvent.click(screen.getByRole("button", { name: /搜索远程镜像/ }));
    fireEvent.input(screen.getByLabelText("搜索关键词 / 完整仓库名"), { target: { value: "nginx" } });
    await vi.advanceTimersByTimeAsync(300);
    expect(screen.getByText(/Worker 白名单未允许/)).toBeTruthy();
    fireEvent.input(screen.getByPlaceholderText("nginx:latest"), { target: { value: "manual/app:v2" } });
    fireEvent.click(screen.getByRole("button", { name: "拉取" }));
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ body: { image: "manual/app:v2" } }));
    fireEvent.click(screen.getByRole("button", { name: "+ 拉取" }));
    expect(screen.queryByLabelText("搜索关键词 / 完整仓库名")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /搜索远程镜像/ }));
    fireEvent.input(screen.getByLabelText("搜索关键词 / 完整仓库名"), { target: { value: "nginx" } });
    await vi.advanceTimersByTimeAsync(300);
    const requestSignal = search.mock.calls[1][2] as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(requestSignal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(20000);
    expect(search).toHaveBeenCalledTimes(2);
  });
});
