import { Component, createSignal, createResource, For, Show } from "solid-js";
import { Button } from "./Button";
import type { FileEntry } from "../../types";

export const FileBrowser: Component<{
  listPath: (sub: string) => Promise<FileEntry[]>;
  downloadURL?: (sub: string) => string;
  onUpload?: (sub: string, file: File) => Promise<void>;
  onOpenFile?: (fullSubPath: string) => void;
}> = (props) => {
  const [path, setPath] = createSignal("/");
  const [entries, { refetch }] = createResource(path, (p) => props.listPath(p));

  const enter = (e: FileEntry) => {
    const full = (path().endsWith("/") ? path() : path() + "/") + e.name;
    if (e.is_dir) setPath(full);
    else props.onOpenFile?.(full.replace(/^\/+/, "/"));
  };
  const up = () => setPath((p) => p.replace(/\/[^/]+\/?$/, "") || "/");

  const upload = async (file: File | undefined) => {
    if (file && props.onUpload) { await props.onUpload(path(), file); refetch(); }
  };

  return (
    <div>
      <div class="mb-2 flex items-center gap-2">
        <Button onClick={up}>⬆ 上级</Button>
        <span class="font-mono text-xs text-zinc-400">{path()}</span>
        <Show when={props.onUpload}>
          <label class="ml-auto cursor-pointer rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700">
            上传
            <input type="file" class="hidden" onChange={(e) => upload(e.currentTarget.files?.[0])} />
          </label>
        </Show>
      </div>
      <Show when={!entries.error} fallback={<p class="text-sm text-red-400">{String(entries.error)}</p>}>
        <table class="w-full text-left text-sm">
          <tbody>
            <For each={entries() ?? []}>
              {(e) => (
                <tr class="border-b border-zinc-900 hover:bg-zinc-900">
                  <td class="cursor-pointer px-2 py-1" onClick={() => enter(e)}>
                    {e.is_dir ? "📁" : "📄"} {e.name}
                  </td>
                  <td class="px-2 py-1 text-right text-xs text-zinc-500">{e.is_dir ? "" : `${e.size} B`}</td>
                  <td class="px-2 py-1 text-right">
                    <Show when={!e.is_dir && props.downloadURL}>
                      <a class="text-blue-400 hover:underline" href={props.downloadURL!(path().replace(/\/$/, "") + "/" + e.name)}>下载</a>
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
};
