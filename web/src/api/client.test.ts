import { describe, it, expect, vi, beforeEach } from "vitest";
import { request, ApiError, getToken, setToken, login } from "./client";

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
});
