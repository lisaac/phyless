import { Component, createSignal, createResource, For, Show } from "solid-js";
import { useParams } from "@solidjs/router";
import { get, put, getToken } from "../../api/client";
import { Button } from "../shared/Button";
import { toast } from "../shared/Toast";
import { ContainerLogs } from "./ContainerLogs";
import { ContainerTerminal } from "./ContainerTerminal";
import { ContainerStats } from "./ContainerStats";
import { FileBrowser } from "../shared/FileBrowser";
import type { FileEntry } from "../../types";

type Tab = "overview" | "logs" | "terminal" | "stats" | "files" | "edit";
const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "概览" },
  { key: "logs", label: "日志" },
  { key: "terminal", label: "终端" },
  { key: "stats", label: "统计" },
  { key: "files", label: "文件" },
  { key: "edit", label: "编辑" },
];

export const ContainerDetailPage: Component = () => {
  const params = useParams();
  const id = () => params.id;
  const [tab, setTab] = createSignal<Tab>("overview");
  const [inspect] = createResource(id, (i) => get<any>(`/api/containers/${i}/inspect`));
  const [memMB, setMemMB] = createSignal("");

  const listFiles = (sub: string) =>
    get<FileEntry[]>(`/api/containers/${id()}/files?path=${encodeURIComponent(sub)}`);
  const downloadURL = (sub: string) =>
    `/api/containers/${id()}/files/download?path=${encodeURIComponent(sub)}&token=${encodeURIComponent(getToken() ?? "")}`;
  const uploadFile = async (sub: string, file: File) => {
    const res = await fetch(
      `/api/containers/${id()}/files/upload?path=${encodeURIComponent(sub)}`,
      { method: "POST", headers: { Authorization: `Bearer ${getToken()}` }, body: file },
    );
    if (!res.ok) throw new Error(await res.text());
  };

  const saveResources = async () => {
    try {
      await put(`/api/containers/${id()}/resources`, { memory: Number(memMB()) * 1024 * 1024 });
      toast.info("resources updated");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div>
      <h1 class="mb-3 text-xl font-semibold">{id().slice(0, 12)}</h1>
      <div class="mb-4 flex gap-2 border-b border-zinc-800">
        <For each={TABS}>
          {(t) => (
            <button
              class={`px-3 py-1.5 text-sm ${tab() === t.key ? "border-b-2 border-blue-500" : "text-zinc-400"}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          )}
        </For>
      </div>

      <Show when={tab() === "overview"}>
        <pre class="max-h-[70vh] overflow-auto rounded bg-zinc-950 p-3 text-xs">{JSON.stringify(inspect(), null, 2)}</pre>
      </Show>
      <Show when={tab() === "logs"}><ContainerLogs id={id()} /></Show>
      <Show when={tab() === "terminal"}><ContainerTerminal id={id()} /></Show>
      <Show when={tab() === "stats"}><ContainerStats id={id()} /></Show>
      <Show when={tab() === "files"}>
        <FileBrowser listPath={listFiles} downloadURL={downloadURL} onUpload={uploadFile} />
      </Show>
      <Show when={tab() === "edit"}>
        <div class="max-w-sm">
          <label class="block text-sm text-zinc-400">内存上限 MB</label>
          <input class="mb-2 w-full rounded bg-zinc-800 px-2 py-1" value={memMB()} onInput={(e) => setMemMB(e.currentTarget.value)} />
          <Button variant="primary" onClick={saveResources}>保存</Button>
        </div>
      </Show>
    </div>
  );
};
