import { Component, createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Modal } from "./Modal";
import { CodeEditor } from "./CodeEditor";
import { Button } from "./Button";
import { toast } from "./Toast";
import { confirmAction } from "./ConfirmModal";
import { fetchTarText, MAX_VIEW_BYTES, type TarText } from "../../api/textFile";
import type { TarMeta } from "../../api/dockerTar";
import { fmtBytes } from "../../api/download";

const langOf = (p: string) => (/\.ya?ml$/i.test(p) ? "yaml" : /\.json$/i.test(p) ? "json" : "text");

// Viewer/editor for a container/image/volume file, fetched through the tar
// download endpoint. `url` null = closed. With `onSave` (operator on a
// writable source) the text is editable; a truncated file stays read-only so
// a save can't cut it short. Closing (or switching file) aborts the in-flight
// stream and drops the decoded text + CodeMirror view.
export const TarTextViewer: Component<{
  url: string | null;
  path: string;
  onClose: () => void;
  onSave?: (path: string, text: string, meta?: TarMeta) => Promise<void>;
}> = (props) => {
  const [result, setResult] = createSignal<TarText | null>(null);
  const [error, setError] = createSignal("");
  const [draft, setDraft] = createSignal("");
  const [saving, setSaving] = createSignal(false);

  createEffect(() => {
    const url = props.url;
    setResult(null);
    setError("");
    if (!url) return;
    const c = new AbortController();
    onCleanup(() => c.abort());
    fetchTarText(url, c.signal)
      .then((r) => {
        if (c.signal.aborted) return;
        if (!r) return setError("未授权");
        setResult(r);
        if (r.kind === "text") setDraft(r.text);
      })
      .catch((e) => { if (!c.signal.aborted) setError((e as Error).message); });
  });

  const text = () => { const r = result(); return r?.kind === "text" ? r : null; };
  const editable = () => !!props.onSave && !!text() && !text()!.truncated;
  const dirty = () => editable() && draft() !== text()!.text;

  const save = async () => {
    const t = text();
    if (!t || !props.onSave || saving() || !dirty()) return;
    setSaving(true);
    try {
      const saved = draft();
      await props.onSave(props.path, saved, t.meta);
      setResult({ ...t, text: saved, size: new TextEncoder().encode(saved).byteLength });
      toast.success("已保存");
    } catch (e) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  let asking = false; // Esc while the confirm is up must not stack another one
  const close = async () => {
    if (asking) return;
    if (dirty()) {
      asking = true;
      const ok = await confirmAction("修改尚未保存，确定放弃？", { title: "放弃修改", confirmText: "放弃", danger: true });
      asking = false;
      if (!ok) return;
    }
    props.onClose();
  };

  return (
    <Modal open={!!props.url} onClose={close} title={`${props.path}${dirty() ? " •" : ""}`} wide priority noBackdropClose={dirty()}>
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
                <p class="mb-2 text-xs text-amber-500">
                  文件 {fmtBytes(t().size)}，仅显示前 {fmtBytes(MAX_VIEW_BYTES)}{props.onSave ? "，已禁用编辑以免截断覆盖原文件" : ""}
                </p>
              </Show>
              <div class="h-[70vh]">
                <CodeEditor
                  value={draft()}
                  onChange={setDraft}
                  language={langOf(props.path)}
                  readOnly={!editable()}
                  onSave={editable() ? save : undefined}
                />
              </div>
              <Show when={editable()}>
                <div class="mt-3 flex justify-end gap-2">
                  <Button onClick={close}>关闭</Button>
                  <Button variant="primary" disabled={!dirty() || saving()} onClick={save}>
                    {saving() ? "保存中…" : "保存"}
                  </Button>
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>
    </Modal>
  );
};
