import { Component, createResource, Show, For, createSignal } from "solid-js";
import { get } from "../../api/client";
import type { FileEntry } from "../../types";

// Directory-autocomplete text input against the host filesystem the phyless
// process itself sees (/api/fs/list) — same filesystem base_dir/compose
// paths must resolve against for `docker compose` to actually run. Typing
// filters the current directory's subdirectories by the partial last
// segment; clicking a suggestion drills one level deeper.
export const PathPicker: Component<{
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
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
    (entries() ?? [])
      .filter((e) => e.is_dir && e.name.toLowerCase().startsWith(filterPart().toLowerCase()))
      .slice(0, 30);

  const pick = (name: string) => props.onChange(`${dirPart()}${name}/`);

  return (
    <div class="relative">
      <input
        class="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-500"
        value={props.value}
        placeholder={props.placeholder}
        onInput={(e) => props.onChange(e.currentTarget.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      <Show when={open() && suggestions().length > 0}>
        <div class="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 shadow-2xl">
          <For each={suggestions()}>
            {(e) => (
              <button
                type="button"
                class="block w-full truncate px-2.5 py-1.5 text-left text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => pick(e.name)}
              >📁 {e.name}</button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};
