import { Component, onMount, onCleanup } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { reportWSError, wsURL } from "../../api/ws";

// Renders a live terminal for a fixed cmd/user, connecting immediately on
// mount. cmd/user are chosen up front (via ConsoleModal) rather than edited
// here — this component now only ever runs inside the standalone terminal
// popup window (see TerminalWindowPage), which has no other controls around it.
export const ContainerTerminal: Component<{ id: string; cmd?: string; user?: string }> = (props) => {
  let host!: HTMLDivElement;
  let ws: WebSocket | undefined;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;

  const connect = () => {
    ws?.close();
    term?.clear();
    const params = new URLSearchParams();
    if (props.cmd && props.cmd !== "/bin/sh") params.set("cmd", props.cmd);
    if (props.user) params.set("user", props.user);
    const qs = params.toString();
    ws = new WebSocket(wsURL(`/ws/containers/${props.id}/terminal${qs ? "?" + qs : ""}`));
    ws.binaryType = "arraybuffer";
    const dec = new TextDecoder();
    ws.onmessage = (ev) =>
      term!.write(typeof ev.data === "string" ? ev.data : dec.decode(ev.data as ArrayBuffer));
    ws.onopen = () => {
      ws!.send(JSON.stringify({ type: "resize", cols: term!.cols, rows: term!.rows }));
    };
    ws.onerror = () => reportWSError("终端实时连接");
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

  return <div ref={host} class="h-full w-full bg-[#0c0c0c] p-1" />;
};
