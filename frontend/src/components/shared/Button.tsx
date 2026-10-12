import { Component, JSX, Show, splitProps } from "solid-js";

// The one button look for every page header, modal footer and form. Compact
// on phones, regular from sm: up. `buttonCls` styles non-<button> elements
// (e.g. a file-input <label>) identically.
type Variant = "primary" | "secondary" | "danger" | "ghost";
const styles: Record<Variant, string> = {
  primary:   "bg-indigo-600 font-medium text-white hover:bg-indigo-500",
  secondary: "border border-zinc-600 text-zinc-300 hover:border-zinc-400 hover:text-zinc-100",
  danger:    "border border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300",
  ghost:     "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100",
};
export const buttonCls = (variant: Variant = "secondary") =>
  `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-40 sm:px-3 sm:py-1.5 sm:text-sm ${styles[variant]}`;

export const Button: Component<
  JSX.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }
> = (props) => {
  const [local, rest] = splitProps(props, ["variant", "class", "children"]);
  return (
    <button type="button" {...rest} class={`${buttonCls(local.variant)} ${local.class ?? ""}`}>
      {local.children}
    </button>
  );
};

/** Page title row: h1 (+ optional description) on the left, actions on the right. */
export const PageHeader: Component<{ title: JSX.Element; description?: string; flush?: boolean; children?: JSX.Element }> = (props) => (
  <div class={`flex flex-wrap items-center justify-between gap-2 ${props.flush ? "" : "mb-4"}`}>
    <div class="min-w-0">
      <h1 class="flex items-center gap-2 text-xl font-semibold">{props.title}</h1>
      <Show when={props.description}><p class="mt-1 text-sm text-zinc-500">{props.description}</p></Show>
    </div>
    <Show when={props.children}>
      <div class="flex min-w-0 flex-wrap items-center justify-end gap-1 sm:gap-2">{props.children}</div>
    </Show>
  </div>
);

/** Shared text input / select / textarea look. */
export const fieldCls = "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-100 outline-none transition-colors focus:border-indigo-500";

/** Toggle/segment chip — time-range presets, radio groups, filter toggles. */
export const Chip: Component<{ active: boolean; warn?: boolean; onClick: () => void; children: JSX.Element }> = (props) => (
  <button
    type="button"
    class={`px-2.5 py-1 text-xs transition-colors ${
      props.active
        ? props.warn ? "bg-amber-600 text-white" : "bg-indigo-600 text-white"
        : "border border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-200"
    }`}
    onClick={() => props.onClick()}
  >{props.children}</button>
);
