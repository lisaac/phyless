import { Component, Show } from "solid-js";
import { useFloatingSlot } from "../../stores/floatingStack";

// Non-blocking floating status card for file transfer progress — matches
// PullStatusWidget's shell, but driven by XHR/fetch progress events instead
// of a server-streamed NDJSON log (fetch() exposes no upload-progress
// events at all, hence XHR for uploads; downloads stream via fetch's
// response reader, which gives bytes-so-far but no fixed total to compute a
// percentage from — so progress is a 0-100 bar when known (uploads), or a
// running byte count via bytesLabel when it isn't (downloads, since the
// exact tar size isn't known upfront).
export const UploadStatusWidget: Component<{
  active: boolean;
  label?: string; // "上传" (default) | "下载"
  filename: string;
  progress?: number;
  bytesLabel?: string;
  done: boolean;
  error: string;
  onClose: () => void;
}> = (props) => {
  const { setRef, offset } = useFloatingSlot(() => props.active);

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
              props.done ? (props.error ? "bg-red-500" : "bg-emerald-500") : "animate-pulse bg-indigo-500"
            }`} />
            <span class="truncate text-sm font-medium text-zinc-200">{props.label ?? "上传"} {props.filename}</span>
          </div>
          <button
            class="p-1 text-zinc-500 transition-colors hover:text-zinc-200"
            title="关闭"
            onClick={props.onClose}
          >✕</button>
        </div>
        <div class="px-3 py-2">
          <Show
            when={props.progress !== undefined}
            fallback={
              <p class="font-mono text-xs text-zinc-500">
                {props.done ? (props.error ? "失败" : "完成 ✓") : (props.bytesLabel ?? "")}
              </p>
            }
          >
            <div class="h-2.5 overflow-hidden rounded-full bg-zinc-800">
              <div
                class="h-full rounded-full bg-indigo-600 transition-all duration-150"
                style={{ width: `${Math.min(100, props.progress ?? 0)}%` }}
              />
            </div>
            <p class="mt-1.5 font-mono text-xs text-zinc-500">
              {props.done ? (props.error ? "失败" : "完成 ✓") : `${(props.progress ?? 0).toFixed(0)}%`}
            </p>
          </Show>
        </div>
        <Show when={props.error}>
          <p class="border-t border-zinc-800 px-3 py-1.5 text-xs text-red-400">{props.error}</p>
        </Show>
      </div>
    </Show>
  );
};
