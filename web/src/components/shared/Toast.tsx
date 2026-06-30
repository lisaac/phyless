import { Component, createSignal, For } from "solid-js";

type Kind = "info" | "error";
interface ToastMsg { id: number; text: string; kind: Kind; }

const [messages, setMessages] = createSignal<ToastMsg[]>([]);
let nextId = 1;

function push(text: string, kind: Kind) {
  const id = nextId++;
  setMessages((m) => [...m, { id, text, kind }]);
  setTimeout(() => setMessages((m) => m.filter((x) => x.id !== id)), 4000);
}

export const toast = {
  info: (text: string) => push(text, "info"),
  error: (text: string) => push(text, "error"),
};

export const ToastHost: Component = () => (
  <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
    <For each={messages()}>
      {(m) => (
        <div
          class={`rounded px-4 py-2 text-sm shadow-lg ${
            m.kind === "error" ? "bg-red-700" : "bg-zinc-700"
          }`}
        >
          {m.text}
        </div>
      )}
    </For>
  </div>
);
