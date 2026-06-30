import { Component, createSignal, onMount, onCleanup, For } from "solid-js";
import { connectWS } from "../../api/ws";

interface DockerEvent { Type?: string; Action?: string; Actor?: { Attributes?: Record<string, string> }; time?: number; }

export const EventsPage: Component = () => {
  const [events, setEvents] = createSignal<DockerEvent[]>([]);
  let ws: WebSocket | undefined;

  onMount(() => {
    const dec = new TextDecoder();
    ws = connectWS("/ws/events", {
      onMessage: (ev) => {
        const text = typeof ev.data === "string" ? ev.data : dec.decode(ev.data as ArrayBuffer);
        for (const line of text.split("\n").filter(Boolean)) {
          try {
            const e = JSON.parse(line) as DockerEvent;
            setEvents((a) => [e, ...a].slice(0, 500)); // ponytail: cap at 500 newest
          } catch { /* partial */ }
        }
      },
    });
  });
  onCleanup(() => ws?.close());

  const name = (e: DockerEvent) => e.Actor?.Attributes?.name ?? e.Actor?.Attributes?.image ?? "";

  return (
    <div>
      <h1 class="mb-4 text-xl font-semibold">事件</h1>
      <table class="w-full text-left text-sm">
        <thead class="border-b border-zinc-800 text-zinc-400">
          <tr><th class="px-2 py-2">时间</th><th class="px-2 py-2">类型</th><th class="px-2 py-2">动作</th><th class="px-2 py-2">对象</th></tr>
        </thead>
        <tbody>
          <For each={events()}>
            {(e) => (
              <tr class="border-b border-zinc-900">
                <td class="px-2 py-1 text-xs text-zinc-500">{e.time ? new Date(e.time * 1000).toLocaleTimeString() : ""}</td>
                <td class="px-2 py-1">{e.Type}</td>
                <td class="px-2 py-1">{e.Action}</td>
                <td class="px-2 py-1 text-zinc-300">{name(e)}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
};
