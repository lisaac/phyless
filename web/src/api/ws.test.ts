import { describe, it, expect, beforeEach, vi } from "vitest";
import { connectWS, wsURL } from "./ws";
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

  it("forwards socket errors without throwing into page logic", () => {
    const onError = vi.fn();
    class FakeWebSocket {
      static last?: FakeWebSocket;
      binaryType = "";
      onmessage?: (ev: MessageEvent) => void;
      onerror?: () => void;
      onclose?: () => void;
      onopen?: () => void;
      constructor(_url: string) { FakeWebSocket.last = this; }
      close() {}
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const socket = connectWS("/ws/events", { onMessage: () => {}, onError });
    expect(socket).toBe(FakeWebSocket.last);
    FakeWebSocket.last?.onerror?.();
    expect(onError).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
