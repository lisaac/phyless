import { Component, createSignal, Show } from "solid-js";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { PullOptions, createPullOptions, isBrowserDownload } from "../shared/PullOptions";
import { enqueue, isPending } from "../../stores/taskQueue";
import { toast } from "../shared/Toast";
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

// up/pull/build take proxy/registry options → open the modal; the rest run
// directly. build needs the proxy to pre-pull its FROM base images.
export const requestComposeAction = (a: ComposeAction, openOptions: (a: ComposeAction) => void) => {
  if (a.verb === "up" || a.verb === "pull" || a.verb === "build") openOptions(a);
  else void startComposeAction(a);
};

export const ComposeActionModal: Component<{ target: ComposeAction | null; onClose: () => void }> = (props) => {
  const pull = createPullOptions();
  const [pullPolicy, setPullPolicy] = createSignal("missing"); // up only
  const close = () => { pull.reset(); setPullPolicy("missing"); props.onClose(); };
  const start = () => {
    const t = props.target;
    if (!t) return;
    if (isBrowserDownload(pull.value)) {
      if (!pull.value.workerUrl?.trim()) { toast.error("请先填写 CF worker 地址"); return; }
      enqueue({
        title: `${VERB_LABEL[t.verb]} — ${t.name}`,
        url: "",
        key: `compose:${t.id}`,
        meta: { type: "browser-pull-compose", composeId: t.id, verb: t.verb, mode: t.verb === "up" ? "up" : "pull", workerUrl: pull.value.workerUrl ?? "" },
        secret: pull.value.creds?.secret ? { creds: pull.value.creds } : undefined,
      });
      close();
      return;
    }
    const options = { ...pull.payload(), ...(t.verb === "up" ? { pull_policy: pullPolicy() } : {}) };
    void startComposeAction(t, Object.keys(options).length > 0 ? options : undefined);
    close();
  };
  return (
    <Show when={props.target}>
      {(t) => (
        <Modal open onClose={close} title={`${VERB_LABEL[t().verb]} — ${t().name}`}>
          <p class="mb-3 text-xs text-zinc-500">代理和仓库凭据仅对本次 Compose 操作生效，不会写入项目文件或容器环境。</p>
          <Show when={t().verb === "up" && !isBrowserDownload(pull.value)}>
            <label class="mb-3 block">
              <span class="mb-1 block text-xs text-zinc-500">镜像拉取策略</span>
              <div class="relative">
                <select
                  class="w-full appearance-none border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 pr-8 text-sm outline-none focus:border-indigo-500"
                  aria-label="镜像拉取策略"
                  value={pullPolicy()}
                  onChange={(e) => setPullPolicy(e.currentTarget.value)}
                >
                  <option value="missing">缺失时拉取（默认）</option>
                  <option value="never">不拉取，使用本地已有镜像</option>
                  <option value="always">总是拉取</option>
                </select>
                <span class="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-zinc-500">▾</span>
              </div>
            </label>
          </Show>
          {/* build pre-pulls base images server-side through the proxy; the
              browser-download path has no build mode, so hide it for build. */}
          <PullOptions options={pull} multipleRegistries allowBrowser={t().verb !== "build"} />
          <div class="mt-4 flex justify-end gap-2">
            <Button onClick={close}>取消</Button>
            <Button variant="primary" onClick={start}>{VERB_LABEL[t().verb]}</Button>
          </div>
        </Modal>
      )}
    </Show>
  );
};
