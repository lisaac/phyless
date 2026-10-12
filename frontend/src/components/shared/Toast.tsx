import { Component, createSignal, For, Show } from "solid-js";

type Kind = "info" | "success" | "error";
interface ToastMsg { id: number; text: string; kind: Kind; sticky?: boolean; }

const [messages, setMessages] = createSignal<ToastMsg[]>([]);
let nextId = 1;
let lastErrorAt = 0;
let lastErrorText = "";

// Backend unreachable: one sticky toast however many requests fail, kept until
// the user closes it. Callers that toast(e.message) for such a failure land
// here too, so the message never shows twice.
export const BACKEND_DOWN = "无法连接后端服务，请检查服务是否运行或网络连接";

const dismiss = (id: number) => setMessages((m) => m.filter((x) => x.id !== id));

function push(text: string, kind: Kind) {
  if (text === BACKEND_DOWN) {
    if (!messages().some((m) => m.sticky && m.text === text)) setMessages((m) => [...m, { id: nextId++, text, kind: "error", sticky: true }]);
    return;
  }
  const now = Date.now();
  // Backend/WS outages can emit the same error several times in one render
  // cycle. Keep the first useful message and suppress that repeated burst.
  if (kind === "error" && text === lastErrorText && now - lastErrorAt < 4000) return;
  if (kind === "error") { lastErrorAt = now; lastErrorText = text; }
  const id = nextId++;
  setMessages((m) => [...m, { id, text, kind }]);
  setTimeout(() => dismiss(id), 7000);
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
          <span class="leading-5 break-words min-w-0 flex-1">{m.text}</span>
          <Show when={m.sticky}>
            <button type="button" class="shrink-0 leading-5 text-zinc-500 hover:text-zinc-300" title="关闭" aria-label="关闭" onClick={() => dismiss(m.id)}>✕</button>
          </Show>
        </div>
      )}
    </For>
  </div>
);
