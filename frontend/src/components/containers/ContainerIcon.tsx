import { Component } from "solid-js";

// Box icon marking a container, mirroring ComposeIcon's API/visual weight
// (compose/composeShared.tsx) so the two read as a matched icon set.
export const ContainerIcon: Component<{ size?: number; class?: string }> = (p) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" width={p.size ?? 16} height={p.size ?? 16} class={p.class ?? "shrink-0 text-zinc-400"}>
    <path d="M21 8l-9-5-9 5 9 5 9-5z" />
    <path d="M3 8v8l9 5 9-5V8" />
    <path d="M12 13v8" />
  </svg>
);
