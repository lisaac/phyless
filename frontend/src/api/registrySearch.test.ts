import { afterEach, describe, expect, it, vi } from "vitest";
import { describeTag, hubLogin, listRegistryTags, searchRepositories, sortTagNames, verifyRegistryCreds } from "./registrySearch";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const signal = () => new AbortController().signal;
const W = (creds?: Record<string, { username: string; secret: string }>) => ({ kind: "worker" as const, workerUrl: "https://worker.example", creds });
const json = (data: unknown) => new Response(JSON.stringify(data));
const upstream = (url: string) => new URL(new URL(url).searchParams.get("url")!);

describe("registry search", () => {
  it("requests one bounded Hub page, normalizes results, and never sends credentials", async () => {
    const fetch = vi.fn().mockResolvedValue(json({
      next: "https://untrusted.example/page", // Only used as a boolean, never followed.
      count: 1234,
      results: [{ repo_name: "nginx", short_description: "Official image", is_official: true, star_count: 21000, pull_count: 1e10 },
        { repo_name: "../../escape" }, ...Array.from({ length: 20 }, (_, i) => ({ repo_name: `owner/app${i}`, star_count: -1 }))],
    }));
    vi.stubGlobal("fetch", fetch);
    const requestSignal = signal();
    const result = await searchRepositories(" nginx ", W(), requestSignal, 2);
    const [url, init] = fetch.mock.calls[0];
    expect(upstream(url).host).toBe("hub.docker.com");
    expect(upstream(url).searchParams.get("query")).toBe("nginx");
    expect(upstream(url).searchParams.get("page_size")).toBe("20");
    expect(upstream(url).searchParams.get("page")).toBe("2");
    expect(init.signal).toBe(requestSignal);
    expect(init.headers).toEqual({ Accept: "application/json" });
    expect(result.items[0]).toEqual({ name: "nginx", description: "Official image", official: true, stars: 21000, pulls: 1e10 });
    expect(result.items[1].stars).toBe(0);
    expect(result.items).toHaveLength(19);
    expect(result.total).toBe(1234);
    expect(result.hasMore).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid queries before requesting, invalid data, and oversized streaming bodies", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(searchRepositories("a", W(), signal())).rejects.toThrow(/2–128/);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(json({ results: null }));
    await expect(searchRepositories("nginx", W(), signal())).rejects.toThrow(/无效/);
    let cancelled = false;
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    })));
    await expect(searchRepositories("nginx", W(), signal())).rejects.toThrow(/响应过大/);
    expect(cancelled).toBe(true);
  });

  it("preserves rate-limit details without automatic retries", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("Too many requests", { status: 429, headers: { "Retry-After": "30" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(searchRepositories("nginx", W(), signal())).rejects.toThrow(/搜索镜像过于频繁（429）.*30 秒/);
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
    const fetch = vi.fn().mockImplementation(async () => json({ tags: ["latest"] }));
    vi.stubGlobal("fetch", fetch);
    const result = await listRegistryTags(`${host}/owner/app`, W(), signal());
    expect(upstream(fetch.mock.calls[0][0]).host).toBe(expected);
    expect(result.repository).toBe(`${host}/owner/app`);
    expect(result.tags).toEqual([{ name: "latest", platforms: [] }]);
  });

  it("uses the Hub tag API for Docker Hub: newest first, sizes, platforms and a name filter", async () => {
    const fetch = vi.fn().mockResolvedValue(json({
      count: 106,
      next: "https://hub.docker.com/next",
      results: [
        { name: "1.27.5", last_updated: "2026-10-08T13:52:12Z", full_size: 75775660, digest: `sha256:${"a".repeat(64)}`,
          images: [{ architecture: "amd64", os: "linux" }, { architecture: "arm64", variant: "v8", os: "linux" }, { architecture: "unknown", os: "unknown" }] },
        { name: "../escape" },
      ],
    }));
    vi.stubGlobal("fetch", fetch);
    const requestSignal = signal();
    const result = await listRegistryTags("docker.io/nginx:latest", W(), requestSignal, "2", " 1.27 ");
    const url = upstream(fetch.mock.calls[0][0]);
    expect(url.host).toBe("hub.docker.com");
    expect(url.pathname).toBe("/v2/namespaces/library/repositories/nginx/tags");
    expect(url.searchParams.get("ordering")).toBe("last_updated");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("name")).toBe("1.27");
    expect(fetch.mock.calls[0][1].headers).toEqual({ Accept: "application/json" });
    expect(fetch.mock.calls[0][1].signal).toBe(requestSignal);
    expect(result).toEqual({
      repository: "nginx", next: "3", total: 106, hub: true, auth: {},
      tags: [{ name: "1.27.5", updated: Date.parse("2026-10-08T13:52:12Z") / 1000, size: 75775660, digest: `sha256:${"a".repeat(64)}`, platforms: ["amd64", "arm64/v8"] }],
    });
  });

  it("falls back to the V2 API for a private Hub repository only when credentials exist", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    await expect(listRegistryTags("owner/private", W(), signal())).rejects.toThrow(/404/);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockReset()
      .mockResolvedValueOnce(json({ access_token: "hub-jwt-fallback" }))
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response("", { status: 401, headers: {
        "WWW-Authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:owner/private:pull"',
      } }))
      .mockResolvedValueOnce(json({ token: "test-token" }))
      .mockResolvedValueOnce(json({ tags: ["v1"] }))
      .mockResolvedValueOnce(json({ tags: [] }));
    const result = await listRegistryTags("owner/private", W({ "docker.io": { username: "fallback-user", secret: "s" } }), signal());
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer hub-jwt-fallback");
    expect(upstream(fetch.mock.calls[2][0]).pathname).toBe("/v2/owner/private/tags/list");
    expect(fetch.mock.calls[3][1].headers.Authorization).toBe(`Basic ${btoa("fallback-user:s")}`);
    expect(fetch.mock.calls[4][1].headers.Authorization).toBe("Bearer test-token");
    expect(result).toMatchObject({ repository: "owner/private", hub: false, next: "", tags: [{ name: "v1", platforms: [] }] });
  });

  it("reads every V2 page with Basic auth once, then sorts latest first and versions newest first", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="registry"' } }))
      .mockResolvedValueOnce(json({ tags: ["1.10", "1.9", "../x"] }))
      .mockResolvedValueOnce(json({ tags: ["2.0", "latest"] }))
      .mockResolvedValueOnce(json({ tags: [] }));
    vi.stubGlobal("fetch", fetch);
    const result = await listRegistryTags("registry.example:5000/owner/app", W({ "registry.example:5000": { username: "user", secret: "secret" }, "docker.io": { username: "other", secret: "never-sent" } }), signal());
    expect(upstream(fetch.mock.calls[0][0]).searchParams.get("n")).toBe("1000");
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe(`Basic ${btoa("user:secret")}`);
    expect(fetch.mock.calls[2][1].headers.Authorization).toBe(`Basic ${btoa("user:secret")}`);
    expect(upstream(fetch.mock.calls[2][0]).searchParams.get("last")).toBe("1.9");
    expect(result.tags.map((t) => t.name)).toEqual(["latest", "2.0", "1.10", "1.9"]);
    expect(result).toMatchObject({ next: "", total: 4, hub: false });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("bounds V2 paging, treats null tags as empty and rejects unsafe refs", async () => {
    let n = 0;
    const fetch = vi.fn().mockImplementation(async () => json({ tags: [`v${String(++n).padStart(3, "0")}`] }));
    vi.stubGlobal("fetch", fetch);
    expect((await listRegistryTags("ghcr.io/o/app", W(), signal())).tags).toHaveLength(5);
    expect(fetch).toHaveBeenCalledTimes(5);
    fetch.mockReset().mockResolvedValueOnce(json({ tags: null }));
    expect((await listRegistryTags("ghcr.io/o/app", W(), signal())).tags).toEqual([]);
    await expect(listRegistryTags("registry.example/../app", W(), signal())).rejects.toThrow(/有效/);
    await expect(listRegistryTags("user@registry.example/app", W(), signal())).rejects.toThrow();
    await expect(listRegistryTags("registry.example\\/app", W(), signal())).rejects.toThrow(/有效/);
    await expect(listRegistryTags("registry.example:/app", W(), signal())).rejects.toThrow(/有效/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sorts tag names naturally, newest first", () => {
    expect(sortTagNames(["1.2.0", "alpine", "1.10.0", "latest", "1.9.3-alpine"])).toEqual(["latest", "alpine", "1.10.0", "1.9.3-alpine", "1.2.0"]);
  });
});

