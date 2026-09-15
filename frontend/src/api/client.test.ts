import { describe, it, expect, vi, beforeEach } from "vitest";
import { request, ApiError, getToken, setToken, login, setup, isApiNotFound } from "./client";
import { cancelDockerServerRequests } from "../stores/dockerServer";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("token storage", () => {
  it("round-trips the token", () => {
    setToken("abc");
    expect(getToken()).toBe("abc");
    setToken(null);
    expect(getToken()).toBeNull();
  });
});

describe("request", () => {
  it("recognizes only API 404 errors as missing resources", () => {
    expect(isApiNotFound(new ApiError(404, "missing"))).toBe(true);
    expect(isApiNotFound(new ApiError(500, "unavailable"))).toBe(false);
    expect(isApiNotFound(new Error("missing"))).toBe(false);
  });

  it("attaches bearer header and parses JSON", async () => {
    setToken("tok");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await request<{ ok: boolean }>("GET", "/api/x");
    expect(out.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("throws ApiError with status on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("nope", { status: 500 }),
    ));
    await expect(request("GET", "/api/x")).rejects.toBeInstanceOf(ApiError);
  });

  it("clears token and dispatches event on 401", async () => {
    setToken("tok");
    const handler = vi.fn();
    window.addEventListener("phyless:unauthorized", handler);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    await expect(request("GET", "/api/x")).rejects.toBeInstanceOf(ApiError);
    expect(getToken()).toBeNull();
    expect(handler).toHaveBeenCalled();
    window.removeEventListener("phyless:unauthorized", handler);
  });

  it("does not clear a newer token when an older request returns 401", async () => {
    setToken("old-token");
    const handler = vi.fn();
    window.addEventListener("phyless:unauthorized", handler);
    vi.stubGlobal("fetch", vi.fn(async () => {
      setToken("new-token");
      return new Response("", { status: 401 });
    }));
    await expect(request("GET", "/api/x")).rejects.toMatchObject({ status: 401 });
    expect(getToken()).toBe("new-token");
    expect(handler).not.toHaveBeenCalled();
    window.removeEventListener("phyless:unauthorized", handler);
  });

  it("aborts a stale read when the Docker server changes", async () => {
    const aborted = new Error("aborted");
    const fetchMock = vi.fn((_path: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(aborted), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = request("GET", "/api/containers");
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal;
    cancelDockerServerRequests();
    expect(signal?.aborted).toBe(true);
    await expect(pending).rejects.toBe(aborted);
  });
});

describe("login", () => {
  it("stores the returned token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: "jwt123" }), { status: 200 }),
    ));
    const t = await login("admin", "admin");
    expect(t).toBe("jwt123");
    expect(getToken()).toBe("jwt123");
  });

  it("stores the token issued during initial setup", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: "setup-jwt" }), { status: 200 }),
    ));
    const t = await setup("new-password");
    expect(t).toBe("setup-jwt");
    expect(getToken()).toBe("setup-jwt");
  });
});
