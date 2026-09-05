import { Component, onCleanup, createSignal, createResource, createEffect, For, Show } from "solid-js";
import { connectWS, reportWSError } from "../../api/ws";
import { get } from "../../api/client";
import { cpuPercent, memUsageMB, memLimitMB, networkBytes, networkRates, type NetworkSample } from "../../api/stats";
import { Sparkline } from "./Sparkline";

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
  let connection = 0;

  createEffect(() => {
    const id = props.id;
    const current = ++connection;
    setCpu([]); setMem([]); setRxArr([]); setTxArr([]);
    setCur({ cpu: 0, memMB: 0, memLimit: 0, rx: 0, tx: 0 });
    let prevNet: NetworkSample | undefined;
    const socket = connectWS(`/ws/containers/${id}/stats`, {
      onMessage: (ev) => {
        if (current !== connection) return;
        const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
        try {
          const s = JSON.parse(text.trim());
          const c = cpuPercent(s);
          const m = memUsageMB(s);
          const limit = memLimitMB(s);
          const dockerTime = typeof s.read === "string" ? Date.parse(s.read) : NaN;
          const rates = networkRates(networkBytes(s), prevNet, Number.isFinite(dockerTime) ? dockerTime : Date.now());
          prevNet = rates.sample;
          setCpu((a) => [...a, c].slice(-60));
          setMem((a) => [...a, m].slice(-60));
          setRxArr((a) => [...a, rates.rx].slice(-60));
          setTxArr((a) => [...a, rates.tx].slice(-60));
          setCur({ cpu: c, memMB: m, memLimit: limit, rx: rates.rx, tx: rates.tx });
        } catch { /* malformed frame */ }
      },
      onError: () => { if (current === connection) reportWSError("容器状态实时连接"); },
    });
    onCleanup(() => {
      socket.close();
    });
  });

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
