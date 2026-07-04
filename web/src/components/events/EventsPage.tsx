import { Component, createSignal, onMount, onCleanup, For, Show } from "solid-js";
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
      <div class="overflow-x-auto border border-zinc-800">
        <div class="flex border-b border-zinc-800 text-xs text-zinc-500">
          <div class="w-28 shrink-0 px-2 py-2">时间</div>
          <div class="w-28 shrink-0 px-2 py-2">类型</div>
          <div class="w-28 shrink-0 px-2 py-2">动作</div>
          <div class="min-w-0 flex-1 px-2 py-2">对象</div>
        </div>
        <div class="divide-y divide-zinc-800">
          <For each={events()}>
            {(e) => (
              <div class="flex text-sm">
                <div class="w-28 shrink-0 px-2 py-1 text-xs text-zinc-500">{e.time ? new Date(e.time * 1000).toLocaleTimeString() : ""}</div>
                <div class="w-28 shrink-0 px-2 py-1">{e.Type}</div>
                <div class="w-28 shrink-0 px-2 py-1">{e.Action}</div>
                <div class="min-w-0 flex-1 truncate px-2 py-1 text-zinc-300">{name(e)}</div>
              </div>
            )}
          </For>
        </div>
        <Show when={events().length === 0}>
          <div class="py-16 text-center text-zinc-400">暂无事件</div>
        </Show>
      </div>
    </div>
  );
};
