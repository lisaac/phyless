import { Component, createResource, createEffect, createSignal, Show } from "solid-js";
import { get, imageInspectUrl } from "../../api/client";
import { inspectToRunCmd } from "../../api/inspect";
import { runToCompose, composeToRuns } from "../../api/convert";
import { CodeEditor } from "../shared/CodeEditor";

function mergeComposeYamls(yamls: string[]): string {
  const blocks = yamls.map((yaml) => {
    const lines = yaml.split("\n");
    const idx = lines.findIndex((l) => l.trimStart().startsWith("services:"));
    return idx === -1 ? "" : lines.slice(idx + 1).join("\n").trimEnd();
  });
  return "services:\n" + blocks.filter(Boolean).join("\n");
}

// Split multi-line CLI text into individual flat docker run commands.
function splitCmds(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((chunk) => chunk.replace(/\\\n\s*/g, " ").trim())
    .filter((cmd) => cmd.startsWith("docker run"));
}

function cliToCompose(text: string): string {
  const cmds = splitCmds(text);
  if (cmds.length === 0) throw new Error("未找到 docker run 命令");
  return mergeComposeYamls(cmds.map(runToCompose));
}

function composeToCli(yaml: string): string {
  const cmds = composeToRuns(yaml);
  if (cmds.length === 0) throw new Error("未找到 services");
  return cmds.join("\n\n");
}

export const BulkRunModal: Component<{ ids: string[]; onClose: () => void }> = (props) => {
  const [cli, setCli] = createSignal("");
  const [compose, setCompose] = createSignal("");
  const [err, setErr] = createSignal("");

  const [data] = createResource(
    () => props.ids.join(","),
    async () => {
      const cmds = await Promise.all(
        props.ids.map(async (id) => {
          const container = await get<any>(`/api/containers/${id}/inspect`);
          let image: any = {};
          try {
            image = await get<any>(imageInspectUrl(container.Image));
          } catch {}
          return inspectToRunCmd(container, image);
        })
      );
      return {
        cli: cmds.join("\n\n"),
        compose: mergeComposeYamls(cmds.map(runToCompose)),
      };
    }
  );

  createEffect(() => {
    const d = data();
    if (!d) return;
    setCli(d.cli);
    setCompose(d.compose);
  });

  const onCliEdit = (v: string) => {
    setCli(v);
    try { setCompose(cliToCompose(v)); setErr(""); }
    catch (e) { setErr((e as Error).message); }
  };

  const onComposeEdit = (v: string) => {
    setCompose(v);
    try { setCli(composeToCli(v)); setErr(""); }
    catch (e) { setErr((e as Error).message); }
  };

  return (
    <div
      class="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
      onClick={props.onClose}
    >
      <div
        class="flex h-[90vh] w-[95vw] max-w-7xl flex-col overflow-hidden rounded border border-zinc-700 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div class="flex shrink-0 items-center justify-between border-b border-zinc-800 px-4 py-2.5">
          <span class="text-xs font-semibold uppercase tracking-widest text-zinc-400">
            {props.ids.length} 个容器
          </span>
          <button
            class="text-sm text-zinc-500 transition-colors hover:text-zinc-200"
            onClick={props.onClose}
          >✕</button>
        </div>

        {/* body */}
        <Show
          when={!data.loading}
          fallback={<p class="p-4 text-xs text-zinc-500">加载中…</p>}
        >
          <div class="grid min-h-0 flex-1 grid-cols-2 gap-px bg-zinc-800">
            <div class="flex min-h-0 flex-col bg-zinc-950 p-3">
              <div class="mb-1 text-xs text-zinc-400">命令行</div>
              <div class="min-h-0 flex-1">
                <CodeEditor value={cli()} onChange={onCliEdit} language="text" />
              </div>
            </div>
            <div class="flex min-h-0 flex-col bg-zinc-950 p-3">
              <div class="mb-1 text-xs text-zinc-400">compose.yaml</div>
              <div class="min-h-0 flex-1">
                <CodeEditor value={compose()} onChange={onComposeEdit} language="yaml" />
              </div>
            </div>
          </div>
          {err() && (
            <p class="shrink-0 border-t border-red-900/50 bg-red-900/20 px-3 py-1.5 text-xs text-red-400">
              {err()}
            </p>
          )}
        </Show>
      </div>
    </div>
  );
};
