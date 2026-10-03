import { afterEach, describe, expect, it, vi } from "vitest";
import { listRegistryTags, searchRepositories } from "./registrySearch";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const signal = () => new AbortController().signal;
const json = (data: unknown) => new Response(JSON.stringify(data));
const upstream = (url: string) => new URL(new URL(url).searchParams.get("url")!);

describe("registry search", () => {
  it("requests one bounded Hub page, normalizes results, and never sends credentials", async () => {
    const fetch = vi.fn().mockResolvedValue(json({
      next: "https://untrusted.example/page", // Only used as a boolean, never followed.
      results: [{ repo_name: "nginx", short_description: "Official image", is_official: true },
        { repo_name: "../../escape" }, ...Array.from({ length: 20 }, (_, i) => ({ repo_name: `owner/app${i}` }))],
    }));
    vi.stubGlobal("fetch", fetch);
    const requestSignal = signal();
    const result = await searchRepositories(" nginx ", "https://worker.example", requestSignal, 2);
    const [url, init] = fetch.mock.calls[0];
    expect(upstream(url).host).toBe("hub.docker.com");
    expect(upstream(url).searchParams.get("query")).toBe("nginx");
    expect(upstream(url).searchParams.get("page_size")).toBe("10");
    expect(upstream(url).searchParams.get("page")).toBe("2");
    expect(init.signal).toBe(requestSignal);
    expect(init.headers).toEqual({ Accept: "application/json" });
    expect(result.items[0]).toEqual({ name: "nginx", description: "Official image", official: true });
    expect(result.items).toHaveLength(9);
    expect(result.hasMore).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid queries before requesting, invalid data, and oversized streaming bodies", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(searchRepositories("a", "https://worker.example", signal())).rejects.toThrow(/2–128/);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(json({ results: null }));
    await expect(searchRepositories("nginx", "https://worker.example", signal())).rejects.toThrow(/无效/);
    let cancelled = false;
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); },
      cancel() { cancelled = true; },
    })));
    await expect(searchRepositories("nginx", "https://worker.example", signal())).rejects.toThrow(/响应过大/);
    expect(cancelled).toBe(true);
  });

  it("preserves rate-limit details without automatic retries", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("Too many requests", { status: 429, headers: { "Retry-After": "30" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(searchRepositories("nginx", "https://worker.example", signal())).rejects.toThrow(/429.*30 秒/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("registry tags", () => {
  it.each([
    ["Registry.Example:443", "registry.example"],
    ["registry.example:00443", "registry.example"],
    ["registry.example:05000", "registry.example:5000"],
    ["[2001:0db8::1]:443", "[2001:db8::1]"],
  ])("accepts and normalizes the valid registry host %s", async (host, expected) => {
    const fetch = vi.fn().mockResolvedValue(json({ tags: ["latest"] }));
    vi.stubGlobal("fetch", fetch);
    const result = await listRegistryTags(`${host}/owner/app`, "https://worker.example", undefined, signal());
    expect(upstream(fetch.mock.calls[0][0]).host).toBe(expected);
    expect(result.repository).toBe(`${host}/owner/app`);
    expect(result.tags).toEqual(["latest"]);
  });

  it("queries V2 names through the Worker, authenticates using the existing token flow, and normalizes the ref", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 401, headers: {
        "WWW-Authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"',
      } }))
      .mockResolvedValueOnce(json({ token: "test-token" }))
      .mockResolvedValueOnce(json({ name: "library/nginx", tags: ["1.27", "latest", "../escape"] }));
    vi.stubGlobal("fetch", fetch);
    const requestSignal = signal();
    const result = await listRegistryTags("docker.io/nginx:latest", "https://worker.example", undefined, requestSignal);
    expect(upstream(fetch.mock.calls[0][0]).pathname).toBe("/v2/library/nginx/tags/list");
    expect(upstream(fetch.mock.calls[0][0]).searchParams.get("n")).toBe("20");
    expect(upstream(fetch.mock.calls[1][0]).searchParams.get("scope")).toBe("repository:library/nginx:pull");
    expect(fetch.mock.calls[2][1].headers.Authorization).toBe("Bearer test-token");
    expect(fetch.mock.calls.every(([, init]) => init.signal === requestSignal)).toBe(true);
    expect(result).toEqual({ repository: "nginx", tags: ["1.27", "latest"], next: "latest" });
  });

  it("supports private-registry Basic auth and one explicit cursor page", async () => {
    const names = Array.from({ length: 25 }, (_, i) => `v${String(i + 1).padStart(2, "0")}`);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="registry"' } }))
      .mockResolvedValueOnce(json({ tags: names }));
    vi.stubGlobal("fetch", fetch);
    const result = await listRegistryTags("registry.example:5000/owner/app", "https://worker.example", { username: "user", secret: "secret" }, signal(), "v00");
    const url = upstream(fetch.mock.calls[0][0]);
    expect(url.host).toBe("registry.example:5000");
    expect(url.searchParams.get("last")).toBe("v00");
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe(`Basic ${btoa("user:secret")}`);
    expect(result.repository).toBe("registry.example:5000/owner/app");
    expect(result.tags).toHaveLength(20);
    expect(result.next).toBe("v20");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("treats null tags as empty, rejects unsafe refs, and stops at an exhausted cursor", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ tags: null })).mockResolvedValueOnce(json({ tags: ["v1", "v2"] }));
    vi.stubGlobal("fetch", fetch);
    expect((await listRegistryTags("ghcr.io/o/app", "https://worker.example", undefined, signal())).tags).toEqual([]);
    expect((await listRegistryTags("ghcr.io/o/app", "https://worker.example", undefined, signal(), "v2")).next).toBe("");
    await expect(listRegistryTags("registry.example/../app", "https://worker.example", undefined, signal())).rejects.toThrow(/有效/);
    await expect(listRegistryTags("user@registry.example/app", "https://worker.example", undefined, signal())).rejects.toThrow();
    await expect(listRegistryTags("registry.example\\/app", "https://worker.example", undefined, signal())).rejects.toThrow(/有效/);
    await expect(listRegistryTags("registry.example:/app", "https://worker.example", undefined, signal())).rejects.toThrow(/有效/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("continues after a server-capped short page without prefetching or accumulating tags", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ tags: ["v1", "v2"] }))
      .mockResolvedValueOnce(json({ tags: ["v3"] })).mockResolvedValueOnce(json({ tags: [] }));
    vi.stubGlobal("fetch", fetch);
    const first = await listRegistryTags("registry.example/app", "https://worker.example", undefined, signal());
    expect(first.next).toBe("v2");
    expect(fetch).toHaveBeenCalledTimes(1);
    const second = await listRegistryTags("registry.example/app", "https://worker.example", undefined, signal(), first.next);
    expect(second.tags).toEqual(["v3"]);
    expect(second.next).toBe("v3");
    expect(upstream(fetch.mock.calls[1][0]).searchParams.get("last")).toBe("v2");
    const end = await listRegistryTags("registry.example/app", "https://worker.example", undefined, signal(), second.next);
    expect(end.next).toBe("");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
