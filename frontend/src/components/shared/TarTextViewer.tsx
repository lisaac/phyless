import { Component, createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Modal } from "./Modal";
import { CodeEditor } from "./CodeEditor";
import { fetchTarText, MAX_VIEW_BYTES, type TarText } from "../../api/textFile";
import { fmtBytes } from "../../api/download";

const langOf = (p: string) => (/\.ya?ml$/i.test(p) ? "yaml" : /\.json$/i.test(p) ? "json" : "text");

// Read-only viewer for a container/image file, fetched through the tar
// download endpoint. `url` null = closed. Closing (or switching file) aborts
// the in-flight stream and drops the decoded text + CodeMirror view, so
// nothing from a previous file stays referenced.
export const TarTextViewer: Component<{ url: string | null; path: string; onClose: () => void }> = (props) => {
  const [result, setResult] = createSignal<TarText | null>(null);
  const [error, setError] = createSignal("");

  createEffect(() => {
    const url = props.url;
    setResult(null);
    setError("");
    if (!url) return;
    const c = new AbortController();
    onCleanup(() => c.abort());
    fetchTarText(url, c.signal)
      .then((r) => { if (!c.signal.aborted) r ? setResult(r) : setError("未授权"); })
      .catch((e) => { if (!c.signal.aborted) setError((e as Error).message); });
  });

  const text = () => { const r = result(); return r?.kind === "text" ? r : null; };

  return (
    <Modal open={!!props.url} onClose={props.onClose} title={props.path} wide priority>
      <div class="p-3">
        <Show when={error()}>
          <p class="py-6 text-center text-sm text-red-400">{error()}</p>
        </Show>
        <Show when={!error() && !result()}>
          <p class="py-12 text-center text-xs text-zinc-500">加载中…</p>
        </Show>
        <Show when={result()?.kind === "binary"}>
          <p class="py-6 text-center text-sm text-zinc-400">二进制文件，无法预览，请下载查看</p>
        </Show>
        <Show when={result()?.kind === "dir"}>
          <p class="py-6 text-center text-sm text-zinc-400">这是一个目录</p>
        </Show>
        <Show when={(() => { const r = result(); return r?.kind === "link" ? r : null; })()}>
          {(r) => <p class="py-6 text-center font-mono text-sm text-zinc-400">链接 → {r().target}</p>}
        </Show>
        <Show when={text()}>
          {(t) => (
            <>
              <Show when={t().truncated}>
                <p class="mb-2 text-xs text-amber-500">文件 {fmtBytes(t().size)}，仅显示前 {fmtBytes(MAX_VIEW_BYTES)}</p>
              </Show>
              <div class="h-[70vh]">
                <CodeEditor value={t().text} language={langOf(props.path)} readOnly />
              </div>
            </>
          )}
        </Show>
      </div>
    </Modal>
  );
};
