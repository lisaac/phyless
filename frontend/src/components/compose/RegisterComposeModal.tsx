import { Component, createSignal, createEffect, Show } from "solid-js";
import { Modal } from "../shared/Modal";
import { Button } from "../shared/Button";
import { CodeEditor } from "../shared/CodeEditor";
import { PathPicker } from "../shared/PathPicker";
import { get } from "../../api/client";
import { queued } from "../../stores/taskQueue";
import { fetchTextFile } from "../../api/textFile";
import { toast } from "../shared/Toast";
import type { FileEntry } from "../../types";

const COMPOSE_NAMES = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];

// Name fallback when the user leaves 名称 empty: last path segment.
export const dirBasename = (dir: string) => dir.replace(/\/+$/, "").split("/").pop() || dir;

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

// Registers a compose project: name + a path-autocompleted base directory +
// a compose.yaml file. Two distinct intents share this one dialog, and
// behavior branches on whether <base_dir>/<file name> already exists:
//
//  - Doesn't exist yet: this is "write a brand new project" (e.g. handed off
//    from CreateContainerModal's multi-service detection with a draft
//    compose.yaml already in the box) — submitting WRITES composeContent()
//    to that path, then registers it.
//  - Already exists: this is "register a project that's already sitting on
//    disk" — submitting does NOT write anything by default, just points
//    base_dir/compose_file at the existing file. "加载现有内容" lets the user
//    peek at that file's real content first, purely for review. To actually
//    save edits over an existing file the user must tick 覆盖 (overwrite());
//    without it the write is skipped regardless of what's in the box.
//
// This used to auto-load an existing file's content into the box the moment
// a matching path was typed, which silently clobbered whatever draft the
// user had (including one handed off from CreateContainerModal). Then it
// was flipped to reject registration outright when the file already
// existed — which broke the legitimate "register something already
// written" case. Branching on existence instead of erroring covers both.
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
  const [overwrite, setOverwrite] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  // Names present in baseDir() right now, for the live "already exists"
  // hint — submit() re-checks fresh against the server rather than trusting
  // this, since it can be stale by the time the user actually clicks 注册.
  const [dirNames, setDirNames] = createSignal<Set<string>>(new Set());

  createEffect(() => {
    if (!props.open) return;
    setName("");
    setBaseDir("");
    setComposeContent(props.initialCompose ?? "");
    setComposeName("compose.yaml");
    setEnvFile("");
    setOverwrite(false);
    setDirNames(new Set<string>());
  });

  // Auto-detect an existing compose file name / .env path whenever the
  // directory changes — content itself is never touched here.
  createEffect(() => {
    const dir = baseDir().trim();
    if (!dir) { setDirNames(new Set<string>()); return; }
    void (async () => {
      let entries: FileEntry[];
      try { entries = await get<FileEntry[]>(`/api/fs/list?path=${encodeURIComponent(dir)}`); }
      catch { setDirNames(new Set<string>()); return; } // directory doesn't exist yet (or isn't readable)
      const names = new Set(entries.map((e) => e.name));
      setDirNames(names);
      const found = COMPOSE_NAMES.find((n) => names.has(n));
      if (found) setComposeName(found);
      if (names.has(".env")) setEnvFile(joinPath(dir, ".env"));
    })();
  });

  const fileExists = () => dirNames().has(composeName().trim() || "compose.yaml");

  const loadExisting = async () => {
    const dir = baseDir().trim();
    const cName = composeName().trim() || "compose.yaml";
    setLoading(true);
    try {
      const result = await fetchTextFile(`/api/fs/file?path=${encodeURIComponent(joinPath(dir, cName))}`);
      if (result) setComposeContent(result.text);
    } catch (e) { toast.error((e as Error).message); }
    finally { setLoading(false); }
  };

  const submit = async () => {
    const dir = baseDir().trim();
    const cName = composeName().trim() || "compose.yaml";
    if (!dir) { toast.error("请填写路径"); return; }
    const n = name().trim() || dirBasename(dir);
    setSaving(true);
    try {
      // Fresh check right before writing — dirNames() can be stale (typed
      // the path, then changed the filename, or the directory changed on
      // disk in between). If the file already exists, this registers it
      // as-is and skips the write entirely — never overwrite something
      // already on disk with whatever happens to be in the box.
      let targetExists = false;
      try {
        const entries = await get<FileEntry[]>(`/api/fs/list?path=${encodeURIComponent(dir)}`);
        targetExists = entries.some((e) => e.name === cName);
      } catch { /* directory doesn't exist yet — nothing to conflict with, MkdirAll below creates it */ }

      const composeFilePath = joinPath(dir, cName);
      if (!targetExists || overwrite()) {
        // /api/fs/file's PUT handler (backend/internal/api/fs.go) MkdirAlls the
        // file's parent directory before writing, so a base_dir that
        // doesn't exist yet gets created as a side effect of writing here.
        await queued(`写入 ${composeFilePath}`, "PUT", `/api/fs/file?path=${encodeURIComponent(composeFilePath)}`, composeContent());
      }
      await queued(`注册 Compose ${n}`, "POST", "/api/compose", {
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
          <input class={fieldCls} placeholder="留空则使用目录名" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        <label class="block">
          <span class="mb-1 block text-xs text-zinc-400">路径</span>
          <PathPicker value={baseDir()} onChange={setBaseDir} placeholder="/opt/stacks/app" />
        </label>
        {/* Not a <label> — a <label> wrapping both the filename input AND the
            code editor below meant clicking anywhere in the editor (native
            label→control focus behavior) redirected focus straight back to
            the filename input, making the editor unclickable. */}
        <div class="block">
          <div class="mb-1 flex items-center justify-between gap-2">
            <span class="text-xs text-zinc-400">compose.yaml</span>
            <div class="flex items-center gap-1.5">
              <span class="text-xs text-zinc-500">文件名</span>
              <input
                class={`${fieldCls} w-40`}
                value={composeName()}
                onInput={(e) => setComposeName(e.currentTarget.value)}
                placeholder="compose.yaml"
              />
            </div>
          </div>
          <div class="h-64 border border-zinc-800">
            <CodeEditor value={composeContent()} onChange={setComposeContent} language="yaml" />
          </div>
          <div class="mt-1 flex items-center justify-between gap-2">
            <Show
              when={fileExists()}
              fallback={<p class="text-xs text-zinc-500">路径下不存在则会新建此文件</p>}
            >
              <label class="flex cursor-pointer items-center gap-1.5 text-xs text-amber-400">
                <input type="checkbox" checked={overwrite()} onChange={(e) => setOverwrite(e.currentTarget.checked)} />
                {overwrite() ? "将用下方内容覆盖现有文件" : "已检测到现有文件，默认不写入下方内容（勾选可覆盖）"}
              </label>
              <Button disabled={loading()} onClick={() => void loadExisting()}>加载现有内容</Button>
            </Show>
          </div>
        </div>
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
