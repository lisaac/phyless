import { afterEach, describe, expect, it, vi } from "vitest";
import { streamPost } from "../stores/browserPull";
import { awaitRestart } from "./selfRestart";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("self restart handoff", () => {
  it("treats a dropped stream after the helper event as a restart and reports the helper result", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    let polls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "/api/system/helper") {
        polls++;
        if (polls === 1) throw new TypeError("Failed to fetch"); // phyless down
        if (polls === 2) return Response.json({ state: "running" });
        return Response.json({ state: "ok", message: "✓ 升级完成" });
      }
      const enc = new TextEncoder();
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (!sent) { sent = true; c.enqueue(enc.encode('{"stream":"handoff","helper":true}\n')); return; }
          c.error(new TypeError("network error")); // phyless stopped by the helper
        },
      });
      return new Response(body, { status: 200 });
    });
    const progress: string[] = [];
    const done = streamPost("/api/containers/x/upgrade", { token: "t", onProgress: (m) => progress.push(m), signal: new AbortController().signal });
    await vi.runAllTimersAsync();
    await done;
    expect(polls).toBe(3);
    expect(progress).toEqual(["handoff", "等待 helper 完成并重启 phyless…", "✓ 升级完成"]);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("fails with the helper's error", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "/api/system/helper") return Response.json({ state: "failed", error: "新容器启动后异常退出" });
      return new Response('{"stream":"handoff","helper":true}\n', { status: 200 });
    });
    await expect(streamPost("/x", { token: "t", signal: new AbortController().signal })).rejects.toThrow("新容器启动后异常退出");
  });

  it("awaitRestart waits through the outage until phyless answers again", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    let polls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (++polls < 3) throw new TypeError("Failed to fetch");
      return Response.json({ id: "abc" });
    });
    const notes: string[] = [];
    const done = awaitRestart((m) => notes.push(m));
    await vi.runAllTimersAsync();
    await done;
    expect(polls).toBe(3);
    expect(notes).toEqual(["等待 phyless 重启…"]);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("a stopping handoff ends when phyless goes away, without reloading", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    let polls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "/api/system/helper") {
        if (++polls === 1) return Response.json({ state: "running" });
        return new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } }); // proxy, phyless gone
      }
      return new Response('{"stream":"handoff","helper":true,"stops":true}\n', { status: 200 });
    });
    const progress: string[] = [];
    const done = streamPost("/api/compose/stop?id=x", { token: "t", onProgress: (m) => progress.push(m), signal: new AbortController().signal });
    await vi.runAllTimersAsync();
    await done;
    expect(progress.at(-1)).toBe("phyless 已停止，连接已断开；需在主机上手动启动");
    expect(reload).not.toHaveBeenCalled();
  });
});
