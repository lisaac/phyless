import { describe, expect, it, vi } from "vitest";
import { streamTarToDaemon } from "./imageLoadStream";

function tarOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) c.enqueue(chunks[i++]);
      else c.close();
    },
  });
}

class FakeSocket {
  static last: FakeSocket;
  binaryType = "blob";
  readyState = 1;
  _buf = 0;
  get bufferedAmount() {
    return this._buf;
  }
  set bufferedAmount(v: number) {
    this._buf = v;
  }
  sent: unknown[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  emit(data: string) {
    this.onmessage?.({ data });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush() {
  for (let i = 0; i < 8; i++) await tick();
}

describe("streamTarToDaemon", () => {
  it("sends binary frames in order then __eof__, resolves on done", async () => {
    const chunks = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
    const progress: string[] = [];
    const p = streamTarToDaemon({
      tar: tarOf(chunks),
      token: "t",
      wsUrl: "ws://x",
      WebSocketCtor: FakeSocket as never,
      onProgress: (l) => progress.push(l),
    });
    const s = FakeSocket.last;
    s.onopen?.(null);
    await flush();
    expect(s.sent.slice(0, 3)).toEqual(chunks);
    expect(s.sent[3]).toBe("__eof__");

    s.emit('{"stream":"Loading layer"}');
    s.emit('{"status":"done"}');
    await expect(p).resolves.toBeUndefined();
    expect(progress).toEqual(['{"stream":"Loading layer"}']);
    expect(s.closed).toBe(true);
  });

  it("rejects on an error frame", async () => {
    const p = streamTarToDaemon({ tar: tarOf([new Uint8Array([1])]), token: "t", wsUrl: "ws://x", WebSocketCtor: FakeSocket as never });
    const s = FakeSocket.last;
    s.onopen?.(null);
    await flush();
    s.emit('{"error":"镜像导入失败"}');
    await expect(p).rejects.toThrow(/镜像导入失败/);
    expect(s.closed).toBe(true);
  });

  it("rejects and closes on abort", async () => {
    const ac = new AbortController();
    const p = streamTarToDaemon({ tar: tarOf([new Uint8Array([1])]), token: "t", wsUrl: "ws://x", WebSocketCtor: FakeSocket as never, signal: ac.signal });
    const s = FakeSocket.last;
    s.onopen?.(null);
    await flush();
    ac.abort();
    await expect(p).rejects.toThrow(/取消/);
    expect(s.closed).toBe(true);
  });

  it("pauses sending while the send buffer is full", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    class BackpressureSocket extends FakeSocket {
      get bufferedAmount() {
        // Full on the very first check, drained afterwards.
        return calls++ === 0 ? 1e9 : 0;
      }
      set bufferedAmount(_v: number) {}
    }
    const p = streamTarToDaemon({
      tar: tarOf([new Uint8Array([1]), new Uint8Array([2])]),
      token: "t",
      wsUrl: "ws://x",
      WebSocketCtor: BackpressureSocket as never,
      bufferedThreshold: 100,
      sleep,
    });
    const s = FakeSocket.last;
    s.onopen?.(null);
    await flush();
    expect(sleep).toHaveBeenCalled(); // waited for drain at least once
    expect(s.sent.filter((x) => x instanceof Uint8Array).length).toBe(2);
    s.emit('{"status":"done"}');
    await expect(p).resolves.toBeUndefined();
  });
});
