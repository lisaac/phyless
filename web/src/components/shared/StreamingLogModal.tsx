import { Component, createSignal, createEffect, onCleanup, Show } from "solid-js";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { getToken } from "../../api/client";

export const StreamingLogModal: Component<{
  open: boolean;
  onClose: () => void;
  title: string;
  url: string;
  body?: unknown;
  onDone?: () => void;
}> = (props) => {
  const [log, setLog] = createSignal("");
  const [done, setDone] = createSignal(false);
  const [err, setErr] = createSignal("");
  let ctrl: AbortController | undefined;
  let pre: HTMLPreElement | undefined;

  createEffect(() => {
    if (!props.open) {
      ctrl?.abort();
      return;
    }
    setLog(""); setDone(false); setErr("");
    ctrl = new AbortController();
    const c = ctrl;
    void (async () => {
      try {
        const res = await fetch(props.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${getToken()}`,
          },
          body: props.body ? JSON.stringify(props.body) : undefined,
          signal: c.signal,
        });
        if (!res.ok) {
          setErr(await res.text());
          setDone(true);
          return;
        }
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        while (true) {
          const { done: eof, value } = await reader.read();
          if (eof) break;
          setLog((l) => l + dec.decode(value, { stream: true }));
          if (pre) pre.scrollTop = pre.scrollHeight;
        }
        setDone(true);
        props.onDone?.();
      } catch (e: unknown) {
        if ((e as Error).name !== "AbortError") setErr((e as Error).message);
        setDone(true);
      }
    })();
  });

  onCleanup(() => ctrl?.abort());

  const close = () => { ctrl?.abort(); props.onClose(); };

  return (
    <Modal open={props.open} onClose={close} title={props.title} wide>
      <pre
        ref={pre}
        class="h-[55vh] overflow-auto rounded border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-300"
      >
        {log() || "连接中…"}
      </pre>
      <Show when={err()}>
        <p class="mt-2 text-sm text-red-400">{err()}</p>
      </Show>
      <div class="mt-3 flex items-center justify-between">
        <span class={`text-sm ${done() ? (err() ? "text-red-400" : "text-green-400") : "text-zinc-400"}`}>
          {done() ? (err() ? "失败" : "完成 ✓") : "进行中…"}
        </span>
        <Button onClick={close}>{done() ? "关闭" : "取消"}</Button>
      </div>
    </Modal>
  );
};
