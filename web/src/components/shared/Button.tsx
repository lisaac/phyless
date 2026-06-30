import { Component, JSX, splitProps } from "solid-js";

type Variant = "primary" | "danger" | "ghost";
const styles: Record<Variant, string> = {
  primary: "bg-blue-600 hover:bg-blue-500",
  danger: "bg-red-600 hover:bg-red-500",
  ghost: "bg-zinc-800 hover:bg-zinc-700",
};

export const Button: Component<
  JSX.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }
> = (props) => {
  const [local, rest] = splitProps(props, ["variant", "class", "children"]);
  return (
    <button
      {...rest}
      class={`rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
        styles[local.variant ?? "ghost"]
      } ${local.class ?? ""}`}
    >
      {local.children}
    </button>
  );
};
