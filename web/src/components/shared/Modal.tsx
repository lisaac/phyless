import { Component, JSX, Show, createEffect, onCleanup } from "solid-js";

export const Modal: Component<{
  open: boolean;
  onClose: () => void;
  title: string;
  children: JSX.Element;
  wide?: boolean;
  noBackdropClose?: boolean;
}> = (props) => {
  // Esc always closes, even for noBackdropClose modals — that prop only
  // guards against an accidental click outside the dialog, not a deliberate
  // key press.
  createEffect(() => {
    if (!props.open) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/65 px-0 py-0 sm:px-4 sm:py-8"
        onClick={() => !props.noBackdropClose && props.onClose()}
      >
        <div
          class={`relative min-h-screen w-full bg-zinc-900 shadow-2xl sm:min-h-0 sm:rounded-xl sm:border sm:border-zinc-700/50 ${
            props.wide ? "sm:max-w-6xl" : "sm:max-w-md"
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div class="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
            <h2 class="text-sm font-semibold text-zinc-200">{props.title}</h2>
            <button
              class="p-1 text-zinc-500 transition-colors hover:text-zinc-200"
              onClick={props.onClose}
              aria-label="关闭"
            >
              ✕
            </button>
          </div>
          <div class="p-5">{props.children}</div>
        </div>
      </div>
    </Show>
  );
};
