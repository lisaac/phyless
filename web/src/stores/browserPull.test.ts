import { describe, expect, it, vi } from "vitest";
import { runBrowserPull, type BrowserPullDeps } from "./browserPull";
import type { ResolvedImage } from "../api/registryPull";

const img: ResolvedImage = {
  repoTag: "nginx:1.27",
  registryHost: "registry-1.docker.io",
  repository: "library/nginx",
  config: { hex: "cfg", size: 3, bytes: new Uint8Array([1, 2, 3]) },
  layers: [{ hex: "l1", digest: "sha256:l1", size: 5, mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip" }],
  manifest: { mediaType: "m", digest: "sha256:img", size: 2, bytes: new Uint8Array([9, 9]) },
  platform: { os: "linux", architecture: "amd64" },
  authHeader: "Bearer tok",
};

function makeDeps(over: Partial<BrowserPullDeps> = {}): BrowserPullDeps {
  return {
    resolveImage: vi.fn(async () => img),
    buildDockerLoadTar: vi.fn(() => new ReadableStream()),
    streamTarToDaemon: vi.fn(async () => {}),
    inspectLocalId: vi.fn(async () => null),
    openLayer: vi.fn(async () => new ReadableStream()),
    ...over,
  };
}

const cb = () => ({ note: vi.fn(), progress: vi.fn(), signal: new AbortController().signal });

describe("runBrowserPull", () => {
  it("resolves, builds the tar and streams it", async () => {
    const deps = makeDeps();
    await runBrowserPull({ ref: "nginx:1.27", platform: "linux/amd64", workerUrl: "https://w", token: "t" }, cb(), deps);
    expect(deps.resolveImage).toHaveBeenCalledWith("nginx:1.27", "linux/amd64", "https://w", undefined);
    expect(deps.buildDockerLoadTar).toHaveBeenCalledOnce();
    expect(deps.streamTarToDaemon).toHaveBeenCalledOnce();
  });

  it("skips the download when the image is already up to date", async () => {
    const deps = makeDeps({ inspectLocalId: vi.fn(async () => "sha256:cfg") });
    const c = cb();
    await runBrowserPull({ ref: "nginx:1.27", platform: "linux/amd64", workerUrl: "https://w", token: "t" }, c, deps);
    expect(deps.streamTarToDaemon).not.toHaveBeenCalled();
    expect(c.note).toHaveBeenCalledWith(expect.stringContaining("已是最新"));
  });

  it("still pulls when the local id differs", async () => {
    const deps = makeDeps({ inspectLocalId: vi.fn(async () => "sha256:different") });
    await runBrowserPull({ ref: "nginx:1.27", platform: "linux/amd64", workerUrl: "https://w", token: "t" }, cb(), deps);
    expect(deps.streamTarToDaemon).toHaveBeenCalledOnce();
  });

  it("propagates a streaming failure", async () => {
    const deps = makeDeps({ streamTarToDaemon: vi.fn(async () => { throw new Error("镜像导入失败"); }) });
    await expect(
      runBrowserPull({ ref: "nginx:1.27", platform: "linux/amd64", workerUrl: "https://w", token: "t" }, cb(), deps),
    ).rejects.toThrow(/镜像导入失败/);
  });
});
