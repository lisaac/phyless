import { Component, createSignal, Show } from "solid-js";
import { FileBrowser } from "../shared/FileBrowser";
import { CodeEditor } from "../shared/CodeEditor";
import { Button } from "../shared/Button";
import { get, getToken } from "../../api/client";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import type { FileEntry } from "../../types";

// pick CodeMirror language from extension
function langFor(name: string): "yaml" | "json" | "text" {
  if (/\.(ya?ml)$/i.test(name)) return "yaml";
  if (/\.json$/i.test(name)) return "json";
  return "text";
}

export const ConfigFilesPage: Component = () => {
  const [openPath, setOpenPath] = createSignal("");
  const [content, setContent] = createSignal("");
  const [lang, setLang] = createSignal<"yaml" | "json" | "text">("text");

  const listFiles = (sub: string) =>
    get<FileEntry[]>(`/api/config/files?path=${encodeURIComponent(sub)}`);

  const openFile = async (path: string) => {
    try {
      const text = await get<string>(`/api/config/files/content?path=${encodeURIComponent(path)}`);
      setOpenPath(path);
      setLang(langFor(path));
      setContent(text);
    } catch (e) { toast.error((e as Error).message); }
  };

  const save = async () => {
    try {
      const res = await fetch(`/api/config/files/content?path=${encodeURIComponent(openPath())}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${getToken()}`, "Content-Type": "text/plain" },
        body: content(),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.info("saved");
    } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <div class="flex gap-4">
      <div class="w-1/3">
        <h1 class="mb-3 text-xl font-semibold">配置文件</h1>
        <FileBrowser listPath={listFiles} onOpenFile={openFile} />
      </div>
      <div class="flex-1">
        <Show when={openPath()} fallback={<p class="mt-12 text-center text-zinc-500">选择一个文件</p>}>
          <div class="mb-2 flex items-center justify-between">
            <span class="font-mono text-xs text-zinc-400">{openPath()}</span>
            <Show when={hasRole("operator")}><Button variant="primary" onClick={save}>保存</Button></Show>
          </div>
          <div class="h-[70vh]"><CodeEditor value={content()} onChange={setContent} language={lang()} /></div>
        </Show>
      </div>
    </div>
  );
};
