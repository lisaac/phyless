import { afterEach, describe, expect, it, vi } from "vitest";
import { parseImageRef, parseWWWAuthenticate, layerBlobUrl, registryResponseError, resolveImage } from "./registryPull";

afterEach(() => vi.restoreAllMocks());

describe("parseImageRef", () => {
  it("normalizes Docker Hub official images", () => {
    expect(parseImageRef("nginx:1.27")).toMatchObject({
      registryHost: "registry-1.docker.io",
      repository: "library/nginx",
      tag: "1.27",
      displayRef: "nginx:1.27",
    });
  });
  it("defaults the tag to latest", () => {
    expect(parseImageRef("nginx").tag).toBe("latest");
  });
  it("keeps user repos and other registries", () => {
    expect(parseImageRef("bitnami/redis:7")).toMatchObject({ repository: "bitnami/redis", displayRef: "bitnami/redis:7" });
    expect(parseImageRef("ghcr.io/owner/app:v2")).toMatchObject({
      registryHost: "ghcr.io",
      repository: "owner/app",
      tag: "v2",
      displayRef: "ghcr.io/owner/app:v2",
    });
  });
  it("rejects digest references", () => {
    expect(() => parseImageRef("nginx@sha256:abc")).toThrow(/digest/);
  });
});

describe("parseWWWAuthenticate", () => {
  it("extracts scheme, realm, service and scope", () => {
    const c = parseWWWAuthenticate('Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"');
    expect(c).toEqual({ scheme: "bearer", realm: "https://auth.docker.io/token", service: "registry.docker.io", scope: "repository:library/nginx:pull" });
  });
  it("recognizes basic auth", () => {
    expect(parseWWWAuthenticate('Basic realm="registry"').scheme).toBe("basic");
  });
});

describe("layerBlobUrl", () => {
  it("wraps the registry blob URL in the worker proxy", () => {
    const u = layerBlobUrl("https://w.example/", "ghcr.io", "o/a", "sha256:abc");
    expect(u).toBe("https://w.example?url=" + encodeURIComponent("https://ghcr.io/v2/o/a/blobs/sha256:abc"));
  });
});

describe("registry response errors", () => {
  it("keeps rate-limit and not-found details actionable", async () => {
    const limited = await registryResponseError(new Response(JSON.stringify({ errors: [{ message: "too many requests" }] }), {
      status: 429, headers: { "Retry-After": "30" },
    }), "镜像仓库请求");
    const missing = await registryResponseError(new Response(JSON.stringify({ error: "manifest unknown" }), { status: 404 }), "镜像仓库请求");

    expect(limited.message).toContain("429");
    expect(limited.message).toContain("30 秒后重试");
    expect(limited.message).toContain("too many requests");
    expect(missing.message).toContain("镜像、标签或镜像层不存在（404）");
    expect(missing.message).toContain("manifest unknown");
  });
});

// --- resolveImage against a mock registry through the worker proxy ---

function target(reqUrl: string): string {
  return decodeURIComponent(new URL(reqUrl).searchParams.get("url") || "");
}

function json(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function mockRegistry(imageManifest: unknown) {
  return vi.fn(async (reqUrl: string, init?: RequestInit) => {
    const url = target(reqUrl);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (url.includes("/token")) {
      return json({ token: "tok" });
    }
    if ((url.includes("/manifests/") || url.includes("/blobs/")) && !auth) {
      return new Response("", {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"' },
      });
    }
    if (url.endsWith("/manifests/1.27")) {
      return json(
        { mediaType: "application/vnd.oci.image.index.v1+json", manifests: [{ digest: "sha256:img", platform: { os: "linux", architecture: "amd64" } }] },
        { "Docker-Content-Digest": "sha256:idx" },
      );
    }
    if (url.endsWith("/manifests/sha256:img")) {
      return json(imageManifest, { "Docker-Content-Digest": "sha256:img" });
    }
    if (url.endsWith("/blobs/sha256:cfg")) {
      return json({ os: "linux", architecture: "amd64" });
    }
    return new Response("not found", { status: 404 });
  });
}

const goodManifest = {
  mediaType: "application/vnd.docker.distribution.manifest.v2+json",
  config: { digest: "sha256:cfg", size: 42, mediaType: "application/vnd.docker.container.image.v1+json" },
  layers: [
    { digest: "sha256:l1", size: 100, mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip" },
    { digest: "sha256:l2", size: 200, mediaType: "application/vnd.oci.image.layer.v1.tar+zstd" },
  ],
};

describe("resolveImage", () => {
  it("resolves config, layers and auth via token dance", async () => {
    vi.stubGlobal("fetch", mockRegistry(goodManifest));
    const img = await resolveImage("nginx:1.27", "linux/amd64", "https://w.example");
    expect(img.repoTag).toBe("nginx:1.27");
    expect(img.registryHost).toBe("registry-1.docker.io");
    expect(img.repository).toBe("library/nginx");
    expect(img.config.hex).toBe("cfg");
    expect(img.layers.map((l) => l.hex)).toEqual(["l1", "l2"]);
    expect(img.layers[1].mediaType).toContain("zstd"); // zstd passes through
    expect(img.manifest.digest).toMatch(/^sha256:[0-9a-f]{64}$/); // computed from bytes, not the header
    expect(img.authHeader).toBe("Bearer tok");
  });

  it("rejects foreign layers", async () => {
    vi.stubGlobal(
      "fetch",
      mockRegistry({
        ...goodManifest,
        layers: [{ digest: "sha256:f", size: 1, mediaType: "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip" }],
      }),
    );
    await expect(resolveImage("nginx:1.27", "linux/amd64", "https://w.example")).rejects.toThrow(/不支持的镜像层/);
  });

  it("rejects a platform the index does not contain", async () => {
    vi.stubGlobal("fetch", mockRegistry(goodManifest));
    await expect(resolveImage("nginx:1.27", "linux/arm64", "https://w.example")).rejects.toThrow(/目标平台/);
  });

  it("aborts registry metadata fetches with the task signal", async () => {
    const aborted = new Error("aborted");
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(aborted), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const pending = resolveImage("nginx:1.27", "linux/amd64", "https://w.example", undefined, controller.signal);
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal;
    controller.abort();

    expect(signal?.aborted).toBe(true);
    await expect(pending).rejects.toBe(aborted);
  });
});
