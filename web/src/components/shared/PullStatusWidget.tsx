import { Component, createSignal, createEffect, onCleanup, untrack, Show, For } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { getToken } from "../../api/client";
import { useFloatingSlot } from "../../stores/floatingStack";

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
  onSettled?: () => void;
  onClose: () => void;
  // Overrides the auto-detected "查看容器详情" link (from a {container_id}
  // event) — for callers that already know exactly where they want the link
  // to point, e.g. copy-to-container linking straight to the target directory.
  doneLink?: { href: string; label: string };
}> = (props) => {
  const navigate = useNavigate();
  const [layers, setLayers] = createSignal<LayerProgress[]>([]);
  const [notes, setNotes] = createSignal<string[]>([]);
  const [done, setDone] = createSignal(false);
  const [err, setErr] = createSignal("");
  const [cancelled, setCancelled] = createSignal(false);
  const [collapsed, setCollapsed] = createSignal(false);
  const [containerId, setContainerId] = createSignal("");
  // Only meaningful while props.file is set and the browser is still
  // sending bytes — null once upload finishes (server-side progress takes
  // over via the layers/notes above).
  const [uploadPct, setUploadPct] = createSignal<number | null>(null);
  const { setRef, offset } = useFloatingSlot(() => props.active);
  let xhr: XMLHttpRequest | undefined;
  let buf = "";
  let readLen = 0;
  const layerMap = new Map<string, LayerProgress>();

  const eventError = (evt: any): string => {
    if (typeof evt.error === "string" && evt.error.trim()) return evt.error;
    if (typeof evt.errorDetail === "string" && evt.errorDetail.trim()) return evt.errorDetail;
    if (evt.errorDetail && typeof evt.errorDetail.message === "string" && evt.errorDetail.message.trim()) {
      return evt.errorDetail.message;
    }
    return "";
  };

  const applyLine = (line: string) => {
    if (!line.trim()) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let evt: any;
    try { evt = JSON.parse(line); } catch { setErr("无效的进度响应"); return; }
    if (!evt || typeof evt !== "object" || Array.isArray(evt)) {
      setErr("无效的进度响应");
      return;
    }
    // Docker reports failures as either {error} or {errorDetail:{message}};
    // inspect them before status/id so a terminal error cannot look complete.
    const failure = eventError(evt);
    if (failure) {
      setErr(failure);
      return;
    }
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
      if (evt.container_id) setContainerId(evt.container_id);
    } else if (evt.error) {
      setErr(evt.error);
    }
  };

  const consumeChunk = (chunk: string) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    lines.forEach(applyLine);
  };

  // XHR rather than fetch: fetch has no upload-progress events at all, so a
  // large file (docker load / import) would otherwise show nothing but a
  // spinner for the entire upload. XHR gives both upload progress AND, via
  // onprogress on the response side, the same incremental NDJSON parsing
  // fetch's reader gave us — one transport covers both directions.
  createEffect(() => {
    if (!props.active) { xhr?.abort(); return; }
    // Start once per active transition. Callers may clear the request body
    // after completion while keeping this card open; changing a prop must not
    // replay an already-started POST.
    const { url, body, file } = untrack(() => ({ url: props.url, body: props.body, file: props.file }));
    setLayers([]); setNotes([]); setDone(false); setErr(""); setCancelled(false); setCollapsed(false); setContainerId("");
    setUploadPct(file ? 0 : null);
    layerMap.clear();
    buf = ""; readLen = 0;
    let failed = false;

    const req = new XMLHttpRequest();
    xhr = req;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      props.onSettled?.();
    };
    req.open("POST", url);
    req.setRequestHeader("Authorization", `Bearer ${getToken()}`);
    if (file) {
      req.setRequestHeader("Content-Type", "application/x-tar");
      req.upload.onprogress = (e) => {
        if (e.lengthComputable) setUploadPct((e.loaded / e.total) * 100);
      };
    } else if (body) {
      req.setRequestHeader("Content-Type", "application/json");
    }
    req.onprogress = () => {
      setUploadPct(null); // response bytes are arriving — upload phase is over
      const text = req.responseText;
      if (text.length > readLen) {
        consumeChunk(text.slice(readLen));
        readLen = text.length;
      }
    };
    req.onload = () => {
      if (req.status < 200 || req.status >= 300) {
        failed = true;
        setErr(req.responseText || `请求失败 (${req.status})`);
        setDone(true);
        settle();
        return;
      }
      if (req.responseText.length > readLen) consumeChunk(req.responseText.slice(readLen));
      if (buf) applyLine(buf);
      setDone(true);
      if (err()) failed = true;
      if (!failed && !cancelled()) props.onDone?.();
      settle();
    };
    req.onerror = () => { failed = true; setErr("网络错误"); setDone(true); settle(); };
    req.onabort = () => { failed = true; setCancelled(true); setErr("已取消"); setDone(true); settle(); };
    req.send(file ?? (body ? JSON.stringify(body) : undefined));
  });

  onCleanup(() => xhr?.abort());

  return (
    <Show when={props.active}>
      <div
        ref={setRef}
        class="fixed left-4 z-50 w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-zinc-700/50 bg-zinc-900 shadow-2xl transition-[bottom] duration-200"
        style={{ bottom: `${offset()}px` }}
      >
        <div class="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
          <div class="flex min-w-0 items-center gap-2">
            <span class={`h-2 w-2 shrink-0 rounded-full ${
              done() ? (err() || cancelled() ? "bg-red-500" : "bg-emerald-500") : "animate-pulse bg-indigo-500"
            }`} />
            <span class="truncate text-sm font-medium text-zinc-200">{props.title}</span>
          </div>
          <div class="flex shrink-0 items-center gap-0.5">
            <button
              class="w-4 p-1 text-center text-xs leading-none text-zinc-500 transition-colors hover:text-zinc-200"
              title={collapsed() ? "展开" : "收起"}
              onClick={() => setCollapsed((c) => !c)}
            >{collapsed() ? "+" : "−"}</button>
            <button
              class="p-1 text-zinc-500 transition-colors hover:text-zinc-200"
              title="关闭"
              onClick={() => { xhr?.abort(); props.onClose(); }}
            >✕</button>
          </div>
        </div>
        <Show when={!collapsed()}>
          <div class="max-h-64 overflow-auto px-3 py-2 font-mono text-xs">
            <Show when={uploadPct() !== null}>
              <p class="mb-1.5 text-zinc-400">上传中 {uploadPct()!.toFixed(0)}%</p>
              <div class="mb-1.5 h-2 overflow-hidden rounded-full bg-zinc-800">
                <div
                  class="h-full rounded-full bg-indigo-600 transition-all duration-150"
                  style={{ width: `${Math.min(100, uploadPct()!)}%` }}
                />
              </div>
            </Show>
            <Show when={uploadPct() === null && layers().length === 0 && notes().length === 0}>
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
            <Show when={done() && !err() && !cancelled() && (props.doneLink || containerId())}>
              <a
                href={props.doneLink?.href ?? `/containers/${containerId()}`}
                class="mt-1.5 block text-indigo-400 hover:text-indigo-300 hover:underline"
                onClick={(e) => {
                  e.preventDefault();
                  navigate(props.doneLink?.href ?? `/containers/${containerId()}`, { replace: true });
                }}
              >
                → {props.doneLink?.label ?? "查看容器详情"}
              </a>
            </Show>
          </div>
          <Show when={err()}>
            <p class="border-t border-zinc-800 px-3 py-1.5 text-xs text-red-400">{err()}</p>
          </Show>
        </Show>
      </div>
    </Show>
  );
};
