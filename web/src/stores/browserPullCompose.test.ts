import { describe, expect, it, vi } from "vitest";
import { runBrowserPullCompose, type BrowserPullComposeDeps, type ComposePullPlan } from "./browserPull";

function deps(plan: ComposePullPlan, over: Partial<BrowserPullComposeDeps> = {}): BrowserPullComposeDeps {
  return {
    fetchPlan: vi.fn(async () => plan),
    runBrowserPull: vi.fn(async () => {}),
    composeUp: vi.fn(async () => {}),
    ...over,
  };
}

const cb = () => ({ note: vi.fn(), progress: vi.fn(), signal: new AbortController().signal });

describe("runBrowserPullCompose", () => {
  it("aborts before pulling when the plan has rejected services", async () => {
    const d = deps({ images: [{ service: "web", ref: "nginx:1" }], rejected: [{ service: "builder", ref: "", reason: "build" }] });
    await expect(runBrowserPullCompose({ id: "1", mode: "up", workerUrl: "https://w", token: "t" }, cb(), d)).rejects.toThrow(/无法用浏览器下载/);
    expect(d.runBrowserPull).not.toHaveBeenCalled();
    expect(d.composeUp).not.toHaveBeenCalled();
  });

  it("preloads every image then runs up with pull_policy=never", async () => {
    const d = deps({
      images: [
        { service: "web", ref: "nginx:1", platform: "linux/amd64" },
        { service: "cache", ref: "redis:7" },
      ],
      rejected: [],
    });
    await runBrowserPullCompose({ id: "1", mode: "up", workerUrl: "https://w", token: "tok" }, cb(), d);
    expect(d.runBrowserPull).toHaveBeenCalledTimes(2);
    expect((d.runBrowserPull as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ ref: "nginx:1", platform: "linux/amd64", workerUrl: "https://w", token: "tok" });
    expect(d.composeUp).toHaveBeenCalledOnce();
    expect((d.composeUp as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("1");
  });

  it("only preloads for mode=pull (no up)", async () => {
    const d = deps({ images: [{ service: "web", ref: "nginx:1" }], rejected: [] });
    await runBrowserPullCompose({ id: "1", mode: "pull", workerUrl: "https://w", token: "t" }, cb(), d);
    expect(d.runBrowserPull).toHaveBeenCalledOnce();
    expect(d.composeUp).not.toHaveBeenCalled();
  });
});
