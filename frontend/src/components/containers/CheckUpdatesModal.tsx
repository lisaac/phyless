import { Component, Show } from "solid-js";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { PullOptions, createPullOptions, isBrowserDownload, browserWorkerReady } from "../shared/PullOptions";
import { enqueue } from "../../stores/taskQueue";

// Check-for-updates dialog: same pull options as the upgrade dialog, because
// the check must reach the registry the same way the later pull will.
export const CheckUpdatesModal: Component<{
  targets: { id: string; name: string }[] | null;
  onClose: () => void;
}> = (props) => {
  const pull = createPullOptions();
  const close = () => { pull.reset(); props.onClose(); };
  const start = () => {
    const ts = props.targets ?? [];
    if (ts.length === 0) return;
    const browser = isBrowserDownload(pull.value);
    if (!browserWorkerReady(pull.value)) return;
    const options = pull.payload();
    enqueue({
      title: `检查升级（${ts.length} 个容器）`,
      url: "",
      body: !browser && Object.keys(options).length > 0 ? options : undefined,
      meta: {
        type: "update-check",
        mode: browser ? "browser" : "server",
        checkIds: ts.map((t) => t.id),
        workerUrl: browser ? pull.value.workerUrl ?? "" : undefined,
      },
      secret: browser && pull.value.creds?.secret ? { creds: pull.value.creds } : undefined,
    });
    close();
  };
  return (
    <Show when={props.targets?.length}>
      <Modal open onClose={close} title="检查升级">
        <p class="mb-3 text-xs text-zinc-500">
          将检查 {props.targets!.length} 个容器：只读取 registry 的 manifest 比对镜像，不下载、不重建。网络路径与拉取相同，请选择与升级时一致的代理。
        </p>
        <PullOptions options={pull} allowBrowser multipleRegistries />
        <div class="mt-4 flex justify-end gap-2">
          <Button onClick={close}>取消</Button>
          <Button variant="primary" onClick={start}>检查</Button>
        </div>
      </Modal>
    </Show>
  );
};
