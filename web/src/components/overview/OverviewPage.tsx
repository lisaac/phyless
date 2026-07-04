import { Component, For, createSignal, onMount, onCleanup, createEffect } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { createResourceStore } from "../../stores/resource";
import { connectWS } from "../../api/ws";
import { cpuPercent, memUsageMB } from "../../api/stats";
import { Sparkline } from "../containers/Sparkline";
import type { ContainerSummary, ImageSummary, ComposeProject, VolumeSummary, NetworkSummary } from "../../types";

// One `/ws/containers/{id}/stats` socket per running container (Docker has
// no single "all containers" stats endpoint — `docker stats` itself opens
// one stream per container), summed into a single total CPU/mem series
// sampled once a second rather than pushed on every socket's own cadence.
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

  const latest = new Map<string, { cpu: number; mem: number }>();
  const sockets = new Map<string, WebSocket>();
  const [cpuHist, setCpuHist] = createSignal<number[]>([]);
  const [memHist, setMemHist] = createSignal<number[]>([]);
  const [totals, setTotals] = createSignal({ cpu: 0, mem: 0 });

  createEffect(() => {
    const runningIds = new Set(containers.items().filter((c) => c.State === "running").map((c) => c.Id));
    for (const [id, ws] of sockets) {
      if (!runningIds.has(id)) { ws.close(); sockets.delete(id); latest.delete(id); }
    }
    for (const id of runningIds) {
      if (sockets.has(id)) continue;
      const ws = connectWS(`/ws/containers/${id}/stats`, {
        onMessage: (ev) => {
          const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
          for (const line of text.split("\n").filter(Boolean)) {
            try {
              const s = JSON.parse(line);
              latest.set(id, { cpu: cpuPercent(s), mem: memUsageMB(s) });
            } catch { /* partial frame */ }
          }
        },
      });
      sockets.set(id, ws);
    }
  });
  onCleanup(() => { for (const ws of sockets.values()) ws.close(); });

  onMount(() => {
    const timer = setInterval(() => {
      let cpu = 0, mem = 0;
      for (const v of latest.values()) { cpu += v.cpu; mem += v.mem; }
      setTotals({ cpu, mem });
      setCpuHist((a) => [...a, cpu].slice(-60));
      setMemHist((a) => [...a, mem].slice(-60));
    }, 1000);
    onCleanup(() => clearInterval(timer));
  });

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

      <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div>
          <div class="mb-1 text-xs text-zinc-500">
            全部容器 CPU 总用量 <span class="text-zinc-200">{totals().cpu.toFixed(1)}%</span>
          </div>
          <Sparkline data={cpuHist()} color="#60a5fa" />
        </div>
        <div>
          <div class="mb-1 text-xs text-zinc-500">
            全部容器内存总用量 <span class="text-zinc-200">{totals().mem.toFixed(0)} MB</span>
          </div>
          <Sparkline data={memHist()} color="#34d399" />
        </div>
      </div>
    </div>
  );
};
