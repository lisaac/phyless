import { Component, JSX } from "solid-js";
import type { ComposeProject, ContainerSummary } from "../../types";

export const LABEL_PROJECT = "com.docker.compose.project";
export const LABEL_CONFIG_FILES = "com.docker.compose.project.config_files";

// Mirrors the matching handleListCompose (internal/api/compose.go) does
// server-side: discovered projects match by the project label directly, but
// registered ones match by compose_file — a registered project's `name` is
// user-typed and may not equal the actual docker compose project name.
export function containersOf(p: ComposeProject, all: ContainerSummary[]): ContainerSummary[] {
  if (p.discovered) return all.filter((c) => c.Labels?.[LABEL_PROJECT] === p.name);
  return all.filter((c) => c.Labels?.[LABEL_CONFIG_FILES]?.split(",")[0] === p.compose_file);
}

// The container whose status best represents the whole project's uptime —
// a running one if any, else just the first (matches what the aggregate
// running/total badge already implies).
export function representative(cs: ContainerSummary[]): ContainerSummary | undefined {
  return cs.find((c) => c.State === "running") ?? cs[0];
}

export type ComposeVerb = "up" | "stop" | "down" | "restart" | "pull";
export const VERB_LABEL: Record<ComposeVerb, string> = { up: "Up", stop: "Stop", down: "Down", restart: "Restart", pull: "Pull" };

// Stack/layers icon used everywhere a compose project needs a visual marker:
// the tab strip, the list row, and the detail page heading.
export const ComposeIcon: Component<{ size?: number; class?: string }> = (p) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" width={p.size ?? 16} height={p.size ?? 16} class={p.class ?? "shrink-0 text-zinc-400"}>
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
  </svg>
);

// Compact text button shared by the compose list and detail page — same
// density as ContainerListPage's bulk-action bar, glyph + label so every
// compose action (Up/Stop/Down/Restart/Pull/Run-Compose/详情) reads the same
// regardless of which page it's clicked from.
export const ActBtn: Component<{ title: string; onClick: () => void; danger?: boolean; children: JSX.Element }> = (p) => (
  <button
    title={p.title}
    onClick={(e) => { e.stopPropagation(); p.onClick(); }}
    class={`px-2 py-0.5 text-xs transition-colors ${
      p.danger ? "text-red-400 hover:bg-red-900/40 hover:text-red-300" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
    }`}
  >{p.children}</button>
);
