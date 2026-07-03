import { Component, createSignal, createEffect, onCleanup, Show, For } from "solid-js";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { getToken } from "../../api/client";

interface LayerProgress {
  id: string;
  status: string;
  current?: number;
  total?: number;
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}KB`;
  return `${n}B`;
}

// Docker pull/push progress status labels, mapped to an accent color.
const STATUS_STYLE: Record<string, string> = {
  "Pull complete": "text-emerald-400",
  "Already exists": "text-zinc-500",
  "Download complete": "text-sky-400",
  Downloading: "text-indigo-400",
  Extracting: "text-indigo-400",
  Waiting: "text-zinc-500",
  Verifying: "text-zinc-400",
};

// Docker's pull API streams newline-delimited JSON progress events. Parse
// them into a per-layer list (like `docker pull`'s multi-line live display)
// instead of dumping raw JSON; falls back to plain text for any other stream.
export const StreamingLogModal: Component<{
  open: boolean;
  onClose: () => void;
  title: string;
  url: string;
  body?: unknown;
  onDone?: () => void;
}> = (props) => {
  const [layers, setLayers] = createSignal<LayerProgress[]>([]);
  const [notes, setNotes] = createSignal<string[]>([]);
  const [rawLog, setRawLog] = createSignal("");
  const [isJson, setIsJson] = createSignal(true);
  const [done, setDone] = createSignal(false);
  const [err, setErr] = createSignal("");
  let ctrl: AbortController | undefined;
  let buf = "";
  const layerMap = new Map<string, LayerProgress>();

  const applyLine = (line: string) => {
    if (!line.trim()) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let evt: any;
    try { evt = JSON.parse(line); }
    catch { setIsJson(false); setRawLog((l) => l + line + "\n"); return; }
    if (evt.id) {
      layerMap.set(evt.id, {
        id: evt.id,
        status: evt.status ?? layerMap.get(evt.id)?.status ?? "",
        current: evt.progressDetail?.current,
        total: evt.progressDetail?.total,
      });
      setLayers([...layerMap.values()]);
    } else if (evt.status) {
      setNotes((n) => [...n, evt.status]);
    } else if (evt.error) {
      setErr(evt.error);
    }
  };

  createEffect(() => {
    if (!props.open) { ctrl?.abort(); return; }
    setLayers([]); setNotes([]); setRawLog(""); setIsJson(true); setDone(false); setErr("");
    layerMap.clear();
    buf = "";
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
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          lines.forEach(applyLine);
        }
        if (buf) applyLine(buf);
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
      <Show
        when={isJson()}
        fallback={
          <pre class="h-[55vh] overflow-auto border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-300">
            {rawLog() || "连接中…"}
          </pre>
        }
      >
        <div class="h-[55vh] overflow-auto border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs">
          <Show when={layers().length === 0 && notes().length === 0}>
            <p class="text-zinc-500">连接中…</p>
          </Show>
          <div class="flex flex-col gap-1">
            <For each={layers()}>
              {(l) => (
                <div class="flex items-center gap-2 py-0.5">
                  <span class="w-20 shrink-0 text-zinc-500">{l.id}</span>
                  <span class={`w-28 shrink-0 ${STATUS_STYLE[l.status] ?? "text-zinc-400"}`}>{l.status}</span>
                  <Show when={l.total}>
                    <div class="h-2.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
                      <div
                        class="h-full rounded-full bg-indigo-600 transition-all duration-200"
                        style={{ width: `${Math.min(100, ((l.current ?? 0) / (l.total ?? 1)) * 100)}%` }}
                      />
                    </div>
                    <span class="w-24 shrink-0 text-right text-zinc-500">
                      {fmtBytes(l.current ?? 0)}/{fmtBytes(l.total ?? 0)}
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </div>
          <For each={notes()}>
            {(n) => <div class="mt-1.5 text-zinc-400">{n}</div>}
          </For>
        </div>
      </Show>
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
