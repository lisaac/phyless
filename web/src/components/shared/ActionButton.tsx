import { Component, JSX } from "solid-js";

// Canonical action-button style shared across container list/detail and
// compose list/detail — a background chip (not just a hover color change)
// so danger actions read as dangerous even before the pointer gets there.
export const Btn: Component<{
  onClick?: (e: MouseEvent) => void; href?: string; danger?: boolean;
  disabled?: boolean; loading?: boolean; title?: string; children: JSX.Element;
}> = (p) => {
  const cls = `px-2.5 py-1 text-xs transition-colors disabled:opacity-30 ${
    p.danger
      ? "bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20"
      : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100"
  }`;
  return p.href
    ? <a href={p.href} class={cls} title={p.title}>{p.children}</a>
    : <button class={cls} onClick={p.onClick} disabled={p.disabled || p.loading} title={p.title}>
        {p.loading ? <span class="inline-block animate-spin">↺</span> : p.children}
      </button>;
};
