import { beforeEach, describe, expect, it, vi } from "vitest";
import { DOWNLOAD_FALLBACK_LIMIT, streamDownload, createDownloadTask } from "./download";
import { setToken } from "./client";

beforeEach(() => {
  setToken(null);
  vi.restoreAllMocks();
  delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker;
});

describe("streamDownload", () => {
  it("cancels an oversized fallback stream and bounds error responses", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "Content-Length": String(DOWNLOAD_FALLBACK_LIMIT + 1) },
    })));
    await expect(streamDownload("/download", "file.tar", vi.fn())).rejects.toThrow();
    expect(cancelled).toBe(true);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("e".repeat(128 * 1024), { status: 500 })));
    await expect(streamDownload("/download", "file.tar", vi.fn())).rejects.toMatchObject({
      message: "e".repeat(64 * 1024),
    });
  });
});

describe("createDownloadTask", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });
  });

  it("tracks a successful download and a failed one, and cancel() aborts and resets active", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const task = createDownloadTask();
    expect(task.state().active).toBe(false);
    await task.start("/download", "file.tar");
    expect(task.state()).toMatchObject({ active: true, filename: "file.tar", done: true, error: "" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));
    await task.start("/download", "other.tar");
    expect(task.state()).toMatchObject({ filename: "other.tar", done: true, error: "boom" });

    task.cancel();
    expect(task.state().active).toBe(false);
  });

  it("starting a new download aborts the previous one's fetch", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const pending = new Promise<Response>(() => { /* first fetch never resolves */ });
    const fastBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); },
    });
    vi.stubGlobal("fetch", vi.fn((_url: string, opts: { signal?: AbortSignal }) => {
      signals.push(opts.signal);
      return signals.length === 1 ? pending : Promise.resolve(new Response(fastBody, { status: 200 }));
    }));
    const task = createDownloadTask();
    void task.start("/download", "a.tar");
    await Promise.resolve(); // let the first start() reach fetch()
    await task.start("/download", "b.tar");
    expect(signals[0]?.aborted).toBe(true);
    expect(task.state()).toMatchObject({ filename: "b.tar", done: true });
  });
});
