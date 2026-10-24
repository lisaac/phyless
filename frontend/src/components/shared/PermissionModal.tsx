import { Component, createSignal, For, Show } from "solid-js";
import { Button, fieldCls } from "./Button";
import { Modal } from "./Modal";
import type { FileEntry } from "../../types";

// What every writable file source's chmod endpoint takes; "" leaves it as is.
export interface ChmodBody { path: string; mode?: string; owner?: string; recursive?: boolean }

// "drwsr-sr-t" → "7755"-style octal (special bits only when set).
export function modeToOctal(ls: string): string {
  const r = ls.slice(1, 10);
  if (r.length !== 9) return "";
  let n = 0, special = 0;
  for (let i = 0; i < 9; i++) {
    const c = r[i], bit = 1 << (8 - i);
    if (c !== "-" && c !== "S" && c !== "T") n |= bit;
    if (i % 3 === 2 && "sStT".includes(c)) special |= 4 >> (i / 3 | 0);
  }
  const oct = n.toString(8).padStart(3, "0");
  return special ? special + oct : oct;
}

const ROWS = ["所有者", "组", "其他"];
const COLS = ["读", "写", "执行"];

type Pending = { entry: FileEntry; path: string; resolve: (b: ChmodBody | null) => void };
const [pending, setPending] = createSignal<Pending | null>(null);

/** Asks for a new mode/owner of entry; null when cancelled or unchanged. */
export const editPermissions = (entry: FileEntry, path: string) => new Promise<ChmodBody | null>((resolve) => {
  pending()?.resolve(null);
  setPending({ entry, path, resolve });
});

export const PermissionModal: Component = () => (
  <Show when={pending()} keyed>
    {(p) => <PermissionForm {...p} />}
  </Show>
);

const PermissionForm: Component<Pending> = (props) => {
  const mode0 = modeToOctal(props.entry.mode ?? "");
  const owner0 = props.entry.uid != null ? `${props.entry.uid}${props.entry.gid != null ? `:${props.entry.gid}` : ""}` : "";
  const [mode, setMode] = createSignal(mode0);
  const [owner, setOwner] = createSignal(owner0);
  const [recursive, setRecursive] = createSignal(false);
  const validMode = () => /^[0-7]{3,4}$/.test(mode());
  const validOwner = () => owner() === "" || /^[0-9]+(:[0-9]+)?$/.test(owner());
  const bits = () => (validMode() ? parseInt(mode(), 8) : 0);
  const toggle = (bit: number) => {
    const n = bits() ^ bit;
    const special = n >> 9;
    setMode((special ? special.toString(8) : "") + (n & 0o777).toString(8).padStart(3, "0"));
  };
  const done = (b: ChmodBody | null) => { setPending(null); props.resolve(b); };
  const submit = () => {
    const body: ChmodBody = { path: props.path };
    if (mode() !== mode0 || recursive()) body.mode = mode();
    if (owner() && (owner() !== owner0 || recursive())) body.owner = owner();
    done(body.mode || body.owner ? { ...body, recursive: recursive() || undefined } : null);
  };

  return (
    <Modal open onClose={() => done(null)} title={`权限：${props.entry.name}`} priority>
      <table class="mb-3 w-full text-center text-xs text-zinc-400">
        <thead><tr><th /><For each={COLS}>{(c) => <th class="pb-1 font-normal">{c}</th>}</For></tr></thead>
        <tbody>
          <For each={ROWS}>
            {(row, r) => (
              <tr>
                <td class="py-1 text-left">{row}</td>
                <For each={COLS}>
                  {(col, c) => {
                    const bit = 1 << (8 - (r() * 3 + c()));
                    return <td><input type="checkbox" aria-label={`${row}${col}`} checked={!!(bits() & bit)} disabled={!validMode()} onChange={() => toggle(bit)} /></td>;
                  }}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <label class="mb-3 block text-sm text-zinc-300">
        权限（八进制）
        <input class={`mt-1 font-mono ${fieldCls}`} inputMode="numeric" value={mode()} onInput={(e) => setMode(e.currentTarget.value.trim())} />
      </label>
      <label class="mb-3 block text-sm text-zinc-300">
        所有者 uid:gid
        <input class={`mt-1 font-mono ${fieldCls}`} placeholder="1000:1000" value={owner()} onInput={(e) => setOwner(e.currentTarget.value.trim())} />
      </label>
      <Show when={props.entry.is_dir}>
        <label class="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={recursive()} onChange={(e) => setRecursive(e.currentTarget.checked)} />
          应用到目录下所有文件（-R）
        </label>
      </Show>
      <Show when={!validMode() || !validOwner()}>
        <p class="mt-3 text-xs text-red-400">{!validMode() ? "权限须为 3 或 4 位八进制数，如 755" : "所有者须为数字 uid 或 uid:gid"}</p>
      </Show>
      <div class="mt-5 flex justify-end gap-2">
        <Button onClick={() => done(null)}>取消</Button>
        <Button variant="primary" disabled={!validMode() || !validOwner()} onClick={submit}>应用</Button>
      </div>
    </Modal>
  );
};
