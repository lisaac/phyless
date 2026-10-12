import { Component, createResource, Show, For, createSignal } from "solid-js";
import { get } from "../../api/client";
import type { FileEntry } from "../../types";
import { fieldCls } from "./Button";

// Directory-autocomplete text input against the host filesystem the phyless
// process itself sees (/api/fs/list) — same filesystem base_dir/compose
// paths must resolve against for `docker compose` to actually run. Typing
// filters the current directory's subdirectories by the partial last
// segment; clicking a suggestion drills one level deeper.
export const PathPicker: Component<{
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  files?: boolean;
  // Shown first while the input is blank (e.g. the configured Compose directories).
  roots?: string[];
}> = (props) => {
  const [open, setOpen] = createSignal(false);

  const dirPart = () => {
    const v = props.value;
    const idx = v.lastIndexOf("/");
    return idx >= 0 ? v.slice(0, idx + 1) || "/" : "/";
  };
  const filterPart = () => {
    const v = props.value;
    const idx = v.lastIndexOf("/");
    return idx >= 0 ? v.slice(idx + 1) : v;
  };

  const [entries] = createResource(dirPart, async (dir) => {
    try { return await get<FileEntry[]>(`/api/fs/list?path=${encodeURIComponent(dir)}`); }
    catch { return []; }
  });

  const suggestions = () =>
    (entries.loading ? [] : entries.latest ?? [])
      .filter((e) => (e.is_dir || (props.files && /\.ya?ml$/i.test(e.name))) && e.name.toLowerCase().startsWith(filterPart().toLowerCase()))
      .slice(0, 30);

  const roots = () => (props.value ? [] : props.roots ?? []);
  const pick = (entry: FileEntry) => {
    props.onChange(`${dirPart()}${entry.name}${entry.is_dir ? "/" : ""}`);
    if (!entry.is_dir) setOpen(false);
  };

  return (
    <div class="relative">
      <input
        class={fieldCls}
        value={props.value}
        placeholder={props.placeholder}
        onInput={(e) => props.onChange(e.currentTarget.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      <Show when={open() && (roots().length > 0 || suggestions().length > 0)}>
        <div class="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 shadow-2xl">
          {/* Not the selected Docker host: with a remote daemon these are still the phyless machine's files. */}
          <div class="border-b border-zinc-800 px-2.5 py-1 text-[11px] text-zinc-500">phyless 所在主机的文件（非远程 Docker 主机）</div>
          <For each={roots()}>
            {(dir, i) => (
              <button
                type="button"
                class={`block w-full truncate px-2.5 py-1.5 text-left font-mono text-sm text-indigo-400 hover:bg-zinc-800 ${i() === roots().length - 1 ? "border-b border-zinc-700" : ""}`}
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => props.onChange(dir.replace(/\/*$/, "/"))}
              >📁 {dir}</button>
            )}
          </For>
          <For each={suggestions()}>
            {(e) => (
              <button
                type="button"
                class="block w-full truncate px-2.5 py-1.5 text-left text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => pick(e)}
              >{e.is_dir ? "📁" : "📄"} {e.name}</button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};
