import { Component, createResource, createEffect, createSignal, Show } from "solid-js";
import { runToCompose, mergeComposeYamls, cliToCompose, composeToCli } from "../../api/convert";
import { copyToClipboard } from "../../api/clipboard";
import { CodeEditor } from "../shared/CodeEditor";
import { toast } from "../shared/Toast";

// Generic "N run commands" editor — reused by ContainerListPage's bulk
// Run/Compose and the Compose pages' Run/Compose. Both derive fetchCmds the
// same way: inspect every relevant container (the selected ones, or every
// container belonging to the project) and run each through inspectToRunCmd,
// so the two surfaces share one CLI ⇄ compose.yaml conversion UI instead of
// each rendering their own.
export const BulkRunModal: Component<{
  reqKey: string; title: string; fetchCmds: () => Promise<string[]>; onClose: () => void;
}> = (props) => {
  const [cli, setCli] = createSignal("");
  const [compose, setCompose] = createSignal("");
  const [err, setErr] = createSignal("");

  const [data] = createResource(
    () => props.reqKey,
    async () => {
      const cmds = await props.fetchCmds();
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

  const copy = async (label: string, text: string) => {
    if (await copyToClipboard(text)) toast.success(`已复制${label}`);
    else toast.error(`复制${label}失败`);
  };

  return (
    <div
      class="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
      onClick={props.onClose}
    >
      <div
        class="flex h-full w-full flex-col overflow-hidden bg-zinc-950 shadow-2xl sm:h-[90vh] sm:w-[95vw] sm:max-w-7xl sm:rounded sm:border sm:border-zinc-700"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div class="flex shrink-0 items-center justify-between border-b border-zinc-800 px-4 py-2.5">
          <span class="text-xs font-semibold uppercase tracking-widest text-zinc-400">
            {props.title}
          </span>
          <button
            class="text-sm text-zinc-500 transition-colors hover:text-zinc-200"
            onClick={props.onClose}
          >✕</button>
        </div>

        {/* body — stacked on mobile (each pane needs real width to be
            usable), side-by-side from sm up */}
        <Show
          when={!data.loading}
          fallback={<p class="p-4 text-xs text-zinc-500">加载中…</p>}
        >
          <div class="grid min-h-0 flex-1 grid-cols-1 gap-px overflow-y-auto bg-zinc-800 sm:grid-cols-2 sm:overflow-visible">
            <div class="flex min-h-[40vh] flex-col bg-zinc-950 p-3 sm:min-h-0">
              <div class="mb-1 flex items-center justify-between">
                <span class="text-xs text-zinc-400">命令行</span>
                <button
                  class="border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
                  onClick={() => void copy("Run", cli())}
                >复制 Run</button>
              </div>
              <div class="min-h-0 flex-1">
                <CodeEditor value={cli()} onChange={onCliEdit} language="text" />
              </div>
            </div>
            <div class="flex min-h-[40vh] flex-col bg-zinc-950 p-3 sm:min-h-0">
              <div class="mb-1 flex items-center justify-between">
                <span class="text-xs text-zinc-400">compose.yaml</span>
                <button
                  class="border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
                  onClick={() => void copy("Compose", compose())}
                >复制 Compose</button>
              </div>
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
