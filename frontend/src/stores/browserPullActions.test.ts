import { describe, expect, it, vi } from "vitest";
import { runBrowserCreate, runBrowserUpgrade, type BrowserPullCallbacks } from "./browserPull";

const callbacks = (): BrowserPullCallbacks => ({
  note: vi.fn(),
  progress: vi.fn(),
  signal: new AbortController().signal,
});

describe("browser preload actions", () => {
  it("creates only after browser preload and forces pull_policy=never", async () => {
    const runBrowserPull = vi.fn(async () => {});
    const streamPost = vi.fn(async () => {});
    await runBrowserCreate({
      ref: "nginx:latest",
      platform: "linux/amd64",
      workerUrl: "https://worker",
      token: "token",
      body: { image: "nginx:latest", name: "web" },
    }, callbacks(), { runBrowserPull, streamPost });
    expect(runBrowserPull).toHaveBeenCalledOnce();
    expect(streamPost).toHaveBeenCalledWith("/api/containers", expect.objectContaining({
      body: { image: "nginx:latest", name: "web", pull_policy: "never" },
    }));
  });

  it("does not create when browser preload fails", async () => {
    const streamPost = vi.fn(async () => {});
    await expect(runBrowserCreate({
      ref: "nginx:latest", platform: "linux/amd64", workerUrl: "https://worker", token: "token", body: { image: "nginx:latest" },
    }, callbacks(), {
      runBrowserPull: vi.fn(async () => { throw new Error("registry failed"); }),
      streamPost,
    })).rejects.toThrow("registry failed");
    expect(streamPost).not.toHaveBeenCalled();
  });

  it("uses the stable upgrade tag and original platform before local upgrade", async () => {
    const runBrowserPull = vi.fn(async () => {});
    const streamPost = vi.fn(async () => {});
    await runBrowserUpgrade({ id: "abc", workerUrl: "https://worker", token: "token" }, callbacks(), {
      inspectContainer: vi.fn(async () => ({
        Image: "sha256:old",
        Config: { Image: "stale:tag", Labels: { "io.phyless.upgrade-image-ref": "example/app:stable" } },
      })),
      inspectImage: vi.fn(async () => ({ Os: "linux", Architecture: "arm64", Variant: "v8" })),
      runBrowserPull,
      streamPost,
    });
    expect(runBrowserPull).toHaveBeenCalledWith(expect.objectContaining({ ref: "example/app:stable", platform: "linux/arm64/v8" }), expect.anything());
    expect(streamPost).toHaveBeenCalledWith("/api/containers/abc/upgrade", expect.objectContaining({ body: { pull_policy: "never" } }));
  });

  it("does not call upgrade when browser preload fails", async () => {
    const streamPost = vi.fn(async () => {});
    await expect(runBrowserUpgrade({ id: "abc", workerUrl: "https://worker", token: "token" }, callbacks(), {
      inspectContainer: vi.fn(async () => ({ Image: "sha256:old", Config: { Image: "example/app:stable" } })),
      inspectImage: vi.fn(async () => ({ Os: "linux", Architecture: "amd64" })),
      runBrowserPull: vi.fn(async () => { throw new Error("browser pull failed"); }),
      streamPost,
    })).rejects.toThrow("browser pull failed");
    expect(streamPost).not.toHaveBeenCalled();
  });
});