describe("Docker Hub account", () => {
  const exp = (seconds: number) => `x.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds }))}.y`;

  it("logs in through the Worker POST once, caches the JWT and searches as the account", async () => {
    const token = exp(3600);
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ access_token: token }))
      .mockImplementation(async () => json({ results: [] }));
    vi.stubGlobal("fetch", fetch);
    const creds = { username: "cache-user", secret: "pat" };
    const first = await searchRepositories("nginx", W({ "docker.io": creds }), signal(), 1);
    await searchRepositories("redis", W({ "docker.io": creds }), signal(), 1);
    const [loginUrl, loginInit] = fetch.mock.calls[0];
    expect(upstream(loginUrl).href).toBe("https://hub.docker.com/v2/auth/token");
    expect(loginInit.method).toBe("POST");
    expect(JSON.parse(loginInit.body)).toEqual({ identifier: "cache-user", secret: "pat" });
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${token}`);
    expect(fetch.mock.calls[2][1].headers.Authorization).toBe(`Bearer ${token}`);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(first.auth).toEqual({ user: "cache-user" });
  });

  it("falls back to anonymous search with a reason when the login fails or the Worker is old", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(json({ results: [] }))
      .mockResolvedValueOnce(new Response("", { status: 405 }))
      .mockResolvedValueOnce(json({ results: [] }));
    vi.stubGlobal("fetch", fetch);
    const bad = await searchRepositories("nginx", W({ "docker.io": { username: "bad-user", secret: "x" } }), signal(), 1);
    expect(bad.auth.error).toMatch(/无效/);
    expect(fetch.mock.calls[1][1].headers.Authorization).toBeUndefined();
    const old = await searchRepositories("nginx", W({ "docker.io": { username: "old-worker-user", secret: "x" } }), signal(), 1);
    expect(old.auth.error).toMatch(/重新部署/);
  });

  it("refreshes an expired JWT", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ access_token: exp(30) })).mockResolvedValueOnce(json({ access_token: exp(3600) }));
    vi.stubGlobal("fetch", fetch);
    const creds = { username: "expiring-user", secret: "pat" };
    await hubLogin("https://worker.example", creds, signal());
    await hubLogin("https://worker.example", creds, signal());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("verifies accounts through the registry token service, never the rate-limited Hub login", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' } }))
      .mockResolvedValueOnce(json({ token: "t" }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(new Response("", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' } }))
      .mockResolvedValueOnce(new Response('{"errors":[{"message":"denied"}]}', { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    await verifyRegistryCreds("https://worker.example", "docker.io", { username: "verify-user", secret: "s" }, signal());
    expect(fetch.mock.calls.map(([url]) => upstream(url).host)).toEqual(["registry-1.docker.io", "auth.docker.io", "registry-1.docker.io"]);
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe(`Basic ${btoa("verify-user:s")}`);
    expect(fetch.mock.calls[2][1].headers.Authorization).toBe("Bearer t");
    await expect(verifyRegistryCreds("https://worker.example", "ghcr.io", { username: "u", secret: "bad" }, signal())).rejects.toThrow(/401/);
    expect(upstream(fetch.mock.calls[3][0]).href).toBe("https://ghcr.io/v2/");
    expect(fetch.mock.calls.some(([url]) => upstream(url).pathname === "/v2/auth/token")).toBe(false);
  });

});

describe("server route", () => {
  const S = { kind: "server" as const, proxyUrl: " http://proxy:7890 ", registryIds: ["reg-1"] };
  const sent = (call: unknown[]) => ({ url: call[0], init: call[1] as RequestInit, body: JSON.parse((call[1] as RequestInit).body as string) });

  it("relays Hub search and tags through phyless with the pull proxy, never the Worker or Hub login", async () => {
    localStorage.setItem("phyless_token", "jwt-phyless");
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ results: [{ repo_name: "nginx" }] }))
      .mockResolvedValueOnce(json({ results: [{ name: "1.27", images: [] }] }));
    vi.stubGlobal("fetch", fetch);
    const search = await searchRepositories("nginx", S, signal());
    const tags = await listRegistryTags("nginx", S, signal(), "", "1.27");
    const first = sent(fetch.mock.calls[0]);
    expect(first.url).toBe("/api/images/remote");
    expect(first.init.method).toBe("POST");
    expect((first.init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-phyless");
    expect(first.body).toEqual({ url: expect.stringMatching(/^https:\/\/hub\.docker\.com\/v2\/search\/repositories\/\?query=nginx/), proxy_url: "http://proxy:7890", registry_ids: ["reg-1"] });
    expect(new URL(sent(fetch.mock.calls[1]).body.url).searchParams.get("name")).toBe("1.27");
    expect(search.items[0].name).toBe("nginx");
    expect(search.auth).toEqual({});
    expect(tags).toMatchObject({ hub: true, tags: [{ name: "1.27" }] });
    localStorage.clear();
  });

  it("lists V2 tags once through the server, which follows pagination itself", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ tags: ["v1", "latest", "v10", "v2"] }));
    vi.stubGlobal("fetch", fetch);
    const result = await listRegistryTags("ghcr.io/o/app:v1", { kind: "server" }, signal());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sent(fetch.mock.calls[0]).body).toEqual({ url: "https://ghcr.io/v2/o/app/tags/list?n=1000" });
    expect(result.tags.map((t) => t.name)).toEqual(["latest", "v10", "v2", "v1"]);
  });

  it("keeps the step and server error in messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"error":"cannot reach Docker Hub"}', { status: 502 })));
    await expect(searchRepositories("nginx", { kind: "server" }, signal())).rejects.toThrow("搜索镜像失败（502）：cannot reach Docker Hub");
  });
});

describe("Hub API rate limit", () => {
  it("falls back to the registry tag list with a notice, on either route", async () => {
    const limited = () => new Response('{"detail":"Rate limit exceeded"}', { status: 429, headers: { "Retry-After": "60" } });
    const fetch = vi.fn()
      .mockResolvedValueOnce(limited())
      .mockResolvedValueOnce(new Response("", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' } }))
      .mockResolvedValueOnce(json({ token: "t" }))
      .mockResolvedValueOnce(json({ tags: ["1.27", "latest"] }))
      .mockResolvedValueOnce(json({ tags: [] }))
      .mockResolvedValueOnce(limited())
      .mockResolvedValueOnce(json({ tags: ["7", "latest"] }));
    vi.stubGlobal("fetch", fetch);
    const viaWorker = await listRegistryTags("nginx", W(), signal());
    expect(upstream(fetch.mock.calls[1][0]).href).toBe("https://registry-1.docker.io/v2/library/nginx/tags/list?n=1000");
    expect(viaWorker).toMatchObject({ hub: false, notice: expect.stringMatching(/限额/), tags: [{ name: "latest" }, { name: "1.27" }] });
    const viaServer = await listRegistryTags("redis", { kind: "server" }, signal());
    expect(JSON.parse(fetch.mock.calls[6][1].body).url).toBe("https://registry-1.docker.io/v2/library/redis/tags/list?n=1000");
    expect(viaServer.notice).toMatch(/限额/);
    await expect(listRegistryTags("nginx", W(), signal(), "2")).rejects.toThrow();
  });
});

it("stops retrying the Hub login until Retry-After once it is rate-limited", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{"detail":"Rate limit exceeded"}', { status: 429, headers: { "Retry-After": "60" } }));
  vi.stubGlobal("fetch", fetch);
  const creds = { username: "limited-user", secret: "pat" };
  await expect(hubLogin("https://worker.example", creds, new AbortController().signal)).rejects.toThrow(/登录 Docker Hub 过于频繁（429）/);
  await expect(hubLogin("https://worker.example", creds, new AbortController().signal)).rejects.toThrow(/秒后重试/);
  expect(fetch).toHaveBeenCalledTimes(1);
});

describe("describeTag", () => {
  const d = (c: string) => `sha256:${c.repeat(64)}`;
  it("reads index → platform manifest → config through the Worker, with one token", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:o/app:pull"' } }))
      .mockResolvedValueOnce(json({ token: "t" }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        mediaType: "application/vnd.oci.image.index.v1+json",
        annotations: { "org.opencontainers.image.description": "From index" },
        manifests: [
          { digest: d("a"), platform: { os: "linux", architecture: "arm64", variant: "v8" } },
          { digest: d("b"), platform: { os: "linux", architecture: "amd64" } },
          { digest: d("c"), platform: { os: "unknown", architecture: "unknown" }, annotations: { "vnd.docker.reference.type": "attestation-manifest" } },
        ],
      }), { headers: { "Docker-Content-Digest": d("f") } }))
      .mockResolvedValueOnce(json({ config: { digest: d("e"), size: 1000 }, layers: [{ size: 2000 }, { size: 3000 }] }))
      .mockResolvedValueOnce(json({ created: "2026-10-01T00:00:00Z", architecture: "amd64", config: { Labels: { "org.opencontainers.image.source": "https://github.com/o/app" } } }));
    vi.stubGlobal("fetch", fetch);
    const result = await describeTag("ghcr.io/o/app:1.2", W(), signal());
    expect(fetch.mock.calls.map(([u]) => upstream(u).pathname)).toEqual(["/v2/o/app/manifests/1.2", "/token", "/v2/o/app/manifests/1.2", `/v2/o/app/manifests/${d("b")}`, `/v2/o/app/blobs/${d("e")}`]);
    expect(fetch.mock.calls[4][1].headers.Authorization).toBe("Bearer t");
    expect(result).toEqual({
      updated: Date.parse("2026-10-01T00:00:00Z") / 1000, size: 6000, platforms: ["arm64/v8", "amd64"], digest: d("f"),
      labels: { "org.opencontainers.image.description": "From index", "org.opencontainers.image.source": "https://github.com/o/app" },
    });
  });

  it("sends the Accept header through the server route and reads a single-platform manifest's config", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ config: { digest: d("e"), size: 10 }, layers: [{ size: 90 }] }))
      .mockResolvedValueOnce(json({ created: "bad", architecture: "arm", variant: "v7" }));
    vi.stubGlobal("fetch", fetch);
    const result = await describeTag("registry.example/team/app:v1", { kind: "server", registryIds: ["r1"] }, signal());
    const first = JSON.parse(fetch.mock.calls[0][1].body);
    expect(first).toEqual({ url: "https://registry.example/v2/team/app/manifests/v1", accept: expect.stringContaining("image.index"), registry_ids: ["r1"] });
    expect(JSON.parse(fetch.mock.calls[1][1].body).url).toBe(`https://registry.example/v2/team/app/blobs/${d("e")}`);
    expect(result).toEqual({ updated: undefined, size: 100, platforms: ["arm/v7"], digest: undefined, labels: {} });
  });
});
