import { Component, JSX, createSignal, createEffect } from "solid-js";
import { CodeEditor } from "./CodeEditor";
import { cliToCompose, composeToCli } from "../../api/convert";

export const RunComposeEditor: Component<{
  initialRun?: string;
  initialCompose?: string;
  actions?: (state: { run: string; compose: string }) => JSX.Element;
}> = (props) => {
  const [run, setRun] = createSignal(props.initialRun ?? "");
  const [compose, setCompose] = createSignal(props.initialCompose ?? "");
  const [err, setErr] = createSignal("");

  // React to external initialRun changes (template loaded, container cloned,
  // or a whole batch of containers' run commands joined by blank lines).
  // Runs on mount AND whenever props.initialRun changes. cliToCompose/
  // composeToCli (not the single-command runToCompose/composeToRun) so this
  // editor transparently handles either one command or many.
  createEffect(() => {
    const v = props.initialRun;
    if (!v) return;
    setRun(v);
    try { setCompose(cliToCompose(v)); setErr(""); }
    catch (e) { setErr((e as Error).message); }
  });

  const onRunEdit = (v: string) => {
    setRun(v);
    try { setCompose(cliToCompose(v)); setErr(""); }
    catch (e) { setErr((e as Error).message); }
  };
  const onComposeEdit = (v: string) => {
    setCompose(v);
    try { setRun(composeToCli(v)); setErr(""); }
    catch (e) { setErr((e as Error).message); }
  };

  return (
    <div class="flex h-full flex-col gap-2">
      <div class="grid flex-1 grid-cols-1 gap-2 min-h-0 sm:grid-cols-2">
        <div class="flex min-h-[35vh] flex-col sm:min-h-0">
          <div class="mb-1 text-xs text-zinc-400">docker run</div>
          <div class="flex-1 min-h-0"><CodeEditor value={run()} onChange={onRunEdit} language="text" /></div>
        </div>
        <div class="flex min-h-[35vh] flex-col sm:min-h-0">
          <div class="mb-1 text-xs text-zinc-400">compose.yaml</div>
          <div class="flex-1 min-h-0"><CodeEditor value={compose()} onChange={onComposeEdit} language="yaml" /></div>
        </div>
      </div>
      {err() && <p class="border border-red-900/50 bg-red-900/20 px-2 py-1 text-sm text-red-400">{err()}</p>}
      {props.actions?.({ run: run(), compose: compose() })}
    </div>
  );
};
