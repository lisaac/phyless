import { Component, JSX, Show, onCleanup, onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { createResourceStore } from "../../stores/resource";
import { Btn } from "../shared/ActionButton";
import { InfoBar, Info, ContainerLinks, cname, fmtWhen } from "../shared/Inspect";
import type { ComposeProject, ContainerSummary } from "../../types";

export const LABEL_PROJECT = "com.docker.compose.project";
export const LABEL_CONFIG_FILES = "com.docker.compose.project.config_files";

// Prefer the server-resolved label name. File matching is only a fallback for
// older responses; registered display names are not Docker project names.
export function containersOf(p: ComposeProject, all: ContainerSummary[]): ContainerSummary[] {
  const name = p.project_name || (p.discovered && p.discovery_source !== "directory" ? p.name : undefined);
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

export type ComposeProjectState = "empty" | "stopped" | "partial" | "running";

export function composeProjectState(p: Pick<ComposeProject, "running" | "total">): ComposeProjectState {
  const running = p.running ?? 0;
  if ((p.total ?? 0) === 0) return "empty";
  if (running === 0) return "stopped";
  return running < (p.total ?? 0) ? "partial" : "running";
}

export function composeActionAvailability(p: Pick<ComposeProject, "running" | "total" | "self">) {
  const state = composeProjectState(p);
  const running = p.running ?? 0;
  const total = p.total ?? 0;
  return {
    up: state !== "running",
    // A paused phyless could never unpause itself; the backend refuses too.
    pause: running > 0 && !p.self,
    restart: running > 0,
    stop: running > 0,
    down: total > 0,
  };
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

/** Compose info strip — the compose list's Inspect modal.
 *  `data` is /api/compose/detail; `containers` are the project's containers. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ComposeInfo: Component<{ data: any; containers: ContainerSummary[] }> = (p) => {
  const d = () => p.data ?? {};
  const running = () => p.containers.filter((c) => c.State === "running").length;
  const created = () => p.containers.reduce((min, c) => (min && min < c.Created ? min : c.Created), 0);
  const services = () => Object.keys(d().services ?? {}).join(", ") || "—";
  return (
    <InfoBar kind="Compose">
      <Info k="名称">{d().project_name || d().name || "—"}</Info>
      <Info k="文件" title={d().compose_file}>{d().compose_file || "—"}</Info>
      <Info k="服务" title={services()}>{services()}</Info>
      <Info k={`容器 ${running()}/${p.containers.length}`}>
        <ContainerLinks items={p.containers.map((c) => ({ Id: c.Id, Name: cname(c) }))} />
      </Info>
      <Show when={created()}><Info k="创建">{fmtWhen(created())}</Info></Show>
      <Show when={d().load_error}><Info k="错误" title={d().load_error}><span class="text-red-400">{d().load_error}</span></Info></Show>
    </InfoBar>
  );
};

// One app-wide /api/compose poll shared by every ComposeLink (each container
// row would otherwise poll on its own); runs while at least one link is mounted.
const composeProjects = createResourceStore<ComposeProject>("/api/compose", "id");
let composeUsers = 0;

/** Link from a compose-managed container to its project page; hover shows
 *  the project's basics. Renders nothing for standalone containers. */
export const ComposeLink: Component<{ labels?: Record<string, string> | null; class?: string }> = (p) => {
  const navigate = useNavigate();
  onMount(() => { if (composeUsers++ === 0) composeProjects.startPolling(); });
  onCleanup(() => { if (--composeUsers === 0) composeProjects.stopPolling(); });
  const label = () => p.labels?.[LABEL_PROJECT];
  const project = () => {
    const me = [{ Labels: p.labels ?? {} } as ContainerSummary];
    return composeProjects.items().find((x) => containersOf(x, me).length > 0);
  };
  // ponytail: before the list loads (or if it fails) fall back to the backend's discovered-project id.
  const href = () => `/compose/${project()?.id ?? `auto:${label()}`}`;
  const tip = () => {
    const x = project();
    if (!x) return `Compose 项目：${label()}`;
    return [
      `Compose 项目：${x.name}`,
      x.project_name && x.project_name !== x.name ? `项目名：${x.project_name}` : "",
      `容器：${x.running ?? 0}/${x.total ?? 0} 运行中`,
      x.compose_file ? `文件：${x.compose_file}` : "",
      x.base_dir ? `目录：${x.base_dir}` : "",
      x.discovered ? "来源：运行中发现（未注册）" : "来源：已注册",
    ].filter(Boolean).join("\n");
  };
  return (
    <Show when={label()}>
      <a
        href={href()}
        title={tip()}
        class={`inline-flex min-w-0 items-center gap-1 text-indigo-400 transition-colors hover:text-indigo-300 hover:underline ${p.class ?? ""}`}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); navigate(href(), { replace: true }); }}
      >
        <ComposeIcon size={12} />
        <span class="truncate">{project()?.name ?? label()}</span>
      </a>
    </Show>
  );
};
