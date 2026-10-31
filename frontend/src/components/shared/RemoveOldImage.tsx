import { Component } from "solid-js";

// "Delete the replaced image" for manual upgrades and auto-update policies.
// The last choice is this browser's default, like the pull mode.
const KEY = "phyless_remove_old_image";

export function getRemoveOldImage(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

export function setRemoveOldImageDefault(on: boolean): void {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* storage unavailable */ }
}

export const RemoveOldImageCheckbox: Component<{ checked: boolean; onChange: (v: boolean) => void }> = (props) => (
  <label class="mt-3 flex items-start gap-2 text-xs text-zinc-300">
    <input type="checkbox" class="mt-0.5" checked={props.checked} onChange={(e) => props.onChange(e.currentTarget.checked)} />
    <span>
      升级后删除旧镜像
      <span class="block text-zinc-500">仅在升级成功、且没有其他容器使用时删除；被其他 tag 引用的镜像会保留。</span>
    </span>
  </label>
);
