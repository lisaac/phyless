import { Component, JSX } from "solid-js";
import { Btn } from "../shared/ActionButton";
import type { ComposeProject, ContainerSummary } from "../../types";

export const LABEL_PROJECT = "com.docker.compose.project";
export const LABEL_CONFIG_FILES = "com.docker.compose.project.config_files";

// Prefer the server-resolved label name. File matching is only a fallback for
// older responses; registered display names are not Docker project names.
export function containersOf(p: ComposeProject, all: ContainerSummary[]): ContainerSummary[] {
  const name = p.project_name || (p.discovered ? p.name : undefined);
  if (name) return all.filter((c) => c.Labels?.[LABEL_PROJECT] === name);
  const files = p.compose_file.split(",").map((file) => file.trim()).filter(Boolean);
  if (!files.length) return [];
  return all.filter((c) => {
    const actual = c.Labels?.[LABEL_CONFIG_FILES]?.split(",").map((file) => file.trim());
    return files.every((file, index) => actual?.[index] === file);
  });
}

// The container whose status best represents the whole project's uptime —
// a running one if any, else just the first (matches what the aggregate
// running/total badge already implies).
export function representative(cs: ContainerSummary[]): ContainerSummary | undefined {
  return cs.find((c) => c.State === "running") ?? cs[0];
}

export type ComposeVerb = "up" | "stop" | "pause" | "down" | "restart" | "pull" | "build" | "update";
export const VERB_LABEL: Record<ComposeVerb, string> = { up: "Up", stop: "Stop", pause: "Pause", down: "Down", restart: "Restart", pull: "Pull/Build", build: "Build", update: "Update" };

// A project supports image updates with a build step when any service declares
// a build section. The list uses the backend's can_build flag; the detail page
// derives the same answer from its loaded services.
export function servicesHaveBuild(services: Record<string, Record<string, unknown>> | undefined | null): boolean {
  return !!services && Object.values(services).some((s) => s?.build != null);
}

// Stacked-service mark used wherever a compose project needs a visual marker.
// Its thin strokes match the container and action icons without adding an icon
// dependency just for one Docker concept.
export const ComposeIcon: Component<{ size?: number; class?: string }> = (p) => (
  <svg
    xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    width={p.size ?? 16} height={p.size ?? 16} aria-hidden="true"
    class={p.class ?? "shrink-0"}
  >
    <path d="m12 2 9 5-9 5-9-5 9-5Z" />
    <path d="m3 12 9 5 9-5" />
    <path d="m3 17 9 5 9-5" />
  </svg>
);

// Thin wrapper around the shared Btn (same style used by the container list
// bulk-bar and container detail page) that also stops the click from
// bubbling — compose action buttons sit inside a row whose own onClick
// toggles the expand/collapse state.
export const ActBtn: Component<{ title: string; onClick: () => void; danger?: boolean; loading?: boolean; children: JSX.Element }> = (p) => (
  <Btn title={p.title} danger={p.danger} loading={p.loading} onClick={(e) => { e.stopPropagation(); p.onClick(); }}>{p.children}</Btn>
);
