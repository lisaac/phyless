import { Component, JSX, splitProps } from "solid-js";

type Variant = "primary" | "danger" | "ghost";
const styles: Record<Variant, string> = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-500 rounded-md",
  danger:  "bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 hover:text-red-300 rounded-md",
  ghost:   "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 rounded-md",
};

export const Button: Component<
  JSX.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }
> = (props) => {
  const [local, rest] = splitProps(props, ["variant", "class", "children"]);
  return (
    <button
      {...rest}
      class={`px-3 py-1.5 text-sm transition-colors disabled:opacity-40 ${
        styles[local.variant ?? "ghost"]
      } ${local.class ?? ""}`}
    >
      {local.children}
    </button>
  );
};
