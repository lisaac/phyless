import { Component, onMount, onCleanup, createSignal } from "solid-js";
import { connectWS } from "../../api/ws";

export const ContainerLogs: Component<{ id: string; running?: boolean }> = (props) => {
  const [text, setText] = createSignal("");
  const [autoScroll, setAutoScroll] = createSignal(true);
  const [paused, setPaused] = createSignal(!props.running);
  let box!: HTMLPreElement;
  let ws: WebSocket | undefined;
  let buf = "";
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    if (!buf) return;
    if (!paused()) {
      setText((t) => (t + buf).slice(-200_000)); // ponytail: cap at 200k chars
      if (autoScroll()) queueMicrotask(() => box?.scrollTo(0, box.scrollHeight));
    }
    buf = "";
  };

  onMount(() => {
    const decoder = new TextDecoder();
    ws = connectWS(`/ws/containers/${props.id}/logs`, {
      onMessage: (ev) => {
        buf += typeof ev.data === "string" ? ev.data : decoder.decode(ev.data as ArrayBuffer);
        clearTimeout(flushTimer);
        flushTimer = setTimeout(flush, 80); // ponytail: 80ms throttle prevents layout thrash
      },
    });
  });
  onCleanup(() => { ws?.close(); clearTimeout(flushTimer); });

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
        <button class="text-zinc-400 hover:text-zinc-300" onClick={() => setText("")}>清空</button>
      </div>
      <pre
        ref={box}
        class="h-[65vh] overflow-auto whitespace-pre-wrap bg-zinc-950 p-3 font-mono text-xs text-zinc-300 leading-5"
      >{text()}</pre>
    </div>
  );
};
