import { Component, createSignal, For, Show } from "solid-js";

type Kind = "info" | "success" | "error";
interface ToastMsg { id: number; text: string; kind: Kind; }

const [messages, setMessages] = createSignal<ToastMsg[]>([]);
let nextId = 1;

function push(text: string, kind: Kind) {
  const id = nextId++;
  setMessages((m) => [...m, { id, text, kind }]);
  setTimeout(() => setMessages((m) => m.filter((x) => x.id !== id)), 7000);
}

export const toast = {
  info:    (text: string) => push(text, "info"),
  success: (text: string) => push(text, "success"),
  error:   (text: string) => push(text, "error"),
};

const STYLE: Record<Kind, string> = {
  success: "border-emerald-500/25 bg-zinc-900 text-emerald-400",
  error:   "border-red-500/25 bg-zinc-900 text-red-400",
  info:    "border-zinc-700 bg-zinc-900 text-zinc-300",
};

const PREFIX: Record<Kind, string> = {
  success: "✓",
  error:   "✕",
  info:    "",
};

export const ToastHost: Component = () => (
  <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
    <For each={messages()}>
      {(m) => (
        <div class={`flex items-start gap-2 min-w-[220px] max-w-xl rounded-lg border px-3.5 py-2.5 text-sm shadow-xl ${STYLE[m.kind]}`}>
          <Show when={PREFIX[m.kind]}>
            <span class="shrink-0 font-semibold leading-5">{PREFIX[m.kind]}</span>
          </Show>
          <span class="leading-5 break-words min-w-0">{m.text}</span>
        </div>
      )}
    </For>
  </div>
);
