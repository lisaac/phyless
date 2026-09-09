import { Component, JSX } from "solid-js";

// Canonical action-button style shared across container list/detail and
// compose list/detail — transparent by default (no background/border), a
// background only appears on hover. Danger actions stay red at rest so
// they're still distinguishable before the pointer arrives.
export const Btn: Component<{
  onClick?: (e: MouseEvent) => void; href?: string; danger?: boolean;
  disabled?: boolean; loading?: boolean; title?: string; children: JSX.Element;
}> = (p) => {
  const cls = `px-2.5 py-1 text-xs transition-colors disabled:opacity-30 ${
    p.danger
      ? "text-red-400 hover:bg-red-900/40 hover:text-red-300"
      : "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
  }`;
  return p.href
    ? <a href={p.href} class={cls} title={p.title}>{p.children}</a>
    : <button class={cls} onClick={p.onClick} disabled={p.disabled || p.loading} title={p.title}>
        {p.loading ? <span class="inline-block animate-spin">↺</span> : p.children}
      </button>;
};

// Square 24px text-icon button used in the action rows of every list.
export const IBtn: Component<{
  title: string; onClick: () => void;
  loading?: boolean; disabled?: boolean; danger?: boolean; children: JSX.Element;
}> = (p) => (
  <button
    title={p.title}
    aria-label={p.title}
    disabled={p.loading || p.disabled}
    onClick={(e) => { e.stopPropagation(); p.onClick(); }}
    class={`inline-flex h-6 w-6 items-center justify-center transition-colors disabled:opacity-30 ${
      p.danger
        ? "text-zinc-500 hover:bg-red-900/40 hover:text-red-400"
        : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"
    }`}
  >
    {p.loading ? <span class="inline-block animate-spin text-xs">↺</span> : p.children}
  </button>
);
