import { Component, onMount, onCleanup, createEffect } from "solid-js";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import { json } from "@codemirror/lang-json";

type Lang = "yaml" | "json" | "text";

function langExt(lang: Lang) {
  if (lang === "yaml") return [yaml()];
  if (lang === "json") return [json()];
  return [];
}

export const CodeEditor: Component<{
  value: string;
  onChange?: (v: string) => void;
  language?: Lang;
  readOnly?: boolean;
}> = (props) => {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          ...langExt(props.language ?? "text"),
          EditorView.theme({ "&": { height: "100%", fontSize: "13px" } }, { dark: true }),
          EditorView.editable.of(!props.readOnly),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && props.onChange) props.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
  });

  // Sync external value changes (e.g. the other pane drove a conversion).
  createEffect(() => {
    const v = props.value;
    if (view && v !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
    }
  });

  onCleanup(() => view?.destroy());
  return <div ref={host} class="h-full overflow-auto rounded border border-zinc-800 bg-zinc-950" />;
};
