import { Component, onMount, onCleanup } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { wsURL } from "../../api/ws";

export const ContainerTerminal: Component<{ id: string }> = (props) => {
  let host!: HTMLDivElement;
  let ws: WebSocket | undefined;
  let term: Terminal | undefined;

  onMount(() => {
    term = new Terminal({ convertEol: true, fontSize: 13, theme: { background: "#09090b" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    ws = new WebSocket(wsURL(`/ws/containers/${props.id}/terminal`));
    ws.binaryType = "arraybuffer";
    const dec = new TextDecoder();
    ws.onmessage = (ev) =>
      term!.write(typeof ev.data === "string" ? ev.data : dec.decode(ev.data as ArrayBuffer));
    ws.onopen = () => {
      ws!.send(JSON.stringify({ type: "resize", cols: term!.cols, rows: term!.rows }));
    };
    term.onData((d) => ws?.readyState === WebSocket.OPEN && ws.send(d));
    const onResize = () => {
      fit.fit();
      ws?.readyState === WebSocket.OPEN &&
        ws.send(JSON.stringify({ type: "resize", cols: term!.cols, rows: term!.rows }));
    };
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
  });
  onCleanup(() => { ws?.close(); term?.dispose(); });

  return <div ref={host} class="h-[60vh] rounded bg-zinc-950 p-1" />;
};
