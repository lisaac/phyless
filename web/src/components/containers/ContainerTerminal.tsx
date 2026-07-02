import { Component, createSignal, onMount, onCleanup } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { wsURL } from "../../api/ws";

export const ContainerTerminal: Component<{ id: string }> = (props) => {
  const [cmd, setCmd] = createSignal("/bin/sh");
  const [user, setUser] = createSignal("");
  let host!: HTMLDivElement;
  let ws: WebSocket | undefined;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;

  const connect = () => {
    ws?.close();
    term?.clear();
    const params = new URLSearchParams();
    if (cmd() && cmd() !== "/bin/sh") params.set("cmd", cmd());
    if (user()) params.set("user", user());
    const qs = params.toString();
    ws = new WebSocket(wsURL(`/ws/containers/${props.id}/terminal${qs ? "?" + qs : ""}`));
    ws.binaryType = "arraybuffer";
    const dec = new TextDecoder();
    ws.onmessage = (ev) =>
      term!.write(typeof ev.data === "string" ? ev.data : dec.decode(ev.data as ArrayBuffer));
    ws.onopen = () => {
      ws!.send(JSON.stringify({ type: "resize", cols: term!.cols, rows: term!.rows }));
    };
  };

  onMount(() => {
    term = new Terminal({ convertEol: true, fontSize: 13, theme: { background: "#0c0c0c" } });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    connect();

    term.onData((d) => ws?.readyState === WebSocket.OPEN && ws.send(d));
    const onResize = () => {
      fit!.fit();
      ws?.readyState === WebSocket.OPEN &&
        ws.send(JSON.stringify({ type: "resize", cols: term!.cols, rows: term!.rows }));
    };
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
  });
  onCleanup(() => { ws?.close(); term?.dispose(); });

  const fieldCls = "rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-xs text-zinc-200 outline-none focus:border-indigo-500 w-44";

  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-3">
        <label class="flex items-center gap-1.5">
          <span class="text-[11px] uppercase tracking-widest text-zinc-400">CMD</span>
          <input class={fieldCls} value={cmd()} onInput={(e) => setCmd(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && connect()} placeholder="/bin/sh" />
        </label>
        <label class="flex items-center gap-1.5">
          <span class="text-[11px] uppercase tracking-widest text-zinc-400">UID</span>
          <input class={fieldCls} value={user()} onInput={(e) => setUser(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && connect()} placeholder="root" />
        </label>
        <button
          class="border border-zinc-700 px-2 py-1 text-xs text-zinc-500 hover:border-zinc-500 hover:text-zinc-200 transition-colors"
          onClick={connect}
        >连接</button>
      </div>
      <div ref={host} class="h-[62vh] bg-[#0c0c0c] p-1" />
    </div>
  );
};
