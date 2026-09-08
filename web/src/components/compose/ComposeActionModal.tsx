import { Component, createSignal, Show } from "solid-js";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { PullOptions, pullOptionsPayload } from "../shared/PullOptions";
import { enqueue, isPending } from "../../stores/taskQueue";
import { VERB_LABEL, type ComposeVerb } from "./composeShared";

export interface ComposeAction { id: string; name: string; verb: ComposeVerb; }

// compose up/stop/down/restart/pull through the global task queue. One
// implementation shared by ComposeListPage and ComposeDetailPage (they used
// to carry identical copies of these signals + the options modal + widget).
// Project id is the task key, so two ops on one project run in order and
// never hit the backend's per-project 409.
export const startComposeAction = (a: ComposeAction, body?: unknown) => enqueue({
  title: `${VERB_LABEL[a.verb]} — ${a.name}`,
  url: `/api/compose/${a.verb}?id=${encodeURIComponent(a.id)}`,
  body,
  key: `compose:${a.id}`,
  meta: { composeId: a.id, verb: a.verb },
}).done;

export const isComposeRunning = (id: string, verb: ComposeVerb) =>
  isPending((t) => t.meta?.composeId === id && t.meta?.verb === verb);

// up/pull take proxy/registry options → open the modal; the rest run directly.
export const requestComposeAction = (a: ComposeAction, openOptions: (a: ComposeAction) => void) => {
  if (a.verb === "up" || a.verb === "pull") openOptions(a);
  else void startComposeAction(a);
};

export const ComposeActionModal: Component<{ target: ComposeAction | null; onClose: () => void }> = (props) => {
  const [proxyUrl, setProxyUrl] = createSignal("");
  const [registryIds, setRegistryIds] = createSignal<string[]>([]);
  const close = () => { setProxyUrl(""); setRegistryIds([]); props.onClose(); };
  const start = () => {
    const t = props.target;
    if (!t) return;
    const options = pullOptionsPayload({ proxyUrl: proxyUrl(), registryIds: registryIds() });
    void startComposeAction(t, Object.keys(options).length > 0 ? options : undefined);
    close();
  };
  return (
    <Show when={props.target}>
      {(t) => (
        <Modal open onClose={close} title={`${VERB_LABEL[t().verb]} — ${t().name}`}>
          <p class="mb-3 text-xs text-zinc-500">代理和仓库凭据仅对本次 Compose 操作生效，不会写入项目文件或容器环境。</p>
          <PullOptions
            proxyUrl={proxyUrl()}
            registryIds={registryIds()}
            multipleRegistries
            onProxyUrlChange={setProxyUrl}
            onRegistryIdsChange={setRegistryIds}
          />
          <div class="mt-4 flex justify-end gap-2">
            <Button onClick={close}>取消</Button>
            <Button variant="primary" onClick={start}>{VERB_LABEL[t().verb]}</Button>
          </div>
        </Modal>
      )}
    </Show>
  );
};
