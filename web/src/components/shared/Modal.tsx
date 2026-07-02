import { Component, JSX, Show } from "solid-js";

export const Modal: Component<{
  open: boolean;
  onClose: () => void;
  title: string;
  children: JSX.Element;
  wide?: boolean;
  noBackdropClose?: boolean;
}> = (props) => (
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
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" width="16" height="16">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div class="p-5">{props.children}</div>
      </div>
    </div>
  </Show>
);
