import { Component, createSignal } from "solid-js";
import { Button } from "./Button";
import { Modal } from "./Modal";

type ConfirmOptions = {
  title?: string;
  confirmText?: string;
  danger?: boolean;
};
type PendingConfirm = ConfirmOptions & { message: string; resolve: (confirmed: boolean) => void };

const [pending, setPending] = createSignal<PendingConfirm | null>(null);

/** Opens the app's modal confirmation dialog instead of the browser prompt. */
export const confirmAction = (message: string, options: ConfirmOptions = {}) => new Promise<boolean>((resolve) => {
  pending()?.resolve(false);
  setPending({ message, ...options, resolve });
});

const resolve = (confirmed: boolean) => {
  const current = pending();
  if (!current) return;
  setPending(null);
  current.resolve(confirmed);
};

export const ConfirmModal: Component = () => (
  <Modal open={!!pending()} onClose={() => resolve(false)} title={pending()?.title ?? "确认操作"} priority>
    <p class="mb-4 whitespace-pre-line text-sm text-zinc-300">{pending()?.message}</p>
    <div class="flex justify-end gap-2">
      <Button onClick={() => resolve(false)}>取消</Button>
      <Button variant={pending()?.danger ? "danger" : "primary"} onClick={() => resolve(true)}>
        {pending()?.confirmText ?? "确认"}
      </Button>
    </div>
  </Modal>
);
