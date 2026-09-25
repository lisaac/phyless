import { Component, createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { Modal } from "../shared/Modal";
import { Button } from "../shared/Button";
import { CodeEditor } from "../shared/CodeEditor";
import { PathPicker } from "../shared/PathPicker";
import { get } from "../../api/client";
import { queued } from "../../stores/taskQueue";
import { fetchTextFile } from "../../api/textFile";
import { toast } from "../shared/Toast";
import type { FileEntry } from "../../types";

export const dirBasename = (dir: string) => dir.replace(/\/+$/, "").split("/").pop() || dir;
const parentDir = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const newNamePattern = /^[a-z0-9][a-z0-9_-]*$/;

export const RegisterComposeModal: Component<{
  open: boolean;
  onClose: () => void;
  onRegistered: () => void;
  initialCompose?: string;
}> = (props) => {
  const [mode, setMode] = createSignal<"new" | "existing">("new");
  const [name, setName] = createSignal("");
  const [composePath, setComposePath] = createSignal("");
  const [composeContent, setComposeContent] = createSignal("");
  const [envContent, setEnvContent] = createSignal("");
  const [loadedPath, setLoadedPath] = createSignal("");
  const [originalCompose, setOriginalCompose] = createSignal("");
  const [originalEnv, setOriginalEnv] = createSignal("");
  const [existingEnv, setExistingEnv] = createSignal(false);
  const [composeTruncated, setComposeTruncated] = createSignal(false);
  const [envTruncated, setEnvTruncated] = createSignal(false);
  const [loadError, setLoadError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);

  const chooseMode = (next: "new" | "existing") => {
    setMode(next);
    if (next === "new") {
      setComposeContent(props.initialCompose ?? "");
      setEnvContent("");
      setComposeTruncated(false);
      setEnvTruncated(false);
    }
  };

  createEffect(on(() => props.open, (open) => {
    if (!open) return;
    setMode("new");
    setName("");
    setComposePath("");
    setComposeContent(props.initialCompose ?? "");
    setEnvContent("");
    setLoadedPath("");
    setLoadError("");
  }));

  createEffect(on(() => [props.open, mode(), composePath()] as const, ([open, selectedMode, path]) => {
    if (!open || selectedMode !== "existing") return;
    setLoadedPath("");
    setLoadError("");
    setComposeContent("");
    setEnvContent("");
    setLoading(false);
    if (!/\.ya?ml$/i.test(path)) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const dir = parentDir(path);
        const entries = await get<FileEntry[]>("/api/fs/list?path=" + encodeURIComponent(dir), controller.signal);
        if (!entries.some((entry) => !entry.is_dir && entry.name === dirBasename(path))) {
          throw new Error("请选择已有的 YAML 文件");
        }
        const envPath = (dir === "/" ? "" : dir) + "/.env";
        const hasEnv = entries.some((entry) => !entry.is_dir && entry.name === ".env");
        const [compose, env] = await Promise.all([
          fetchTextFile("/api/fs/file?path=" + encodeURIComponent(path), controller.signal),
          hasEnv ? fetchTextFile("/api/fs/file?path=" + encodeURIComponent(envPath), controller.signal) : Promise.resolve(null),
        ]);
        if (controller.signal.aborted || !compose) return;
        setComposeContent(compose.text);
        setOriginalCompose(compose.text);
        setComposeTruncated(compose.truncated);
        setEnvContent(env?.text ?? "");
        setOriginalEnv(env?.text ?? "");
        setEnvTruncated(env?.truncated ?? false);
        setExistingEnv(hasEnv);
        setLoadedPath(path);
      } catch (error) {
        if (!controller.signal.aborted) setLoadError((error as Error).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    onCleanup(() => { clearTimeout(timer); controller.abort(); });
  }));

  const submit = async () => {
    const creating = mode() === "new";
    const path = composePath().trim();
    const dir = parentDir(path);
    const projectName = name().trim() || (creating ? "" : dirBasename(dir));
    if (creating && !newNamePattern.test(projectName)) {
      toast.error("名称需以小写字母或数字开头，只能包含小写字母、数字、_ 和 -");
      return;
    }
    if (creating && !composeContent().trim()) { toast.error("请填写 compose.yaml"); return; }
    if (!creating && loadedPath() !== path) { toast.error("请先选择并加载已有 YAML 文件"); return; }
    if (!creating && ((composeTruncated() && composeContent() !== originalCompose()) ||
      (envTruncated() && envContent() !== originalEnv()))) {
      toast.error("文件过大，无法保存截断后的内容");
      return;
    }

    setSaving(true);
    try {
      if (creating) {
        await queued("新建 Compose " + projectName, "POST", "/api/compose/new", {
          name: projectName, compose_content: composeContent(), env_content: envContent(),
        });
      } else {
        const entries = await get<FileEntry[]>("/api/fs/list?path=" + encodeURIComponent(dir));
        if (!entries.some((entry) => !entry.is_dir && entry.name === dirBasename(path))) {
          throw new Error("所选 Compose 文件已不存在");
        }
        // Existing files stay untouched unless their editor was changed.
        if (composeContent() !== originalCompose()) {
          const latest = await fetchTextFile("/api/fs/file?path=" + encodeURIComponent(path));
          if (!latest || latest.text !== originalCompose()) throw new Error("Compose 文件已在其他位置修改，请重新选择后再保存");
          await queued("保存 " + path, "PUT", "/api/fs/file?path=" + encodeURIComponent(path), composeContent());
        }
        const envPath = (dir === "/" ? "" : dir) + "/.env";
        if (envContent() !== originalEnv()) {
          const envStillExists = entries.some((entry) => !entry.is_dir && entry.name === ".env");
          if (envStillExists !== existingEnv()) throw new Error(".env 文件已在其他位置修改，请重新选择后再保存");
          if (envStillExists) {
            const latest = await fetchTextFile("/api/fs/file?path=" + encodeURIComponent(envPath));
            if (!latest || latest.text !== originalEnv()) throw new Error(".env 文件已在其他位置修改，请重新选择后再保存");
          }
          await queued("保存 " + envPath, "PUT", "/api/fs/file?path=" + encodeURIComponent(envPath), envContent());
        }
        await queued("注册 Compose " + projectName, "POST", "/api/compose", {
          name: projectName, base_dir: dir, compose_file: path,
          env_file: existingEnv() || envContent() ? envPath : "",
        });
      }
      toast.success(creating ? "已新建并注册" : "已注册");
      props.onRegistered();
    } catch (error) { toast.error((error as Error).message); }
    finally { setSaving(false); }
  };

  const inputClass = "w-full border border-zinc-700 bg-zinc-800 px-2.5 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500";

  return (
    <Modal open={props.open} onClose={props.onClose} title="注册 Compose 项目" wide>
      <div class="mb-4 flex flex-wrap gap-5 border-b border-zinc-800 pb-4 text-sm">
        <label class="flex cursor-pointer items-center gap-2">
          <input type="radio" name="compose-mode" checked={mode() === "new"} onChange={() => chooseMode("new")} />
          新建 Compose
        </label>
        <label class="flex cursor-pointer items-center gap-2">
          <input type="radio" name="compose-mode" checked={mode() === "existing"} onChange={() => chooseMode("existing")} />
          注册已有 Compose
        </label>
      </div>
      <div class="mb-4 grid gap-3 md:grid-cols-2">
        <label class="block text-xs text-zinc-400">
          名称 {mode() === "existing" && <span class="text-zinc-500">（可选，默认使用目录名）</span>}
          <input class={"mt-1 " + inputClass} value={name()} onInput={(event) => setName(event.currentTarget.value)} placeholder={mode() === "new" ? "例如 my-app" : "留空使用目录名"} />
        </label>
        <Show when={mode() === "existing"} fallback={
          <div class="self-end pb-2 text-xs text-zinc-500">
            将在当前服务器的 Compose 存储目录中新建同名文件夹。
          </div>
        }>
          <label class="block text-xs text-zinc-400">
            已有 Compose YAML 文件
            <div class="mt-1"><PathPicker value={composePath()} onChange={setComposePath} files placeholder="/srv/my-app/compose.yaml" /></div>
          </label>
        </Show>
      </div>
      <Show when={mode() === "existing" && (loading() || loadError())}>
        <p class={"mb-3 text-xs " + (loadError() ? "text-red-400" : "text-zinc-500")}>
          {loadError() || "正在读取项目文件…"}
        </p>
      </Show>
      <div class="grid gap-4 md:grid-cols-2">
        <section class="min-w-0">
          <div class="mb-2 flex items-center justify-between text-xs text-zinc-400">
            <span>{mode() === "new" ? "compose.yaml" : dirBasename(composePath()) || "Compose YAML"}</span>
            <Show when={composeTruncated()}><span class="text-amber-400">内容已截断</span></Show>
          </div>
          <div class="h-64 md:h-[22rem]"><CodeEditor value={composeContent()} onChange={setComposeContent} language="yaml" /></div>
        </section>
        <section class="min-w-0">
          <div class="mb-2 flex items-center justify-between text-xs text-zinc-400">
            <span>.env</span>
            <Show when={envTruncated()}><span class="text-amber-400">内容已截断</span></Show>
          </div>
          <div class="h-64 md:h-[22rem]"><CodeEditor value={envContent()} onChange={setEnvContent} language="text" /></div>
        </section>
      </div>
      <p class="mt-2 text-xs text-zinc-500">
        {mode() === "new" ? "留空 .env 则不会创建环境文件。" : "仅保存修改过的文件；没有 .env 时，填写内容会创建它。"}
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <Button onClick={props.onClose}>取消</Button>
        <Button variant="primary" disabled={saving() || loading() || (mode() === "existing" && loadedPath() !== composePath().trim())} onClick={() => void submit()}>
          {mode() === "new" ? "新建并注册" : "注册已有项目"}
        </Button>
      </div>
    </Modal>
  );
};
