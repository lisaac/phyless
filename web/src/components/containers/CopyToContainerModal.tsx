import { Component, createSignal, createEffect, createResource, For, Show } from "solid-js";
import { Modal } from "../shared/Modal";
import { Button } from "../shared/Button";
import { PullStatusWidget } from "../shared/PullStatusWidget";
import { get } from "../../api/client";
import { containerName } from "./containerActions";
import type { ContainerSummary } from "../../types";

// Copies a file/dir from one container's filesystem straight into another's,
// via the backend's copy-to endpoint (CopyFromContainer piped into
// CopyToContainer — the same two calls `docker cp` makes between containers).
export const CopyToContainerModal: Component<{
  source: { containerId: string; path: string } | null;
  onClose: () => void;
}> = (props) => {
  const [targetId, setTargetId] = createSignal("");
  const [targetPath, setTargetPath] = createSignal("");
  const [copying, setCopying] = createSignal(false);
  const [containers] = createResource(() => props.source, () => get<ContainerSummary[]>("/api/containers"));

  createEffect(() => {
    if (props.source) {
      setTargetId("");
      setTargetPath(props.source.path);
    }
  });

  const others = () => (containers() ?? []).filter((c) => c.Id !== props.source?.containerId);
  const targetContainerLabel = () => {
    const c = others().find((x) => x.Id === targetId());
    return c ? containerName(c) : "";
  };

  const confirm = () => {
    if (!targetId() || !targetPath()) return;
    setCopying(true);
  };

  return (
    <>
      <Modal open={!!props.source && !copying()} onClose={props.onClose} title={`复制到其他容器 — ${props.source?.path ?? ""}`}>
        <div class="flex flex-col gap-3">
          <label class="flex flex-col gap-1">
            <span class="text-xs text-zinc-400">目标容器</span>
            <select
              class="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-500"
              value={targetId()}
              onChange={(e) => setTargetId(e.currentTarget.value)}
            >
              <option value="">选择容器…</option>
              <For each={others()}>
                {(c) => <option value={c.Id}>{containerName(c)}</option>}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-zinc-400">目标路径</span>
            <input
              class="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-500"
              value={targetPath()}
              onInput={(e) => setTargetPath(e.currentTarget.value)}
              placeholder="/path/in/target"
            />
          </label>
        </div>
        <div class="mt-4 flex justify-end gap-2">
          <Button onClick={props.onClose}>取消</Button>
          <Button variant="primary" disabled={!targetId() || !targetPath()} onClick={confirm}>确定</Button>
        </div>
      </Modal>

      <PullStatusWidget
        active={copying()}
        onClose={() => { setCopying(false); props.onClose(); }}
        title={`复制 ${props.source?.path ?? ""} → ${targetContainerLabel() || targetId()}`}
        url={`/api/containers/${props.source?.containerId}/files/copy-to?path=${encodeURIComponent(props.source?.path ?? "")}`}
        body={{ target_id: targetId(), target_path: targetPath() }}
      />
    </>
  );
};
