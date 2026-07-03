import { Component, createSignal, createEffect, onCleanup, Show, For } from "solid-js";
import { getToken } from "../../api/client";

interface LayerProgress { id: string; status: string; current?: number; total?: number; }

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}KB`;
  return `${n}B`;
}

const STATUS_STYLE: Record<string, string> = {
  "Pull complete": "text-emerald-400",
  "Already exists": "text-zinc-500",
  "Download complete": "text-sky-400",
  Downloading: "text-indigo-400",
  Extracting: "text-indigo-400",
  Waiting: "text-zinc-500",
  Verifying: "text-zinc-400",
};

// Non-blocking floating status card for streaming Docker operations (pull,
// load, and anything else that emits newline-delimited JSON progress) —
// unlike a modal, the rest of the page stays usable while it runs. Parses
// per-layer {id, status, progressDetail} events (docker pull) as well as
// plain {stream: "..."} log lines (docker load) into one status list.
export const PullStatusWidget: Component<{
  active: boolean;
  title: string;
  url: string;
  body?: unknown;
  file?: File;
  onDone?: () => void;
  onClose: () => void;
}> = (props) => {
  const [layers, setLayers] = createSignal<LayerProgress[]>([]);
  const [notes, setNotes] = createSignal<string[]>([]);
  const [done, setDone] = createSignal(false);
  const [err, setErr] = createSignal("");
  const [collapsed, setCollapsed] = createSignal(false);
  let ctrl: AbortController | undefined;
  let buf = "";
  const layerMap = new Map<string, LayerProgress>();

  const applyLine = (line: string) => {
    if (!line.trim()) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let evt: any;
    try { evt = JSON.parse(line); } catch { return; }
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
    } else if (evt.stream) {
      setNotes((n) => [...n, String(evt.stream).trim()]);
    } else if (evt.error) {
      setErr(evt.error);
    }
  };

  createEffect(() => {
    if (!props.active) { ctrl?.abort(); return; }
    setLayers([]); setNotes([]); setDone(false); setErr(""); setCollapsed(false);
    layerMap.clear();
    buf = "";
    ctrl = new AbortController();
    const c = ctrl;
    void (async () => {
      try {
        const headers: Record<string, string> = { Authorization: `Bearer ${getToken()}` };
        let body: BodyInit | undefined;
        if (props.file) {
          headers["Content-Type"] = "application/x-tar";
          body = props.file;
        } else if (props.body) {
          headers["Content-Type"] = "application/json";
          body = JSON.stringify(props.body);
        }
        const res = await fetch(props.url, { method: "POST", headers, body, signal: c.signal });
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

  return (
    <Show when={props.active}>
      <div class="fixed bottom-4 left-4 z-50 w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-zinc-700/50 bg-zinc-900 shadow-2xl">
        <div class="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
          <div class="flex min-w-0 items-center gap-2">
            <span class={`h-2 w-2 shrink-0 rounded-full ${
              done() ? (err() ? "bg-red-500" : "bg-emerald-500") : "animate-pulse bg-indigo-500"
            }`} />
            <span class="truncate text-sm font-medium text-zinc-200">{props.title}</span>
          </div>
          <div class="flex shrink-0 items-center gap-0.5">
            <button
              class="p-1 text-zinc-500 transition-colors hover:text-zinc-200"
              title={collapsed() ? "展开" : "收起"}
              onClick={() => setCollapsed((c) => !c)}
            >{collapsed() ? "▸" : "▾"}</button>
            <button
              class="p-1 text-zinc-500 transition-colors hover:text-zinc-200"
              title="关闭"
              onClick={() => { ctrl?.abort(); props.onClose(); }}
            >✕</button>
          </div>
        </div>
        <Show when={!collapsed()}>
          <div class="max-h-64 overflow-auto px-3 py-2 font-mono text-xs">
            <Show when={layers().length === 0 && notes().length === 0}>
              <p class="text-zinc-500">连接中…</p>
            </Show>
            <div class="flex flex-col gap-1">
              <For each={layers()}>
                {(l) => (
                  <div class="flex items-center gap-2 py-0.5">
                    <span class="w-16 shrink-0 truncate text-zinc-500">{l.id}</span>
                    <span class={`w-24 shrink-0 truncate ${STATUS_STYLE[l.status] ?? "text-zinc-400"}`}>{l.status}</span>
                    <Show when={l.total}>
                      <div class="h-2 flex-1 overflow-hidden rounded-full bg-zinc-800">
                        <div
                          class="h-full rounded-full bg-indigo-600 transition-all duration-200"
                          style={{ width: `${Math.min(100, ((l.current ?? 0) / (l.total ?? 1)) * 100)}%` }}
                        />
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
            <For each={notes()}>
              {(n) => <div class="mt-1.5 text-zinc-400">{n}</div>}
            </For>
          </div>
          <Show when={err()}>
            <p class="border-t border-zinc-800 px-3 py-1.5 text-xs text-red-400">{err()}</p>
          </Show>
        </Show>
      </div>
    </Show>
  );
};
