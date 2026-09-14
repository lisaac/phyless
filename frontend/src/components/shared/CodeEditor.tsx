import { Component, onMount, onCleanup, createEffect, createSignal } from "solid-js";
import { EditorView, keymap, highlightWhitespace } from "@codemirror/view";
import { EditorState, Transaction, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import { json } from "@codemirror/lang-json";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

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
  // Whitespace dots (highlightWhitespace) default to near-invisible — nudge
  // them to a faint but legible zinc so the effect is actually visible.
  ".cm-highlightSpace::before": { color: "#3f3f46" },
}, { dark: true });

const lightTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "#fafafa" },
  ".cm-scroller": { backgroundColor: "#fafafa" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#3f3f46" },
  ".cm-content": { caretColor: "#3f3f46", color: "#18181b" },
  ".cm-line": { color: "#18181b" },
  ".cm-highlightSpace::before": { color: "#d4d4d8" },
});

// Colors keyed to the app's own zinc/indigo/emerald palette rather than a
// generic theme, so yaml/json editing looks native to the rest of the UI.
const darkHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: t.keyword, color: "#818cf8" },
  { tag: [t.string, t.special(t.string)], color: "#34d399" },
  { tag: t.number, color: "#fbbf24" },
  { tag: [t.bool, t.null], color: "#f472b6" },
  { tag: t.comment, color: "#71717a", fontStyle: "italic" },
  { tag: [t.propertyName, t.attributeName, t.definition(t.propertyName)], color: "#7dd3fc" },
  { tag: t.punctuation, color: "#a1a1aa" },
  { tag: t.invalid, color: "#f87171" },
]));

const lightHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: t.keyword, color: "#4f46e5" },
  { tag: [t.string, t.special(t.string)], color: "#059669" },
  { tag: t.number, color: "#b45309" },
  { tag: [t.bool, t.null], color: "#db2777" },
  { tag: t.comment, color: "#71717a", fontStyle: "italic" },
  { tag: [t.propertyName, t.attributeName, t.definition(t.propertyName)], color: "#0369a1" },
  { tag: t.punctuation, color: "#52525b" },
  { tag: t.invalid, color: "#dc2626" },
]));

export const CodeEditor: Component<{
  value: string;
  onChange?: (v: string) => void;
  language?: Lang;
  readOnly?: boolean;
}> = (props) => {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  const themeCompartment = new Compartment();
  const highlightCompartment = new Compartment();
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
          highlightCompartment.of(isDark() ? darkHighlight : lightHighlight),
          highlightWhitespace(),
          EditorView.editable.of(!props.readOnly),
          EditorView.updateListener.of((u) => {
            // Only fire onChange for user-initiated edits (input, paste, delete).
            if (
              u.docChanged &&
              props.onChange &&
              u.transactions.some((tr) => tr.annotation(Transaction.userEvent))
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
        effects: [
          themeCompartment.reconfigure(dark ? darkTheme : lightTheme),
          highlightCompartment.reconfigure(dark ? darkHighlight : lightHighlight),
        ],
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
