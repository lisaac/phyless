import { Component, onMount, onCleanup, createSignal, createResource, For, Show } from "solid-js";
import { connectWS, reportWSError } from "../../api/ws";
import { get } from "../../api/client";
import { cpuPercent, memUsageMB, memLimitMB } from "../../api/stats";
import { Sparkline } from "./Sparkline";

function netBytes(s: any): { rx: number; tx: number } {
  const nets = s.networks ?? {};
  let rx = 0, tx = 0;
  for (const k in nets) { rx += nets[k].rx_bytes ?? 0; tx += nets[k].tx_bytes ?? 0; }
  return { rx, tx };
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}K`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}M`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)}G`;
}

export const ContainerStats: Component<{ id: string }> = (props) => {
  const [cpu, setCpu] = createSignal<number[]>([]);
  const [mem, setMem] = createSignal<number[]>([]);
  const [rxArr, setRxArr] = createSignal<number[]>([]);
  const [txArr, setTxArr] = createSignal<number[]>([]);
  const [cur, setCur] = createSignal({ cpu: 0, memMB: 0, memLimit: 0, rx: 0, tx: 0 });
  let prevNet = { rx: 0, tx: 0 };
  let ws: WebSocket | undefined;

  onMount(() => {
    ws = connectWS(`/ws/containers/${props.id}/stats`, {
      onMessage: (ev) => {
        const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
        for (const line of text.split("\n").filter(Boolean)) {
          try {
            const s = JSON.parse(line);
            const c = cpuPercent(s);
            const m = memUsageMB(s);
            const limit = memLimitMB(s);
            const net = netBytes(s);
            const rxDelta = Math.max(0, net.rx - prevNet.rx);
            const txDelta = Math.max(0, net.tx - prevNet.tx);
            prevNet = net;
            setCpu((a) => [...a, c].slice(-60));
            setMem((a) => [...a, m].slice(-60));
            setRxArr((a) => [...a, rxDelta].slice(-60));
            setTxArr((a) => [...a, txDelta].slice(-60));
            setCur({ cpu: c, memMB: m, memLimit: limit, rx: rxDelta, tx: txDelta });
          } catch { /* partial frame */ }
        }
      },
      onError: () => reportWSError("容器状态实时连接"),
    });
  });
  onCleanup(() => ws?.close());

  const [procs, { refetch: refetchProcs }] = createResource(
    () => props.id,
    (id) => get<{ Titles: string[]; Processes: string[][] }>(`/api/containers/${id}/top`).catch(() => null),
  );

  return (
    <div class="space-y-6">
      <div class="grid grid-cols-2 gap-6 sm:grid-cols-4">
        <div>
          <div class="mb-1 text-xs text-zinc-500">CPU <span class="text-zinc-200">{cur().cpu.toFixed(1)}%</span></div>
          <Sparkline data={cpu()} color="#60a5fa" />
        </div>
        <div>
          <div class="mb-1 text-xs text-zinc-500">
            内存 <span class="text-zinc-200">{cur().memMB.toFixed(0)} MB</span>
            <Show when={cur().memLimit > 0}><span class="text-zinc-500"> / {cur().memLimit.toFixed(0)} MB</span></Show>
          </div>
          <Sparkline data={mem()} color="#34d399" />
        </div>
        <div>
          <div class="mb-1 text-xs text-zinc-500">网络↓ <span class="text-zinc-200">{fmtBytes(cur().rx)}/s</span></div>
          <Sparkline data={rxArr()} color="#a78bfa" />
        </div>
        <div>
          <div class="mb-1 text-xs text-zinc-500">网络↑ <span class="text-zinc-200">{fmtBytes(cur().tx)}/s</span></div>
          <Sparkline data={txArr()} color="#f59e0b" />
        </div>
      </div>

      <div>
        <div class="mb-2 flex items-center gap-3">
          <span class="text-xs text-zinc-500">进程列表</span>
          <button class="text-[11px] text-zinc-400 hover:text-zinc-300" onClick={() => refetchProcs()}>刷新</button>
        </div>
        <Show when={procs()}>
          {(p) => (
            <table class="w-full text-left">
              <thead>
                <tr class="text-[11px] text-zinc-400">
                  <For each={p().Titles}>{(t) => <th class="pb-1 pr-4 font-normal">{t}</th>}</For>
                </tr>
              </thead>
              <tbody>
                <For each={p().Processes ?? []}>
                  {(row) => (
                    <tr class="border-t border-zinc-900">
                      <For each={row}>{(cell, i) => (
                        <td class={`py-0.5 pr-4 font-mono text-xs ${i() === row.length - 1 ? "text-zinc-400" : "text-zinc-400"}`}>{cell}</td>
                      )}</For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          )}
        </Show>
        <Show when={!procs() && !procs.loading}>
          <p class="text-xs text-zinc-500">无法获取进程列表（容器可能已停止）</p>
        </Show>
      </div>
    </div>
  );
};
