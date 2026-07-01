import { Component, JSX, createSignal, onMount } from "solid-js";
import { CodeEditor } from "./CodeEditor";
import { runToCompose, composeToRun } from "../../api/convert";

// RunComposeEditor: left = docker run, right = compose.yaml.
// Editing either side live-converts the other. Conversion errors are shown inline.
// On mount, if initialRun is provided and initialCompose is not, auto-converts.
export const RunComposeEditor: Component<{
  initialRun?: string;
  initialCompose?: string;
  actions?: (state: { run: string; compose: string }) => JSX.Element;
}> = (props) => {
  const [run, setRun] = createSignal(props.initialRun ?? "");
  const [compose, setCompose] = createSignal(props.initialCompose ?? "");
  const [err, setErr] = createSignal("");

  // Auto-convert initialRun → compose on first mount so both panes are populated.
  onMount(() => {
    if (props.initialRun && !props.initialCompose) {
      try {
        setCompose(runToCompose(props.initialRun));
        setErr("");
      } catch (e) {
        setErr((e as Error).message);
      }
    }
  });

  const onRunEdit = (v: string) => {
    setRun(v);
    try {
      setCompose(runToCompose(v));
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const onComposeEdit = (v: string) => {
    setCompose(v);
    try {
      setRun(composeToRun(v));
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div class="flex h-full flex-col gap-2">
      <div class="grid flex-1 grid-cols-2 gap-2" style={{ "min-height": "16rem" }}>
        <div class="flex flex-col">
          <div class="mb-1 text-xs text-zinc-400">docker run</div>
          <div class="flex-1"><CodeEditor value={run()} onChange={onRunEdit} language="text" /></div>
        </div>
        <div class="flex flex-col">
          <div class="mb-1 text-xs text-zinc-400">compose.yaml</div>
          <div class="flex-1"><CodeEditor value={compose()} onChange={onComposeEdit} language="yaml" /></div>
        </div>
      </div>
      {err() && <p class="rounded bg-red-900/30 px-2 py-1 text-sm text-red-400">{err()}</p>}
      {props.actions?.({ run: run(), compose: compose() })}
    </div>
  );
};
