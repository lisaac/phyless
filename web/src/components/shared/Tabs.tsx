import { For } from "solid-js";

// Canonical tab-strip style shared by every page/modal with tabs (container
// detail, compose detail, the create-container form/cmd switch, …) — an
// underline indicator on the active tab, rather than each place inventing
// its own look (a filled rounded-top chip, a colored bottom border in a
// different accent, etc).
export function Tabs<T extends string>(props: {
  tabs: { key: T; label: string; disabled?: boolean }[];
  active: T;
  onChange: (t: T) => void;
}) {
  return (
    <div class="flex gap-1 border-b border-zinc-800 text-sm">
      <For each={props.tabs}>
        {(t) => (
          <button
            disabled={t.disabled}
            class={`border-b-2 px-3 py-2 transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
              props.active === t.key
                ? "border-indigo-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
            onClick={() => !t.disabled && props.onChange(t.key)}
          >{t.label}</button>
        )}
      </For>
    </div>
  );
}
