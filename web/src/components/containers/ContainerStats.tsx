import { Component, onMount, onCleanup, createSignal } from "solid-js";
import { connectWS } from "../../api/ws";
import { Sparkline } from "./Sparkline";

// Docker stats JSON: cpu_stats / precpu_stats / memory_stats. Compute CPU% per frame.
function cpuPercent(s: any): number {
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = s.cpu_stats.system_cpu_usage - (s.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = s.cpu_stats.online_cpus ?? 1;
  if (sysDelta <= 0 || cpuDelta <= 0) return 0;
  return (cpuDelta / sysDelta) * cpus * 100;
}

export const ContainerStats: Component<{ id: string }> = (props) => {
  const [cpu, setCpu] = createSignal<number[]>([]);
  const [mem, setMem] = createSignal<number[]>([]);
  const [cur, setCur] = createSignal({ cpu: 0, memMB: 0 });
  let ws: WebSocket | undefined;

  onMount(() => {
    ws = connectWS(`/ws/containers/${props.id}/stats`, {
      onMessage: (ev) => {
        const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
        for (const line of text.split("\n").filter(Boolean)) {
          try {
            const s = JSON.parse(line);
            const c = cpuPercent(s);
            const m = (s.memory_stats?.usage ?? 0) / 1024 / 1024;
            setCpu((a) => [...a, c].slice(-60));
            setMem((a) => [...a, m].slice(-60));
            setCur({ cpu: c, memMB: m });
          } catch { /* partial frame */ }
        }
      },
    });
  });
  onCleanup(() => ws?.close());

  return (
    <div class="flex gap-8">
      <div>
        <div class="mb-1 text-sm text-zinc-400">CPU {cur().cpu.toFixed(1)}%</div>
        <Sparkline data={cpu()} color="#60a5fa" />
      </div>
      <div>
        <div class="mb-1 text-sm text-zinc-400">内存 {cur().memMB.toFixed(0)} MB</div>
        <Sparkline data={mem()} color="#34d399" />
      </div>
    </div>
  );
};
