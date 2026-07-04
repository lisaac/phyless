import { Component, For, onMount, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { createResourceStore } from "../../stores/resource";
import type { ContainerSummary, ImageSummary, ComposeProject, VolumeSummary, NetworkSummary } from "../../types";

export const OverviewPage: Component = () => {
  const navigate = useNavigate();
  const containers = createResourceStore<ContainerSummary>("/api/containers");
  const images = createResourceStore<ImageSummary>("/api/images");
  const compose = createResourceStore<ComposeProject>("/api/compose");
  const volumes = createResourceStore<VolumeSummary>("/api/volumes");
  const networks = createResourceStore<NetworkSummary>("/api/networks");

  onMount(() => {
    containers.startPolling();
    images.startPolling();
    compose.startPolling();
    volumes.startPolling();
    networks.startPolling();
  });
  onCleanup(() => {
    containers.stopPolling();
    images.stopPolling();
    compose.stopPolling();
    volumes.stopPolling();
    networks.stopPolling();
  });

  const running = () => containers.items().filter((c) => c.State === "running").length;

  const cards = () => [
    { label: "容器", value: `${running()} / ${containers.items().length}`, sub: "运行中 / 总数", to: "/containers" },
    { label: "镜像", value: `${images.items().length}`, sub: "总数", to: "/images" },
    { label: "Compose", value: `${compose.items().length}`, sub: "项目", to: "/compose" },
    { label: "存储卷", value: `${volumes.items().length}`, sub: "总数", to: "/volumes" },
    { label: "网络", value: `${networks.items().length}`, sub: "总数", to: "/networks" },
  ];

  return (
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <For each={cards()}>
        {(c) => (
          <div
            class="cursor-pointer rounded-lg border border-zinc-800 bg-zinc-900 p-4 transition-colors hover:border-zinc-700"
            onClick={() => navigate(c.to, { replace: true })}
          >
            <div class="text-xs text-zinc-500">{c.label}</div>
            <div class="mt-1 text-2xl font-semibold text-zinc-100">{c.value}</div>
            <div class="text-[11px] text-zinc-500">{c.sub}</div>
          </div>
        )}
      </For>
    </div>
  );
};
