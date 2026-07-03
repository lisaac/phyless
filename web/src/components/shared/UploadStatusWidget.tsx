import { Component, Show } from "solid-js";

// Non-blocking floating status card for file-upload progress — matches
// PullStatusWidget's shell, but driven by XHR upload progress (0-100)
// instead of a server-streamed NDJSON log, since fetch() exposes no
// upload-progress events.
export const UploadStatusWidget: Component<{
  active: boolean;
  filename: string;
  progress: number;
  done: boolean;
  error: string;
  onClose: () => void;
}> = (props) => (
  <Show when={props.active}>
    <div class="fixed bottom-4 left-4 z-50 w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-zinc-700/50 bg-zinc-900 shadow-2xl">
      <div class="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <div class="flex min-w-0 items-center gap-2">
          <span class={`h-2 w-2 shrink-0 rounded-full ${
            props.done ? (props.error ? "bg-red-500" : "bg-emerald-500") : "animate-pulse bg-indigo-500"
          }`} />
          <span class="truncate text-sm font-medium text-zinc-200">上传 {props.filename}</span>
        </div>
        <button
          class="p-1 text-zinc-500 transition-colors hover:text-zinc-200"
          title="关闭"
          onClick={props.onClose}
        >✕</button>
      </div>
      <div class="px-3 py-2">
        <div class="h-2.5 overflow-hidden rounded-full bg-zinc-800">
          <div
            class="h-full rounded-full bg-indigo-600 transition-all duration-150"
            style={{ width: `${Math.min(100, props.progress)}%` }}
          />
        </div>
        <p class="mt-1.5 font-mono text-xs text-zinc-500">
          {props.done ? (props.error ? "失败" : "完成 ✓") : `${props.progress.toFixed(0)}%`}
        </p>
      </div>
      <Show when={props.error}>
        <p class="border-t border-zinc-800 px-3 py-1.5 text-xs text-red-400">{props.error}</p>
      </Show>
    </div>
  </Show>
);
