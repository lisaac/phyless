import { Component, createSignal } from "solid-js";
import { Modal } from "../shared/Modal";
import { Button } from "../shared/Button";
import { enqueue } from "../../stores/taskQueue";

// Imports a container filesystem tar (the reverse of ContainerDetailPage's
// "导出 tar" / `docker export`) via the existing /api/containers/import
// endpoint, which wraps `docker import` — this always produces a new IMAGE,
// never a running container directly, since a plain filesystem tarball
// carries no command/env/etc. From the resulting image, use the normal
// "+ 新建容器" flow to launch it. Runs through the global task queue (upload
// progress + streamed import output show in the task panel).
export const ImportContainerModal: Component<{ open: boolean; onClose: () => void }> = (props) => {
  const [ref, setRef] = createSignal("");
  const [file, setFile] = createSignal<File | undefined>(undefined);

  const submit = () => {
    const f = file();
    if (!f || !ref().trim()) return;
    enqueue({ title: `导入 ${f.name} → ${ref()}`, url: `/api/containers/import?ref=${encodeURIComponent(ref())}`, file: f });
    setRef(""); setFile(undefined);
    props.onClose();
  };

  return (
      <Modal open={props.open} onClose={props.onClose} title="导入容器（tar → 镜像）">
        <div class="flex flex-col gap-3">
          <label class="flex flex-col gap-1">
            <span class="text-xs text-zinc-400">tar 文件（如 docker export 导出的文件）</span>
            <input
              type="file"
              accept=".tar"
              class="w-full text-sm text-zinc-300 file:mr-3 file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-zinc-200 file:hover:bg-zinc-700"
              onChange={(e) => setFile(e.currentTarget.files?.[0] ?? undefined)}
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-zinc-400">镜像名称:标签</span>
            <input
              class="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-500"
              value={ref()}
              onInput={(e) => setRef(e.currentTarget.value)}
              placeholder="imported/myapp:latest"
            />
          </label>
          <p class="text-xs text-zinc-500">
            导入只会生成一个新镜像，不会直接生成容器——tar 归档不包含启动命令、
            环境变量等信息。导入成功后可用该镜像新建容器。
          </p>
        </div>
        <div class="mt-4 flex justify-end gap-2">
          <Button onClick={props.onClose}>取消</Button>
          <Button variant="primary" disabled={!file() || !ref().trim()} onClick={submit}>导入</Button>
        </div>
      </Modal>
  );
};
