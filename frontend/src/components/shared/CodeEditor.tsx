import { Component, onMount, onCleanup, createEffect, createSignal, Show, For } from "solid-js";
import { Portal } from "solid-js/web";
import {
  EditorView, keymap, highlightWhitespace, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, highlightSpecialChars, rectangularSelection, crosshairCursor,
} from "@codemirror/view";
import { EditorState, EditorSelection, Transaction, Compartment } from "@codemirror/state";
import {
  defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, undoDepth, redoDepth, selectAll, indentMore, indentLess,
  toggleComment, copyLineDown, deleteLine, moveLineUp, moveLineDown, deleteTrailingWhitespace,
} from "@codemirror/commands";
import {
  searchKeymap, highlightSelectionMatches, openSearchPanel, closeSearchPanel, searchPanelOpen, gotoLine, selectSelectionMatches,
} from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { yaml } from "@codemirror/lang-yaml";
import { json } from "@codemirror/lang-json";
import {
  syntaxHighlighting, HighlightStyle, foldGutter, foldKeymap, indentOnInput, bracketMatching, indentUnit, foldAll, unfoldAll,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { toast } from "./Toast";
import { copyToClipboard } from "../../api/clipboard";

type Lang = "yaml" | "json" | "text";

function langExt(lang: Lang) {
  if (lang === "yaml") return [yaml()];
  if (lang === "json") return [json()];
  return [];
}

// CodeMirror's built-in UI strings (search panel, folding, go-to-line) in Chinese.
const zhPhrases = EditorState.phrases.of({
  "Find": "查找", "Replace": "替换", "next": "下一个", "previous": "上一个", "all": "全部",
  "match case": "区分大小写", "regexp": "正则", "by word": "全词", "replace": "替换", "replace all": "全部替换",
  "close": "关闭", "current match": "当前匹配", "on line": "行", "replaced match on line $": "已替换第 $ 行的匹配",
  "replaced $ matches": "已替换 $ 处", "Go to line": "跳转到行", "go": "跳转",
  "Folded lines": "已折叠", "Unfolded lines": "已展开", "to": "至", "folded code": "折叠的代码",
  "Fold line": "折叠", "Unfold line": "展开", "Control character": "控制字符", "Selection deleted": "已删除选区",
});

// Panel (查找/替换) chrome — CodeMirror's defaults are light-only.
const panelTheme = (bg: string, fg: string, field: string, border: string) => ({
  ".cm-panels": { backgroundColor: bg, color: fg, borderColor: border },
  ".cm-panels.cm-panels-top": { borderBottom: `1px solid ${border}` },
  ".cm-panels.cm-panels-bottom": { borderTop: `1px solid ${border}` },
  ".cm-search": { fontSize: "12px" },
  ".cm-textfield": { backgroundColor: field, color: fg, border: `1px solid ${border}`, borderRadius: "4px" },
  ".cm-button": { backgroundImage: "none", backgroundColor: field, color: fg, border: `1px solid ${border}`, borderRadius: "4px" },
  ".cm-panel button[name=close]": { color: fg },
  ".cm-searchMatch": { backgroundColor: "#eab30840", outline: "1px solid #eab30880" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#6366f160" },
  ".cm-panel.cm-gotoLine": { fontSize: "12px" },
  ".cm-foldPlaceholder": { backgroundColor: field, border: `1px solid ${border}`, color: fg },
});

const darkTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "#09090b" },
  ".cm-scroller": { backgroundColor: "#09090b" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#a1a1aa" },
  ".cm-content": { caretColor: "#a1a1aa", color: "#e4e4e7" },
  ".cm-line": { color: "#e4e4e7" },
  // Whitespace dots (highlightWhitespace) default to near-invisible — nudge
  // them to a faint but legible zinc so the effect is actually visible.
  ".cm-highlightSpace::before": { color: "#3f3f46" },
  ".cm-gutters": { backgroundColor: "#09090b", border: "none", color: "#52525b" },
  ".cm-activeLine": { backgroundColor: "#18181b" },
  ".cm-activeLineGutter": { backgroundColor: "#18181b", color: "#a1a1aa" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "#3730a3aa" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "#3f3f46", outline: "1px solid #71717a" },
  ...panelTheme("#18181b", "#e4e4e7", "#27272a", "#3f3f46"),
}, { dark: true });

const lightTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "#fafafa" },
  ".cm-scroller": { backgroundColor: "#fafafa" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#3f3f46" },
  ".cm-content": { caretColor: "#3f3f46", color: "#18181b" },
  ".cm-line": { color: "#18181b" },
  ".cm-highlightSpace::before": { color: "#d4d4d8" },
  ".cm-gutters": { backgroundColor: "#fafafa", border: "none", color: "#a1a1aa" },
  ".cm-activeLine": { backgroundColor: "#f4f4f5" },
  ".cm-activeLineGutter": { backgroundColor: "#f4f4f5", color: "#52525b" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "#c7d2fe" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "#e4e4e7", outline: "1px solid #a1a1aa" },
  ...panelTheme("#f4f4f5", "#18181b", "#ffffff", "#d4d4d8"),
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

// Font size (A−/A+) is a per-viewer preference shared by every editor.
const FONT_KEY = "phyless_editor_font";
const readFont = () => { try { return Number(localStorage.getItem(FONT_KEY)) || 13; } catch { return 13; } };
const fontTheme = (px: number) => EditorView.theme({ "& .cm-scroller": { fontSize: `${px}px` } });
// The editor is a shrinkable flex item of its host, so it fills a fixed-height
// parent and stops (then scrolls) at a max-height one (JsonView's 70vh).
const fitTheme = EditorView.theme({ "&": { flex: "1 1 auto", minHeight: "0" } });

type Cmd = (v: EditorView) => boolean;
type MenuItem = { label: string; icon: string; hint?: string; run: Cmd; show?: boolean; off?: boolean } | "sep";

// Selection transforms dispatched as user input, so onChange (which only
// reports user events) and the "unsaved" marker see them.
const mapSelection = (f: (s: string) => string): Cmd => (v) => {
  if (v.state.selection.ranges.every((r) => r.empty)) return false;
  v.dispatch(v.state.changeByRange((r) => {
    const text = f(v.state.sliceDoc(r.from, r.to));
    return { changes: { from: r.from, to: r.to, insert: text }, range: EditorSelection.range(r.from, r.from + text.length) };
  }), { userEvent: "input" });
  return true;
};
const selectedText = (v: EditorView) =>
  v.state.selection.ranges.filter((r) => !r.empty).map((r) => v.state.sliceDoc(r.from, r.to)).join("\n");
const copy: Cmd = (v) => {
  const text = selectedText(v);
  if (!text) return false;
  void copyToClipboard(text).then((ok) => { if (!ok) toast.error("复制失败"); });
  return true;
};
// Toolbar 复制: the selection, or the whole text when nothing is selected.
const copyAll: Cmd = (v) => {
  const text = selectedText(v) || v.state.doc.toString();
  void copyToClipboard(text).then((ok) => (ok ? toast.success(selectedText(v) ? "已复制选中内容" : "已复制全部内容") : toast.error("复制失败")));
  return true;
};
const cut: Cmd = (v) => {
  if (!copy(v)) return false;
  v.dispatch(v.state.replaceSelection(""), { userEvent: "delete.cut" });
  return true;
};
const paste: Cmd = (v) => {
  // Needs a secure context (https/localhost); Ctrl/⌘+V always works.
  if (!navigator.clipboard || !window.isSecureContext) {
    toast.error("浏览器不允许读取剪贴板，请使用 Ctrl/⌘+V");
    return true;
  }
  navigator.clipboard.readText()
    .then((text) => v.dispatch(v.state.replaceSelection(text), { userEvent: "input.paste" }))
    .catch(() => toast.error("浏览器不允许读取剪贴板，请使用 Ctrl/⌘+V"));
  return true;
};
const formatJson: Cmd = (v) => {
  try {
    const text = JSON.stringify(JSON.parse(v.state.doc.toString()), null, 2) + "\n";
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, userEvent: "input.format" });
  } catch (e) { toast.error(`JSON 格式错误：${(e as Error).message}`); }
  return true;
};
const openReplace: Cmd = (v) => {
  openSearchPanel(v);
  v.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]")?.focus();
  return true;
};

