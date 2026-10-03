import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { RemoteImageSearch } from "./RemoteImageSearch";

const { search, tags } = vi.hoisted(() => ({ search: vi.fn(), tags: vi.fn() }));
vi.mock("../../api/registrySearch", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api/registrySearch")>(), searchRepositories: search, listRegistryTags: tags,
}));

beforeEach(() => {
  vi.useFakeTimers();
  search.mockReset().mockResolvedValue({ items: [], hasMore: false });
  tags.mockReset().mockResolvedValue({ repository: "nginx", tags: [], next: "" });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const tick = () => vi.advanceTimersByTimeAsync(300);
const input = () => screen.getByLabelText("搜索关键词 / 完整仓库名");

describe("remote image search", () => {
  it("accepts complete repository references longer than the Hub keyword limit", async () => {
    const ref = `registry.example/team/${"a".repeat(140)}`;
    tags.mockResolvedValue({ repository: ref, tags: ["latest"], next: "" });
    const select = vi.fn();
    render(() => <RemoteImageSearch initialRef={ref} workerUrl="https://worker.example" onSelect={select} />);
    expect((input() as HTMLInputElement).maxLength).toBeGreaterThanOrEqual(ref.length);
    await tick();
    expect(tags).toHaveBeenCalledWith(ref, "https://worker.example", undefined, expect.any(AbortSignal), "");
    expect(search).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "latest" }));
    expect(select).toHaveBeenCalledWith(`${ref}:latest`);
  });

  it("keeps the Hub keyword limit when allowing longer repository references", async () => {
    render(() => <RemoteImageSearch initialRef="" workerUrl="https://worker.example" onSelect={vi.fn()} />);
    fireEvent.input(input(), { target: { value: "a".repeat(129) } });
    await tick();
    expect(screen.getByText("搜索内容不能超过 128 个字符")).toBeTruthy();
    expect(search).not.toHaveBeenCalled();
    expect(tags).not.toHaveBeenCalled();
  });

  it("restarts tag pagination and cancels work when browser credentials change", async () => {
    const [creds, setCreds] = createSignal({ username: "user", secret: "old-secret" });
    tags.mockResolvedValue({ repository: "registry.example/app", tags: ["v1"], next: "v1" });
    render(() => <RemoteImageSearch initialRef="registry.example/app" workerUrl="https://worker.example" creds={creds()} onSelect={vi.fn()} />);
    await tick();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await tick();
    const oldSignal = tags.mock.calls[1][3] as AbortSignal;
    expect(tags.mock.calls[1][4]).toBe("v1");
    setCreds({ username: "user", secret: "new-secret" });
    expect(oldSignal.aborted).toBe(true);
    await tick();
    expect(tags.mock.calls[2][2]).toEqual({ username: "user", secret: "new-secret" });
    expect(tags.mock.calls[2][4]).toBe("");
  });

  it("waits for two characters, debounces rapid input, and skips IME composition", async () => {
    render(() => <RemoteImageSearch initialRef="" workerUrl="https://worker.example" onSelect={vi.fn()} />);
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
      .mockResolvedValueOnce({ items: [{ name: "redis", description: "", official: true }], hasMore: false });
    render(() => <RemoteImageSearch initialRef="nginx" workerUrl="https://worker.example" onSelect={vi.fn()} />);
    await tick();
    const oldSignal = search.mock.calls[0][2] as AbortSignal;
    fireEvent.input(input(), { target: { value: "redis" } });
    expect(oldSignal.aborted).toBe(true);
    await tick();
    complete({ items: [{ name: "stale", description: "", official: false }], hasMore: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByText("stale")).toBeNull();
    expect(screen.getByRole("button", { name: /redis/ })).toBeTruthy();
  });

  it("loads tags only after repository selection, replaces pages, and fills a ref without pulling", async () => {
    const select = vi.fn();
    search.mockResolvedValueOnce({ items: [{ name: "nginx", description: "Nginx image", official: true }], hasMore: false });
    tags.mockResolvedValueOnce({ repository: "nginx", tags: ["1.27"], next: "1.27" })
      .mockResolvedValueOnce({ repository: "nginx", tags: ["latest"], next: "" });
    render(() => <RemoteImageSearch initialRef="nginx" workerUrl="https://worker.example" onSelect={select} />);
    await tick();
    expect(tags).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /nginx · 官方/ }));
    await tick();
    expect(tags).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await tick();
    expect(tags.mock.calls[1][4]).toBe("1.27");
    expect(screen.queryByRole("button", { name: "1.27" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "latest" }));
    expect(select).toHaveBeenCalledWith("nginx:latest");
  });

  it("paginates Hub only on click and resets pagination for a new query", async () => {
    search.mockResolvedValue({ items: [{ name: "nginx", description: "", official: false }], hasMore: true });
    render(() => <RemoteImageSearch initialRef="nginx" workerUrl="https://worker.example" onSelect={vi.fn()} />);
    await tick();
    await vi.advanceTimersByTimeAsync(2000);
    expect(search).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await tick();
    expect(search.mock.calls[1][3]).toBe(2);
    fireEvent.input(input(), { target: { value: "redis" } });
    await tick();
    expect(search.mock.calls[2][3]).toBe(1);
  });

  it("keeps requests disabled without a valid Worker and cancels on configuration change or unmount", async () => {
    const [worker, setWorker] = createSignal("");
    const mounted = render(() => <RemoteImageSearch initialRef="ghcr.io/owner/app" workerUrl={worker()} creds={{ username: "user", secret: "secret" }} onSelect={vi.fn()} />);
    await tick();
    expect(tags).not.toHaveBeenCalled();
    expect(screen.getByText(/填写有效的 HTTPS/)).toBeTruthy();
    setWorker("https://worker.example");
    await tick();
    expect(tags.mock.calls[0][2]).toEqual({ username: "user", secret: "secret" });
    const firstSignal = tags.mock.calls[0][3] as AbortSignal;
    setWorker("https://other-worker.example");
    expect(firstSignal.aborted).toBe(true);
    await tick();
    const secondSignal = tags.mock.calls[1][3] as AbortSignal;
    mounted.unmount();
    expect(secondSignal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(20000);
    expect(tags).toHaveBeenCalledTimes(2);
  });

  it("times out, exposes an explicit retry, and cancels a pending debounce on unmount", async () => {
    search.mockImplementationOnce(() => new Promise(() => {}));
    const mounted = render(() => <RemoteImageSearch initialRef="nginx" workerUrl="https://worker.example" onSelect={vi.fn()} />);
    await tick();
    await vi.advanceTimersByTimeAsync(15000);
    expect(screen.getByText(/搜索超时/)).toBeTruthy();
    expect(search.mock.calls[0][2].aborted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await tick();
    expect(search).toHaveBeenCalledTimes(2);
    fireEvent.input(input(), { target: { value: "redis" } });
    mounted.unmount();
    await tick();
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("shows errors without polling and allows a manual ref to remain outside the search component", async () => {
    search.mockRejectedValue(new Error("镜像仓库请求过于频繁（429）"));
    render(() => <RemoteImageSearch initialRef="nginx" workerUrl="https://worker.example" onSelect={vi.fn()} />);
    await tick();
    expect(screen.getByText(/429/)).toBeTruthy();
    await vi.advanceTimersByTimeAsync(30000);
    expect(search).toHaveBeenCalledTimes(1);
  });
});
