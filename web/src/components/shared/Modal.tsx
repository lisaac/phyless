import { Component, JSX, Show } from "solid-js";

export const Modal: Component<{
  open: boolean;
  onClose: () => void;
  title: string;
  children: JSX.Element;
  wide?: boolean;
}> = (props) => (
  <Show when={props.open}>
    <div
      class="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
      onClick={props.onClose}
    >
      <div
        class={`max-h-[90vh] overflow-auto rounded-lg bg-zinc-900 p-5 shadow-xl ${
          props.wide ? "w-[80vw]" : "w-[28rem]"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-base font-semibold">{props.title}</h2>
          <button class="text-zinc-400 hover:text-zinc-100" onClick={props.onClose}>✕</button>
        </div>
        {props.children}
      </div>
    </div>
  </Show>
);
