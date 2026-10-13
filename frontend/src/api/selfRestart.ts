import { get, getToken, quietBackendDown } from "./client";

// Operations that stop phyless's own container (self upgrade, compose
// up/restart/stop/down of its project) run in a helper container. The stream
// carries {"helper": true} at the handoff; from then on the outcome is polled
// from /api/system/helper — before, during and after phyless restarts —
// instead of trusting the stream, which may drop or hang behind a proxy once
// phyless stops. One implementation for every transport (XHR task queue and
// streamPost).

export const isHelperEvent = (evt: unknown) => !!evt && typeof evt === "object" && (evt as { helper?: unknown }).helper === true;
// The helper ends with phyless stopped for good (compose stop/down of its own
// project): an unreachable backend is then the outcome, not a restart.
export const helperStops = (evt: unknown) => isHelperEvent(evt) && (evt as { stops?: unknown }).stops === true;

interface HelperResult { state: "none" | "running" | "ok" | "failed"; error?: string; message?: string; }

const POLL_MS = 2000;
const TIMEOUT_MS = 10 * 60 * 1000;
export const STOPPED_NOTE = "phyless 已停止，连接已断开；需在主机上手动启动";

type Step = "wait" | "reload" | "stay";

// A proxy in front of a stopped phyless answers 5xx with its own non-JSON
// page; only phyless's own (JSON) answers count as "reachable".
const reachable = (r: Response | undefined): r is Response =>
  !!r && r.status < 500 && (r.headers.get("Content-Type") ?? "").includes("application/json");

export async function awaitHelper(note: (m: string) => void, signal?: AbortSignal, stops = false): Promise<void> {
  return poll("/api/system/helper", stops ? "等待 helper 完成…" : "等待 helper 完成并重启 phyless…", note, signal, async (r) => {
    if (!reachable(r)) {
      if (!stops) return "wait";
      note(STOPPED_NOTE);
      return "stay";
    }
    let res: HelperResult;
    try { res = await r.json(); } catch { return "wait"; }
    if (res.state === "running" || !r.ok) return "wait";
    if (res.state === "failed") throw new Error(res.error || "helper 操作失败");
    if (res.state === "none") throw new Error("未找到 helper 操作结果");
    if (res.message) note(res.message);
    return "reload";
  });
}

// awaitRestart follows a restart Docker performs on phyless's own container
// (atomic on the daemon side): wait until the backend answers again.
export async function awaitRestart(note: (m: string) => void, signal?: AbortSignal): Promise<void> {
  return poll("/api/system/self", "等待 phyless 重启…", note, signal, async (r) => reachable(r) ? "reload" : "wait");
}

// selfContainerId is phyless's own container ID, "" when it runs bare.
export async function selfContainerId(): Promise<string> {
  try { return (await get<{ id: string }>("/api/system/self")).id ?? ""; } catch { return ""; }
}

// poll GETs path every POLL_MS, quietly through the outage, until step says
// otherwise; "reload" then loads the page fresh, as the restarted backend may
// serve a newer UI.
async function poll(path: string, waitingNote: string, note: (m: string) => void, signal: AbortSignal | undefined, step: (r: Response | undefined) => Promise<Step>): Promise<void> {
  quietBackendDown(true);
  let waiting = false;
  try {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      let r: Response | undefined;
      try {
        r = await fetch(path, { headers: { Authorization: `Bearer ${getToken() ?? ""}` }, signal });
      } catch (e) {
        if (signal?.aborted) throw e;
      }
      const next = await step(r);
      if (next === "reload") setTimeout(() => location.reload(), 1500);
      if (next !== "wait") return;
      if (!waiting) { note(waitingNote); waiting = true; }
      await new Promise((res) => setTimeout(res, POLL_MS));
    }
    throw new Error("等待 phyless 重启超时，请在主机上检查 phyless 与 phyless-helper 容器");
  } finally {
    quietBackendDown(false);
  }
}
