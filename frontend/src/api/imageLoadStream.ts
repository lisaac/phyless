// Streams a browser-assembled tar to the daemon over the /ws/images/load
// WebSocket. Binary frames carry tar bytes; the "__eof__" text frame marks a
// complete upload; the server replies with daemon progress and a final
// {"status":"done"} or {"error":...}. Backpressure comes from bufferedAmount:
// we pause reading the tar while the socket's send buffer is full, so a slow
// daemon cannot make the browser buffer the whole image.

const EOF = "__eof__";
const OPEN = 1;

type SocketLike = Pick<WebSocket, "send" | "close" | "readyState" | "bufferedAmount"> & {
  binaryType: BinaryType;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
};

export interface StreamOpts {
  tar: ReadableStream<Uint8Array>;
  token: string;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
  // Test seams:
  wsUrl?: string;
  WebSocketCtor?: new (url: string) => SocketLike;
  bufferedThreshold?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function streamTarToDaemon(opts: StreamOpts): Promise<void> {
  const threshold = opts.bufferedThreshold ?? 4 << 20;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = opts.wsUrl ?? defaultWsUrl(opts.token);
  const Ctor = (opts.WebSocketCtor ?? (WebSocket as unknown)) as new (url: string) => SocketLike;
  const socket = new Ctor(url);
  socket.binaryType = "arraybuffer";

  const reader = opts.tar.getReader();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      // Cancel the tar reader so an in-flight layer fetch (and its connection)
      // is torn down promptly instead of lingering until GC.
      reader.cancel().catch(() => {});
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      err ? reject(err) : resolve();
    };

    const onAbort = () => finish(new Error("已取消"));
    if (opts.signal) {
      if (opts.signal.aborted) {
        finish(new Error("已取消"));
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    socket.onmessage = (ev) => {
      const text = typeof ev.data === "string" ? ev.data : "";
      let obj: { error?: string; errorDetail?: { message?: string } | string; status?: string; stream?: string } | null = null;
      try {
        obj = JSON.parse(text);
      } catch {
        obj = null;
      }
      const error = obj?.error || (typeof obj?.errorDetail === "string" ? obj.errorDetail : obj?.errorDetail?.message);
      if (error) {
        finish(new Error(error));
      } else if (obj?.status === "done") {
        finish();
      } else if (obj?.stream || obj?.status) {
        opts.onProgress?.((obj.stream ?? obj.status ?? "").trim());
      } else if (text && !obj) {
        opts.onProgress?.(text);
      }
    };
    socket.onerror = () => finish(new Error("连接错误"));
    socket.onclose = () => finish(new Error("连接已关闭"));

    socket.onopen = () => {
      void pump(socket, reader, threshold, sleep, opts.signal).catch((err) =>
        finish(err instanceof Error ? err : new Error(String(err))),
      );
    };
  });
}

async function pump(
  socket: SocketLike,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  threshold: number,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      while (socket.readyState === OPEN && socket.bufferedAmount > threshold) {
        await sleep(15);
        if (signal?.aborted) return;
      }
      if (socket.readyState !== OPEN) throw new Error("连接已关闭");
      socket.send(value);
    }
    if (socket.readyState === OPEN) socket.send(EOF);
  } finally {
    reader.releaseLock();
  }
}

function defaultWsUrl(token: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws/images/load?token=${encodeURIComponent(token)}`;
}
