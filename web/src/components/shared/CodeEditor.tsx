import { Component, onMount, onCleanup, createEffect, createSignal } from "solid-js";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Transaction, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import { json } from "@codemirror/lang-json";

type Lang = "yaml" | "json" | "text";

function langExt(lang: Lang) {
  if (lang === "yaml") return [yaml()];
  if (lang === "json") return [json()];
  return [];
}

const darkTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "#09090b" },
  ".cm-scroller": { backgroundColor: "#09090b" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#a1a1aa" },
  ".cm-content": { caretColor: "#a1a1aa", color: "#e4e4e7" },
  ".cm-line": { color: "#e4e4e7" },
}, { dark: true });

const lightTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "#fafafa" },
  ".cm-scroller": { backgroundColor: "#fafafa" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#3f3f46" },
  ".cm-content": { caretColor: "#3f3f46", color: "#18181b" },
  ".cm-line": { color: "#18181b" },
});

export const CodeEditor: Component<{
  value: string;
  onChange?: (v: string) => void;
  language?: Lang;
  readOnly?: boolean;
}> = (props) => {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  const themeCompartment = new Compartment();
  const [isDark, setIsDark] = createSignal(
    document.documentElement.classList.contains("dark")
  );

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          ...langExt(props.language ?? "text"),
          themeCompartment.of(isDark() ? darkTheme : lightTheme),
          EditorView.editable.of(!props.readOnly),
          EditorView.updateListener.of((u) => {
            // Only fire onChange for user-initiated edits (input, paste, delete).
            if (
              u.docChanged &&
              props.onChange &&
              u.transactions.some((t) => t.annotation(Transaction.userEvent))
            ) {
              props.onChange(u.state.doc.toString());
            }
          }),
        ],
      }),
    });

    // Watch <html class="dark"> changes and swap theme live
    const observer = new MutationObserver(() => {
      const dark = document.documentElement.classList.contains("dark");
      setIsDark(dark);
      view?.dispatch({
        effects: themeCompartment.reconfigure(dark ? darkTheme : lightTheme),
      });
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    onCleanup(() => observer.disconnect());
  });

  // Sync external value changes (e.g. the other pane drove a conversion).
  createEffect(() => {
    const v = props.value;
    if (view && v !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
    }
  });

  onCleanup(() => view?.destroy());

  return (
    <div
      ref={host}
      class={`h-full overflow-auto rounded-md border ${
        isDark() ? "border-zinc-700 bg-zinc-950" : "border-zinc-300 bg-zinc-50"
      }`}
    />
  );
};
