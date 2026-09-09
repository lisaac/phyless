import { Component, Show } from "solid-js";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { PullOptions, createPullOptions } from "../shared/PullOptions";
import { enqueue } from "../../stores/taskQueue";

// Shared container-upgrade dialog: pull the target's image with the chosen proxy
// options, then replace the container. Page-level (one instance per page); the
// list rows just hand it a target. Server-side proxy only — mirrors the flow the
// detail page has always used.
export const UpgradeContainerModal: Component<{
  target: { id: string; name: string } | null;
  onClose: () => void;
}> = (props) => {
  const pull = createPullOptions();
  const close = () => { pull.reset(); props.onClose(); };
  const start = () => {
    const t = props.target;
    if (!t) return;
    const options = pull.payload();
    enqueue({
      title: `升级 — ${t.name}`,
      url: `/api/containers/${t.id}/upgrade`,
      body: Object.keys(options).length > 0 ? options : undefined,
      key: t.id,
      meta: { type: "upgrade", containerId: t.id },
    });
    close();
  };
  return (
    <Show when={props.target}>
      {(t) => (
        <Modal open onClose={close} title={`升级 — ${t().name}`}>
          <p class="mb-3 text-xs text-zinc-500">先按本次选项拉取镜像，成功后再替换容器；留空则沿用 Docker 默认行为。</p>
          <PullOptions options={pull} />
          <div class="mt-4 flex justify-end gap-2">
            <Button onClick={close}>取消</Button>
            <Button variant="primary" onClick={start}>升级</Button>
          </div>
        </Modal>
      )}
    </Show>
  );
};
