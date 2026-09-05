import { beforeEach, describe, expect, it, vi } from "vitest";
import { DOWNLOAD_FALLBACK_LIMIT, streamDownload } from "./download";
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
