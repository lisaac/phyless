import { Component, For, Show, createSignal, onMount, onCleanup, createEffect } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { createResourceStore } from "../../stores/resource";
import { connectWS } from "../../api/ws";
import { cpuPercent, memUsageMB } from "../../api/stats";
import { Table } from "../shared/Table";
import { containerName } from "../containers/containerActions";
import type { ContainerSummary, ImageSummary, ComposeProject, VolumeSummary, NetworkSummary } from "../../types";

// One `/ws/containers/{id}/stats` socket per running container — same
// approach `docker stats` itself uses (there's no single "all containers"
// stats endpoint in the Docker API).
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

  const [stats, setStats] = createSignal<Record<string, { cpu: number; mem: number }>>({});
  const sockets = new Map<string, WebSocket>();

  createEffect(() => {
    const runningIds = new Set(containers.items().filter((c) => c.State === "running").map((c) => c.Id));
    for (const [id, ws] of sockets) {
      if (!runningIds.has(id)) {
        ws.close();
        sockets.delete(id);
        setStats(({ [id]: _, ...rest }) => rest);
      }
    }
    for (const id of runningIds) {
      if (sockets.has(id)) continue;
      const ws = connectWS(`/ws/containers/${id}/stats`, {
        onMessage: (ev) => {
          const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
          for (const line of text.split("\n").filter(Boolean)) {
            try {
              const s = JSON.parse(line);
              setStats((prev) => ({ ...prev, [id]: { cpu: cpuPercent(s), mem: memUsageMB(s) } }));
            } catch { /* partial frame */ }
          }
        },
      });
      sockets.set(id, ws);
    }
  });
  onCleanup(() => { for (const ws of sockets.values()) ws.close(); });

  const cards = () => [
    { label: "容器", value: `${running()} / ${containers.items().length}`, sub: "运行中 / 总数", to: "/containers" },
    { label: "镜像", value: `${images.items().length}`, sub: "总数", to: "/images" },
    { label: "Compose", value: `${compose.items().length}`, sub: "项目", to: "/compose" },
    { label: "存储卷", value: `${volumes.items().length}`, sub: "总数", to: "/volumes" },
    { label: "网络", value: `${networks.items().length}`, sub: "总数", to: "/networks" },
  ];

  return (
    <div class="space-y-6">
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <For each={cards()}>
          {(c) => (
            <div
              class="cursor-pointer rounded-lg border border-zinc-800 bg-zinc-900 p-4 transition-colors hover:border-zinc-700"
              onClick={() => navigate(c.to)}
            >
              <div class="text-xs text-zinc-500">{c.label}</div>
              <div class="mt-1 text-2xl font-semibold text-zinc-100">{c.value}</div>
              <div class="text-[11px] text-zinc-500">{c.sub}</div>
            </div>
          )}
        </For>
      </div>

      <div>
        <div class="mb-2 text-xs text-zinc-500">容器资源占用</div>
        <Table
          rows={containers.items()}
          rowKey={(c) => c.Id}
          onRowClick={(c) => navigate(`/containers/${c.Id}`)}
          columns={[
            { header: "名称", cell: (c) => <span class="text-zinc-200">{containerName(c) || c.Id.slice(0, 8)}</span> },
            { header: "状态", cell: (c) => <span class={c.State === "running" ? "text-emerald-400" : "text-zinc-500"}>{c.Status}</span> },
            { header: "CPU", cell: (c) => <Show when={stats()[c.Id]} fallback="—">{(s) => <>{s().cpu.toFixed(1)}%</>}</Show> },
            { header: "内存", cell: (c) => <Show when={stats()[c.Id]} fallback="—">{(s) => <>{s().mem.toFixed(0)} MB</>}</Show> },
          ]}
        />
      </div>
    </div>
  );
};
