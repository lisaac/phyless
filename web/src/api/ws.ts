import { getToken } from "./client";

export function wsURL(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const token = getToken() ?? "";
  const sep = path.includes("?") ? "&" : "?";
  return `${proto}//${location.host}${path}${sep}token=${encodeURIComponent(token)}`;
}

// connectWS opens a socket and wires handlers; returns the socket so callers can close it.
export function connectWS(
  path: string,
  handlers: { onMessage: (ev: MessageEvent) => void; onClose?: () => void; onOpen?: () => void },
): WebSocket {
  const ws = new WebSocket(wsURL(path));
  ws.binaryType = "arraybuffer";
  ws.onmessage = handlers.onMessage;
  if (handlers.onClose) ws.onclose = handlers.onClose;
  if (handlers.onOpen) ws.onopen = handlers.onOpen;
  return ws;
}
