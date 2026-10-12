import { Component } from "solid-js";
import { CodeEditor } from "./CodeEditor";
import { copyToClipboard } from "../../api/clipboard";
import { toast } from "./Toast";

// Read-only, highlighted, foldable JSON with a copy button — the one inspect
// viewer shared by every Inspect modal/tab.
export const JsonView: Component<{ data: unknown; class?: string }> = (p) => {
  const text = () => JSON.stringify(p.data, null, 2) ?? "";
  const copy = async () => {
    if (await copyToClipboard(text())) toast.success("已复制 JSON");
    else toast.error("复制失败");
  };
  return (
    <div class="relative">
      <button
        type="button"
        class="absolute right-2 top-2 z-10 border border-zinc-700 bg-zinc-900/90 px-2 py-0.5 text-xs text-zinc-300 transition-colors hover:border-indigo-500 hover:text-indigo-400"
        onClick={() => void copy()}
      >复制</button>
      {/* flex-col caps the bordered editor itself (a scroll container shrinks as a
          flex item), so its frame stays put and the copy button stays inside it. */}
      <div class={`flex flex-col ${p.class ?? "max-h-[70vh]"}`}>
        <CodeEditor value={text()} language="json" readOnly />
      </div>
    </div>
  );
};
