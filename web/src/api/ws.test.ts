import { describe, it, expect, beforeEach } from "vitest";
import { wsURL } from "./ws";
import { setToken } from "./client";

beforeEach(() => localStorage.clear());

describe("wsURL", () => {
  it("builds ws url with token query param", () => {
    setToken("tk");
    const u = wsURL("/ws/events");
    expect(u).toContain("/ws/events");
    expect(u).toContain("token=tk");
    expect(u.startsWith("ws://") || u.startsWith("wss://")).toBe(true);
  });
});
