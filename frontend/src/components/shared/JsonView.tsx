import { Component } from "solid-js";
import { CodeEditor } from "./CodeEditor";

// Read-only, highlighted, foldable JSON — the one inspect viewer shared by
// every Inspect modal/tab. Copying is the editor toolbar's ⧉ 复制.
export const JsonView: Component<{ data: unknown; class?: string }> = (p) => {
  const text = () => JSON.stringify(p.data, null, 2) ?? "";
  return (
    // flex-col caps the bordered editor itself (a scroll container shrinks as a flex item).
    <div class={`flex flex-col ${p.class ?? "max-h-[70vh]"}`}>
      <CodeEditor value={text()} language="json" readOnly />
    </div>
  );
};
