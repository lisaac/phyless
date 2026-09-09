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

  it("resolves on a clean stream and forwards progress lines", async () => {
    const onProgress = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ stream: "ok" }) + "\n", { status: 200 })));
    await expect(streamCompose("up", "1", { body: { pull_policy: "never" }, token: "t", onProgress, signal: sig() })).resolves.toBeUndefined();
    expect(onProgress).toHaveBeenCalled();
  });
});
