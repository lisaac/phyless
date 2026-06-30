import { Component, onMount, onCleanup, createSignal } from "solid-js";
import { connectWS } from "../../api/ws";

export const ContainerLogs: Component<{ id: string }> = (props) => {
  const [text, setText] = createSignal("");
  let box!: HTMLPreElement;
  let ws: WebSocket | undefined;

  onMount(() => {
    const decoder = new TextDecoder();
    ws = connectWS(`/ws/containers/${props.id}/logs`, {
      onMessage: (ev) => {
        const chunk = typeof ev.data === "string" ? ev.data : decoder.decode(ev.data as ArrayBuffer);
        setText((t) => (t + chunk).slice(-100_000)); // ponytail: cap buffer at 100k chars
        queueMicrotask(() => box?.scrollTo(0, box.scrollHeight));
      },
    });
  });
  onCleanup(() => ws?.close());

  return <pre ref={box} class="h-[60vh] overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-3 font-mono text-xs">{text()}</pre>;
};
