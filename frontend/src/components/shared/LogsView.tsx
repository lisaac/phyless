import { Component, onMount, onCleanup, createEffect, createSignal } from "solid-js";
import { connectWS, reportWSError } from "../../api/ws";

// Generic log-stream viewer — pause/resume, auto-scroll, clear, buffered
// flush (throttled so a fast-scrolling log doesn't thrash layout). Driven
// entirely by a websocket URL so both a single container's logs and a whole
// compose project's `docker compose logs -f` stream can share it.
export const LogsView: Component<{ wsUrl: string; heightClass?: string }> = (props) => {
  const FLUSH_MS = 80;
  const MAX_BUFFER_CHARS = 64_000;
  const MAX_DISPLAY_CHARS = 200_000;
  const [text, setText] = createSignal("");
  const [autoScroll, setAutoScroll] = createSignal(true);
  const [paused, setPaused] = createSignal(false);
  let box!: HTMLPreElement;
  let ws: WebSocket | undefined;
  let buf = "";
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let decoder = new TextDecoder();
  let connection = 0;

  const flush = () => {
    if (!buf) return;
    // "暂停" only freezes auto-scroll, not the content — it used to drop
    // buf outright while paused, which silently ate the entire backlog a
    // stopped container's logs arrive as in one initial burst (the view
    // started paused for stopped containers, so nothing ever showed).
    const chunk = buf;
    buf = "";
    setText((t) => (t + chunk).slice(-MAX_DISPLAY_CHARS)); // ponytail: cap at 200k chars
    if (!paused() && autoScroll()) queueMicrotask(() => box?.scrollTo(0, box.scrollHeight));
  };

  const scheduleFlush = () => {
    if (flushTimer !== undefined) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flush();
      if (buf) scheduleFlush();
    }, FLUSH_MS);
  };

  const append = (chunk: string) => {
    if (!chunk) return;
    buf = (buf + chunk).slice(-MAX_BUFFER_CHARS); // ponytail: bounded backlog
    scheduleFlush();
  };

  const connect = () => {
    const current = ++connection;
    ws?.close();
    setText("");
    buf = "";
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = undefined;
    decoder = new TextDecoder();
    ws = connectWS(props.wsUrl, {
      onMessage: (ev) => {
        if (current !== connection) return;
        append(typeof ev.data === "string" ? ev.data : decoder.decode(ev.data as ArrayBuffer, { stream: true }));
      },
      onClose: () => {
        if (current === connection) append(decoder.decode());
      },
      onError: () => { if (current === connection) reportWSError("日志实时连接"); },
    });
  };

  onMount(connect);
  // Reconnect if the URL changes under us (e.g. switching projects/containers
  // on a page that isn't remounted across a route param change).
  createEffect((prev) => {
    if (prev !== undefined && prev !== props.wsUrl) connect();
    return props.wsUrl;
  });
  onCleanup(() => {
    connection++;
    ws?.close();
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = undefined;
    buf = "";
    decoder = new TextDecoder();
  });

  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-3 text-xs">
        <button
          class={`border px-2 py-0.5 transition-colors ${paused() ? "border-zinc-500 text-zinc-200" : "border-zinc-700 text-zinc-500 hover:text-zinc-200"}`}
          onClick={() => setPaused((v) => !v)}
        >{paused() ? "▶ 继续" : "⏸ 暂停"}</button>
        <label class="flex cursor-pointer items-center gap-1.5 text-zinc-500">
          <input type="checkbox" checked={autoScroll()} onChange={(e) => setAutoScroll(e.currentTarget.checked)} />
          自动滚动
        </label>
        <button class="text-zinc-400 hover:text-zinc-300" onClick={() => { buf = ""; setText(""); }}>清空</button>
      </div>
      <pre
        ref={box}
        class={`${props.heightClass ?? "h-[65vh]"} overflow-auto whitespace-pre-wrap bg-zinc-950 p-3 font-mono text-xs text-zinc-300 leading-5`}
      >{text()}</pre>
    </div>
  );
};