// The one text editor of the app — compose/run/config/file editing and every
// read-only viewer (Inspect JSON, container file viewer) go through it, so they
// all get the same line numbers, indenting, search/replace, toolbar and
// right-click menu. Shortcuts: Ctrl/⌘+F 查找, Ctrl/⌘+Alt+G 跳转行,
// Ctrl/⌘+/ 注释, Tab/Shift+Tab 缩进, Ctrl/⌘+S → onSave.
// (Esc then Tab moves focus out, per CodeMirror's a11y rule.)
export const CodeEditor: Component<{
  value: string;
  onChange?: (v: string) => void;
  language?: Lang;
  readOnly?: boolean;
  onSave?: () => void;
}> = (props) => {
  let host!: HTMLDivElement;
  let menuEl: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  const themeCompartment = new Compartment();
  const highlightCompartment = new Compartment();
  const wrapCompartment = new Compartment();
  const spaceCompartment = new Compartment();
  const fontCompartment = new Compartment();
  const editable = !props.readOnly;
  const lang = props.language ?? "text";
  const [isDark, setIsDark] = createSignal(
    document.documentElement.classList.contains("dark")
  );
  const [wrap, setWrap] = createSignal(false);
  const [spaces, setSpaces] = createSignal(editable);
  const [font, setFont] = createSignal(readFont());
  const [searching, setSearching] = createSignal(false);
  const [history$, setHistory] = createSignal({ undo: 0, redo: 0 });
  const [cursor, setCursor] = createSignal({ line: 1, col: 1, sel: 0, lines: 1 });
  const [menu, setMenu] = createSignal<{ x: number; y: number } | null>(null);

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          zhPhrases,
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter(),
          highlightSpecialChars(),
          drawSelection(),
          rectangularSelection(),
          crosshairCursor(),
          bracketMatching(),
          highlightSelectionMatches(),
          indentUnit.of("  "),
          EditorState.tabSize.of(2),
          history(),
          ...(editable ? [highlightActiveLine(), indentOnInput(), closeBrackets()] : []),
          keymap.of([
            ...(props.onSave ? [{ key: "Mod-s", preventDefault: true, run: () => { props.onSave?.(); return true; } }] : []),
            ...(editable ? [...closeBracketsKeymap, indentWithTab] : []),
            ...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap,
          ]),
          ...langExt(lang),
          themeCompartment.of(isDark() ? darkTheme : lightTheme),
          highlightCompartment.of(isDark() ? darkHighlight : lightHighlight),
          wrapCompartment.of([]),
          spaceCompartment.of(spaces() ? highlightWhitespace() : []),
          fontCompartment.of(fontTheme(font())),
          fitTheme,
          EditorState.readOnly.of(!editable),
          // Not contenteditable when read-only, so tapping a viewer on a phone doesn't raise the keyboard.
          EditorView.editable.of(editable),
          EditorView.updateListener.of((u) => {
            setSearching(searchPanelOpen(u.state));
            if (u.docChanged || u.selectionSet) {
              const head = u.state.selection.main.head;
              const line = u.state.doc.lineAt(head);
              const sel = u.state.selection.ranges.reduce((n, r) => n + r.to - r.from, 0);
              setCursor({ line: line.number, col: head - line.from + 1, sel, lines: u.state.doc.lines });
              setHistory({ undo: undoDepth(u.state), redo: redoDepth(u.state) });
            }
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
    setCursor((c) => ({ ...c, lines: view!.state.doc.lines }));

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

  // Context menu: any click elsewhere, scroll, resize or Esc closes it.
  createEffect(() => {
    if (!menu()) return;
    const close = (e: Event) => { if (!(e.target instanceof Node && menuEl?.contains(e.target))) setMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setMenu(null); } };
    const onBlur = () => setMenu(null);
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("wheel", close, true);
    window.addEventListener("resize", onBlur);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("resize", onBlur);
      window.removeEventListener("keydown", onKey, true);
    });
  });

  onCleanup(() => view?.destroy());

  // Toolbar/menu commands keep the editor focused (so a tap on a phone doesn't
  // lose the cursor) — except ones that open a panel with its own input.
  const run = (cmd: Cmd, refocus = true) => () => {
    setMenu(null);
    if (view) { cmd(view); if (refocus) view.focus(); }
  };
  const toggleWrap = () => {
    const on = !wrap();
    setWrap(on);
    view?.dispatch({ effects: wrapCompartment.reconfigure(on ? EditorView.lineWrapping : []) });
  };
  const toggleSpaces = () => {
    const on = !spaces();
    setSpaces(on);
    view?.dispatch({ effects: spaceCompartment.reconfigure(on ? highlightWhitespace() : []) });
  };
  const zoom = (d: number) => {
    const px = Math.min(24, Math.max(10, font() + d));
    setFont(px);
    try { localStorage.setItem(FONT_KEY, String(px)); } catch { /* per-viewer convenience only */ }
    view?.dispatch({ effects: fontCompartment.reconfigure(fontTheme(px)) });
  };
  const hasSel = () => cursor().sel > 0;

  const menuItems = (): MenuItem[] => [
    { label: "撤销", icon: "↶", hint: "Ctrl+Z", run: undo, show: editable, off: !history$().undo },
    { label: "重做", icon: "↷", hint: "Ctrl+Shift+Z", run: redo, show: editable, off: !history$().redo },
    "sep",
    { label: "剪切", icon: "✂", hint: "Ctrl+X", run: cut, show: editable && hasSel() },
    { label: "复制", icon: "⧉", hint: "Ctrl+C", run: copy, show: hasSel() },
    { label: "粘贴", icon: "⎘", hint: "Ctrl+V", run: paste, show: editable },
    { label: "全选", icon: "▣", hint: "Ctrl+A", run: selectAll },
    "sep",
    { label: "查找", icon: "⌕", hint: "Ctrl+F", run: openSearchPanel },
    { label: "替换", icon: "⇄", run: openReplace, show: editable },
    { label: "跳转到行", icon: "↧", hint: "Ctrl+Alt+G", run: gotoLine },
    { label: "选中所有相同项", icon: "≡", hint: "Ctrl+Shift+L", run: selectSelectionMatches, show: hasSel() },
    "sep",
    { label: "增加缩进", icon: "⇥", hint: "Tab", run: indentMore, show: editable },
    { label: "减少缩进", icon: "⇤", hint: "Shift+Tab", run: indentLess, show: editable },
    { label: "切换注释", icon: "#", hint: "Ctrl+/", run: toggleComment, show: editable && lang === "yaml" },
    { label: "复制当前行", icon: "⇊", hint: "Shift+Alt+↓", run: copyLineDown, show: editable },
    { label: "上移行", icon: "↑", hint: "Alt+↑", run: moveLineUp, show: editable },
    { label: "下移行", icon: "↓", hint: "Alt+↓", run: moveLineDown, show: editable },
    { label: "删除行", icon: "✕", hint: "Ctrl+Shift+K", run: deleteLine, show: editable },
    "sep",
    { label: "转为大写", icon: "Aa", run: mapSelection((s) => s.toUpperCase()), show: editable && hasSel() },
    { label: "转为小写", icon: "aA", run: mapSelection((s) => s.toLowerCase()), show: editable && hasSel() },
    { label: "去除行尾空格", icon: "␣", run: deleteTrailingWhitespace, show: editable },
    { label: "格式化 JSON", icon: "{}", run: formatJson, show: editable && lang === "json" },
    "sep",
    { label: "全部折叠", icon: "⊟", hint: "Ctrl+Alt+[", run: foldAll },
    { label: "全部展开", icon: "⊞", hint: "Ctrl+Alt+]", run: unfoldAll },
  ];
  // Drop hidden items and any separator that would lead, trail or double up.
  const visibleMenu = () => menuItems()
    .filter((i) => i === "sep" || i.show !== false)
    .filter((i, n, all) => i !== "sep" || (n > 0 && n < all.length - 1 && all[n - 1] !== "sep"));

  const openMenu = (e: MouseEvent) => {
    e.preventDefault();
    // Right-click outside the selection moves the cursor there first, like a native editor.
    const pos = view?.posAtCoords({ x: e.clientX, y: e.clientY });
    if (view && pos != null && !view.state.selection.ranges.some((r) => pos >= r.from && pos <= r.to)) {
      view.dispatch({ selection: { anchor: pos } });
    }
    // Clamp into the viewport once the menu has a size.
    setMenu({ x: e.clientX, y: e.clientY });
    requestAnimationFrame(() => {
      if (!menuEl) return;
      const r = menuEl.getBoundingClientRect();
      setMenu({
        x: Math.max(4, Math.min(e.clientX, window.innerWidth - r.width - 4)),
        y: Math.max(4, Math.min(e.clientY, window.innerHeight - r.height - 4)),
      });
    });
  };

  // Same glyph-plus-text look as FileBrowser's toolbar (↑ 上传, ⧉ 独立窗口);
  // a toggle that is on gets the indigo tint.
  const tool = (on?: boolean) =>
    `shrink-0 px-2 py-0.5 text-xs transition-colors disabled:opacity-30 ${on ? "bg-indigo-500/15 text-indigo-300" : "text-zinc-500 hover:text-zinc-200"}`;

  return (
    <div
      class={`flex h-full flex-col overflow-hidden rounded-md border ${
        isDark() ? "border-zinc-700 bg-zinc-950" : "border-zinc-300 bg-zinc-50"
      }`}
    >
      <div class={`flex shrink-0 flex-wrap items-center gap-y-0.5 border-b px-1 py-0.5 ${isDark() ? "border-zinc-800" : "border-zinc-200"}`}>
        <Show when={editable}>
          <button class={tool()} title="撤销 (Ctrl/⌘+Z)" disabled={!history$().undo} onClick={run(undo)}>↶ 撤销</button>
          <button class={tool()} title="重做 (Ctrl/⌘+Shift+Z)" disabled={!history$().redo} onClick={run(redo)}>↷ 重做</button>
        </Show>
        <button class={tool()} title="复制选中内容；未选中时复制全部" onClick={run(copyAll)}>⧉ 复制</button>
        <button class={tool(searching())} title="查找 / 替换 (Ctrl/⌘+F)" onClick={run(searching() ? closeSearchPanel : openSearchPanel, searching())}>
          ⌕ {editable ? "查找替换" : "查找"}
        </button>
        <button class={tool()} title="跳转到行 (Ctrl/⌘+Alt+G)" onClick={run(gotoLine, false)}>↧ 跳转</button>
        <Show when={editable && lang === "json"}>
          <button class={tool()} title="格式化 JSON（2 空格缩进）" onClick={run(formatJson)}>{"{}"} 格式化</button>
        </Show>
        <button class={tool()} title="全部折叠" onClick={run(foldAll)}>⊟ 折叠</button>
        <button class={tool()} title="全部展开" onClick={run(unfoldAll)}>⊞ 展开</button>
        <button class={tool(wrap())} title="自动换行" onClick={toggleWrap}>↵ 换行</button>
        <button class={tool(spaces())} title="显示空格与制表符" onClick={toggleSpaces}>␣ 空白</button>
        <button class={tool()} title="缩小字号" disabled={font() <= 10} onClick={() => zoom(-1)}>A−</button>
        <button class={tool()} title="放大字号" disabled={font() >= 24} onClick={() => zoom(1)}>A+</button>
        <span class="ml-auto shrink-0 px-2 font-mono text-[11px] text-zinc-500" title="光标位置 / 选中字符数 / 总行数">
          行 {cursor().line}，列 {cursor().col}
          <Show when={cursor().sel}>（选中 {cursor().sel}）</Show>
          {" · 共 "}{cursor().lines} 行
          <Show when={props.onSave}>{" · Ctrl/⌘+S 保存"}</Show>
        </span>
      </div>
      <div ref={host} class="flex min-h-0 flex-1 flex-col overflow-hidden" onContextMenu={openMenu} />
      <Show when={menu()}>
        {(m) => (
          <Portal>
            <div
              ref={menuEl}
              role="menu"
              class="fixed z-[70] max-h-[80vh] min-w-[12rem] overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 py-1 text-xs text-zinc-300 shadow-2xl"
              style={{ left: `${m().x}px`, top: `${m().y}px` }}
              onContextMenu={(e) => e.preventDefault()}
            >
              <For each={visibleMenu()}>
                {(item) => item === "sep"
                  ? <div class="my-1 border-t border-zinc-800" />
                  : (
                    <button
                      role="menuitem"
                      disabled={item.off}
                      class="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:pointer-events-none disabled:opacity-30"
                      onClick={run(item.run, item.run !== openSearchPanel && item.run !== openReplace && item.run !== gotoLine)}
                    >
                      <span class="w-4 shrink-0 text-center text-zinc-500">{item.icon}</span>
                      <span class="flex-1">{item.label}</span>
                      <Show when={item.hint}><span class="font-mono text-[10px] text-zinc-500">{item.hint}</span></Show>
                    </button>
                  )}
              </For>
            </div>
          </Portal>
        )}
      </Show>
    </div>
  );
};
