import { Component, Show } from "solid-js";

// Labels: system-ui (zinc-500, uppercase, 10px); values: font-mono (zinc-200).
// Shared by any detail page's read-only "基本信息" layout (containers, compose).
export const KV: Component<{ k: string; children: any }> = (p) => (
  <div class="flex min-h-[1.75rem] items-start gap-3 py-0.5">
    <dt class="w-28 shrink-0 pt-px text-[10px] uppercase tracking-widest text-zinc-400">{p.k}</dt>
    <dd class="min-w-0 flex-1 font-mono text-xs text-zinc-200">{p.children}</dd>
  </div>
);

// Section heading — aligns with KV's dt column.
export const Sec: Component<{ children: string; noLine?: boolean }> = (p) => (
  <div class="flex items-center gap-3 pt-3 pb-0.5 first:pt-0">
    <span class="w-28 shrink-0 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">{p.children}</span>
    <Show when={!p.noLine}><span class="flex-1 border-t border-zinc-800" /></Show>
  </div>
);
