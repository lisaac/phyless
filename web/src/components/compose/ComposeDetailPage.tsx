import { Component, createSignal, createResource, onCleanup, For, Show } from "solid-js";
import { useParams } from "@solidjs/router";
import { get, put, getToken, setToken } from "../../api/client";
import { connectWS } from "../../api/ws";
import { CodeEditor } from "../shared/CodeEditor";
import { Button } from "../shared/Button";
import { Modal } from "../shared/Modal";
import { toast } from "../shared/Toast";
import { hasRole } from "../../stores/auth";
import { composeToRuns } from "../../api/convert";

export const ComposeDetailPage: Component = () => {
  const params = useParams();
  const id = () => params.id;
  const [yaml, setYaml] = createSignal("");
  const [output, setOutput] = createSignal("");
  const [showConvert, setShowConvert] = createSignal(false);
  let logWs: WebSocket | undefined;

  // load yaml (file endpoint returns text/plain)
  createResource(id, async (i) => {
    const text = await get<string>(`/api/compose/file?id=${encodeURIComponent(i)}`);
    setYaml(text);
    return text;
  });

  const save = async () => {
    try { await put(`/api/compose/file?id=${encodeURIComponent(id())}`, yaml()); toast.success("已保存"); }
    catch (e) { toast.error((e as Error).message); }
  };

  // run streams text/plain; read the body incrementally into the output pane.
  const runCmd = async (verb: "up" | "down" | "pull" | "restart") => {
    try {
      setOutput("");
      const res = await fetch(`/api/compose/${verb}?id=${encodeURIComponent(id())}`, {
        method: "POST", headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (res.status === 401) { setToken(null); window.dispatchEvent(new CustomEvent("phyless:unauthorized")); return; }
      const reader = res.body?.getReader();
      if (!reader) return;
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        setOutput((o) => o + dec.decode(value));
      }
    } catch (e) { toast.error((e as Error).message); }
  };

  const startLogs = () => {
    logWs?.close();
    setOutput("");
    const dec = new TextDecoder();
    logWs = connectWS(`/ws/compose/logs?id=${encodeURIComponent(id())}`, {
      onMessage: (ev) => {
        const chunk = typeof ev.data === "string" ? ev.data : dec.decode(ev.data as ArrayBuffer);
        setOutput((o) => (o + chunk).slice(-100_000));
      },
    });
  };
  onCleanup(() => logWs?.close());

  const runs = () => { try { return composeToRuns(yaml()); } catch { return []; } };

  return (
    <div>
      <h1 class="mb-3 text-xl font-semibold">Compose: {id()}</h1>
      <Show when={hasRole("operator")}>
        <div class="mb-3 flex gap-2">
          <Button variant="primary" onClick={() => runCmd("up")}>Up</Button>
          <Button onClick={() => runCmd("down")}>Down</Button>
          <Button onClick={() => runCmd("pull")}>Pull</Button>
          <Button onClick={() => runCmd("restart")}>Restart</Button>
          <Button onClick={startLogs}>日志</Button>
          <Button onClick={() => setShowConvert(true)}>转换视图</Button>
        </div>
      </Show>
      <div class="grid grid-cols-2 gap-3">
        <div class="flex flex-col">
          <div class="mb-1 flex items-center justify-between">
            <span class="text-sm text-zinc-400">compose.yaml</span>
            <Show when={hasRole("operator")}><Button onClick={save}>保存</Button></Show>
          </div>
          <div class="h-[60vh]"><CodeEditor value={yaml()} onChange={setYaml} language="yaml" /></div>
        </div>
        <div class="flex flex-col">
          <span class="mb-1 text-sm text-zinc-400">输出 / 日志</span>
          <pre class="h-[60vh] overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-3 font-mono text-xs">{output()}</pre>
        </div>
      </div>

      <Modal open={showConvert()} onClose={() => setShowConvert(false)} title="docker run 集合" wide>
        <div class="space-y-2">
          <For each={runs()} fallback={<p class="text-sm text-zinc-400">无法转换或无服务</p>}>
            {(r) => (
              <div class="flex items-center gap-2">
                <code class="flex-1 overflow-auto rounded bg-zinc-950 p-2 text-xs">{r}</code>
                <Button onClick={() => navigator.clipboard.writeText(r)}>复制</Button>
              </div>
            )}
          </For>
        </div>
      </Modal>
    </div>
  );
};
