import { Component, createSignal, createEffect } from "solid-js";
import { Modal } from "../shared/Modal";
import { Button } from "../shared/Button";
import { CodeEditor } from "../shared/CodeEditor";
import { PathPicker } from "../shared/PathPicker";
import { get, post, put } from "../../api/client";
import { fetchTextFile } from "../../api/textFile";
import { toast } from "../shared/Toast";
import type { FileEntry } from "../../types";

const COMPOSE_NAMES = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

// Registers a compose project: name + a path-autocompleted base directory +
// the compose.yaml's actual content (not just a file path) + an optional
// .env path. If the chosen directory already has a compose/docker-compose
// file, its content is auto-loaded for review; otherwise the box starts
// with whatever the caller pre-filled (or empty), and submitting WRITES
// that content to <base_dir>/compose.yaml — this is what lets
// CreateContainerModal's multi-service detection hand off straight into
// registering a brand new project instead of only being able to point at
// something already on disk.
export const RegisterComposeModal: Component<{
  open: boolean;
  onClose: () => void;
  onRegistered: () => void;
  initialCompose?: string;
}> = (props) => {
  const [name, setName] = createSignal("");
  const [baseDir, setBaseDir] = createSignal("");
  const [composeContent, setComposeContent] = createSignal("");
  const [composeName, setComposeName] = createSignal("compose.yaml");
  const [envFile, setEnvFile] = createSignal("");
  const [saving, setSaving] = createSignal(false);

  createEffect(() => {
    if (!props.open) return;
    setName("");
    setBaseDir("");
    setComposeContent(props.initialCompose ?? "");
    setComposeName("compose.yaml");
    setEnvFile("");
  });

  // Auto-detect an existing compose file / .env whenever the directory changes.
  createEffect(() => {
    const dir = baseDir().trim();
    if (!dir) return;
    void (async () => {
      let entries: FileEntry[];
      try { entries = await get<FileEntry[]>(`/api/fs/list?path=${encodeURIComponent(dir)}`); }
      catch { return; } // directory doesn't exist yet (or isn't readable) — nothing to detect
      const names = new Set(entries.map((e) => e.name));
      const found = COMPOSE_NAMES.find((n) => names.has(n));
      if (found) {
        setComposeName(found);
        try {
          const result = await fetchTextFile(`/api/fs/file?path=${encodeURIComponent(joinPath(dir, found))}`);
          if (result) setComposeContent(result.text);
        } catch { /* leave whatever's already in the box */ }
      }
      if (names.has(".env")) setEnvFile(joinPath(dir, ".env"));
    })();
  });

  const submit = async () => {
    const dir = baseDir().trim();
    const n = name().trim();
    if (!n || !dir) { toast.error("请填写名称和路径"); return; }
    setSaving(true);
    try {
      const composeFilePath = joinPath(dir, composeName() || "compose.yaml");
      await put(`/api/fs/file?path=${encodeURIComponent(composeFilePath)}`, composeContent());
      await post("/api/compose", {
        name: n,
        base_dir: dir,
        compose_file: composeFilePath,
        env_file: envFile().trim(),
      });
      toast.success("已注册");
      props.onRegistered();
    } catch (e) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  const fieldCls = "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-500";

  return (
    <Modal open={props.open} onClose={props.onClose} title="注册 Compose 项目" wide>
      <div class="flex flex-col gap-3">
        <label class="block">
          <span class="mb-1 block text-xs text-zinc-400">名称</span>
          <input class={fieldCls} placeholder="my-app" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        <label class="block">
          <span class="mb-1 block text-xs text-zinc-400">路径</span>
          <PathPicker value={baseDir()} onChange={setBaseDir} placeholder="/opt/stacks/app" />
        </label>
        <label class="block">
          <span class="mb-1 block text-xs text-zinc-400">
            {composeName()}{composeName() !== "compose.yaml" ? "（已检测到现有文件）" : "（路径下不存在则会新建此文件）"}
          </span>
          <div class="h-64 border border-zinc-800">
            <CodeEditor value={composeContent()} onChange={setComposeContent} language="yaml" />
          </div>
        </label>
        <label class="block">
          <span class="mb-1 block text-xs text-zinc-400">env 文件路径（可选）</span>
          <input class={fieldCls} placeholder="/opt/stacks/app/.env" value={envFile()} onInput={(e) => setEnvFile(e.currentTarget.value)} />
        </label>
      </div>
      <div class="mt-4 flex justify-end gap-2">
        <Button onClick={props.onClose}>取消</Button>
        <Button variant="primary" disabled={saving()} onClick={() => void submit()}>注册</Button>
      </div>
    </Modal>
  );
};
