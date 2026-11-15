import { Component, JSX } from "solid-js";

// Canonical action-button style shared across container list/detail and
// compose list/detail — transparent by default (no background/border), a
// background only appears on hover. Danger actions stay red at rest so
// they're still distinguishable before the pointer arrives. `accent` marks
// an action that deserves attention right now (e.g. upgrade available).
const ACCENT = "text-amber-400 hover:bg-amber-900/30 hover:text-amber-300";

export const Btn: Component<{
  onClick?: (e: MouseEvent) => void; href?: string; danger?: boolean; accent?: boolean;
  disabled?: boolean; loading?: boolean; title?: string; children: JSX.Element;
}> = (p) => {
  const cls = `px-2.5 py-1 text-xs transition-colors disabled:opacity-30 ${
    p.danger
      ? "text-red-400 hover:bg-red-900/40 hover:text-red-300"
      : p.accent ? ACCENT : "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
  }`;
  return p.href
    ? <a href={p.href} class={cls} title={p.title}>{p.children}</a>
    : <button class={cls} onClick={p.onClick} disabled={p.disabled || p.loading} title={p.title}>
        {p.loading ? <span class="inline-block animate-spin">↺</span> : p.children}
      </button>;
};

// Toggleable tag in a multi-select tag panel (Cap Add/Drop, compose filter).
// `colors` = [idle, active] classes to override the default blue/red scheme.
export const ToggleTag: Component<{ active: boolean; danger?: boolean; colors?: [string, string]; title?: string; onClick: () => void; children: JSX.Element }> = (p) => (
  <button type="button" title={p.title} onClick={p.onClick}
    class={`px-1.5 py-0.5 text-xs font-mono transition-colors ${
      p.colors ? `border ${p.colors[p.active ? 1 : 0]}`
        : p.active ? (p.danger ? "bg-red-700 text-white" : "bg-blue-600 text-white") : "border border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-200"
    }`}>{p.children}</button>
);

// Square 24px text-icon button used in the action rows of every list.
export const IBtn: Component<{
  title: string; onClick: () => void;
  loading?: boolean; disabled?: boolean; danger?: boolean; accent?: boolean; children: JSX.Element;
}> = (p) => (
  <button
    title={p.title}
    aria-label={p.title}
    disabled={p.loading || p.disabled}
    onClick={(e) => { e.stopPropagation(); p.onClick(); }}
    class={`inline-flex h-6 w-6 items-center justify-center transition-colors disabled:opacity-30 ${
      p.danger
        ? "text-zinc-500 hover:bg-red-900/40 hover:text-red-400"
        : p.accent ? ACCENT : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"
    }`}
  >
    {p.loading ? <span class="inline-block animate-spin text-xs">↺</span> : p.children}
  </button>
);

// Tiny 14px stroked SVG icon — feed it an SVG path `d`.
export const Ico = (p: { path: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="2" stroke-linecap="round"
       stroke-linejoin="round" width="14" height="14">
    <path d={p.path} />
  </svg>
);
