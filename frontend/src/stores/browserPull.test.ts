import { describe, expect, it, vi, afterEach } from "vitest";
import { streamCompose } from "./browserPull";

afterEach(() => vi.unstubAllGlobals());

const sig = () => new AbortController().signal;

describe("streamCompose", () => {
  it("throws on an error event line", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }) + "\n", { status: 200 })));
    await expect(streamCompose("pull", "1", { token: "t", signal: sig() })).rejects.toThrow(/boom/);
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(streamCompose("down", "1", { token: "t", signal: sig() })).rejects.toThrow(/失败（500）/);
  });

  it("keeps a JSON error body in the task failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "项目不存在" }), { status: 404 })));
    await expect(streamCompose("down", "1", { token: "t", signal: sig() })).rejects.toThrow(/请求目标不存在（404）：项目不存在/);
  });

  it("resolves on a clean stream and forwards progress lines", async () => {
    const onProgress = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ stream: "ok" }) + "\n", { status: 200 })));
    await expect(streamCompose("up", "1", { body: { pull_policy: "never" }, token: "t", onProgress, signal: sig() })).resolves.toBeUndefined();
    expect(onProgress).toHaveBeenCalledWith("ok");
  });
});

it("rejects an oversized complete progress line, including its newline", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ stream: "x".repeat(256 * 1024) }) + "\n")));
  await expect(streamCompose("build", "1", { token: "t", signal: sig() })).rejects.toThrow("进度行过大");
});

it("hands each image only its own registry's credentials", async () => {
  const { runBrowserPull } = await import("./browserPull");
  const creds = { "ghcr.io": { username: "gh", secret: "g" } };
  const resolveImage = vi.fn().mockRejectedValue(new Error("stop"));
  const deps = { resolveImage, daemonPlatform: async () => "linux/amd64" } as never;
  const cb = { note: vi.fn(), signal: sig() };
  await expect(runBrowserPull({ ref: "nginx:latest", platform: "", workerUrl: "https://w", token: "t", creds }, cb, deps)).rejects.toThrow("stop");
  await expect(runBrowserPull({ ref: "ghcr.io/o/app:v1", platform: "", workerUrl: "https://w", token: "t", creds }, cb, deps)).rejects.toThrow("stop");
  expect(resolveImage.mock.calls[0][3]).toBeUndefined();
  expect(resolveImage.mock.calls[1][3]).toBe(creds["ghcr.io"]);
});

it("pulls for the daemon's exact platform (with ARM variant) and refuses to guess", async () => {
  const { defaultDeps } = await import("./browserPull");
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ os: "linux", architecture: "arm", variant: "v7" }), { headers: { "Content-Type": "application/json" } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ os: "linux", architecture: "arm64", variant: "" }), { headers: { "Content-Type": "application/json" } }))
    .mockResolvedValueOnce(new Response("down", { status: 503 }));
  vi.stubGlobal("fetch", fetch);
  expect(await defaultDeps.daemonPlatform(sig())).toBe("linux/arm/v7");
  expect(await defaultDeps.daemonPlatform(sig())).toBe("linux/arm64");
  await expect(defaultDeps.daemonPlatform(sig())).rejects.toThrow(/手动指定/);
});

it("pulls a chosen platform exactly and lets only the daemon's own fall back", async () => {
  const { runBrowserPull } = await import("./browserPull");
  const resolveImage = vi.fn().mockRejectedValue(new Error("stop"));
  const deps = { resolveImage, daemonPlatform: async () => "linux/arm/v7" } as never;
  const cb = { note: vi.fn(), signal: sig() };
  await expect(runBrowserPull({ ref: "nginx", platform: " linux/arm64 ", workerUrl: "https://w", token: "t" }, cb, deps)).rejects.toThrow("stop");
  await expect(runBrowserPull({ ref: "nginx", platform: "", workerUrl: "https://w", token: "t" }, cb, deps)).rejects.toThrow("stop");
  expect(resolveImage.mock.calls.map((c) => [c[1], c[5]])).toEqual([["linux/arm64", true], ["linux/arm/v7", false]]);
});
