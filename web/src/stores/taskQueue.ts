import { createSignal } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import { getToken, setToken } from "../api/client";
import { runBrowserPull, runBrowserPullCompose, runBrowserCreate, runBrowserUpgrade, runComposeUpdate, type BrowserPullCallbacks } from "./browserPull";

// Global queue for every server-mutating request (pull/upgrade/compose/
// start/stop/delete/upload/rename/…). Lives at module scope, not inside a
// route component, so navigating away no longer aborts the XHR. Reads stay
// on api/client's get(); writes go through enqueue()/queued().
//
// Scheduling: tasks sharing a `key` (container id / compose project /
// image ref) run one at a time in FIFO order; different keys run
// concurrently up to MAX_CONCURRENT.
// ponytail: per-key serial + global cap of 4; set MAX_CONCURRENT = 1 for a strict FIFO.
//
// Persistence: localStorage, status transitions only (not per-layer
// progress). On reload anything still queued/running becomes "interrupted"
// — the connection died with the page, and the backend cancels on
// disconnect. Same-origin browser tabs share the key last-write-wins (see
// tabs.ts for why that store avoided localStorage; here it was requested).

export interface LayerProgress { id: string; status: string; current?: number; total?: number; }
export type TaskStatus = "queued" | "running" | "done" | "error" | "cancelled" | "interrupted";
export type TaskMeta = Record<string, string | string[] | boolean | undefined>;
export interface TaskDetail { label: string; value: string | string[]; }

export interface TaskSpec {
  title: string;
  method?: "POST" | "PUT" | "DELETE";
  url: string;
  body?: unknown;
  file?: File;
  key?: string;
  meta?: TaskMeta;
  doneLink?: { href: string; label: string };
  // Transient, never persisted (stripped in persist()): browser-pull registry
  // credentials must not be written to localStorage task history.
  secret?: { creds?: { username: string; secret: string } };
}

export interface Task extends TaskSpec {
  id: string;
  status: TaskStatus;
  createdAt: number;
  finishedAt?: number;
  details: TaskDetail[];
  layers: LayerProgress[];
  notes: string[];
  uploadPct: number | null;
  containerId?: string;
  error: string;
}

export const SETTLED_EVENT = "phyless:task-settled";
const STORAGE_KEY = "phyless_tasks";
const MAX_STORED = 50;
const MAX_CONCURRENT = 4;
const MAX_STORED_NOTES = 20;

const MAX_PROGRESS_RESPONSE = 2 * 1024 * 1024;
const MAX_PROGRESS_LINE = 256 * 1024;
const MAX_LAYERS = 256;
const MAX_NOTES = 500;
const MAX_ERROR = 4096;

export const isActive = (s: TaskStatus) => s === "queued" || s === "running";

function load(): Task[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.map((t: Task) => isActive(t.status)
      ? { ...t, status: "interrupted" as const, error: "页面刷新，任务已中断", finishedAt: t.finishedAt ?? Date.now() }
      : t);
  } catch { return []; }
}

export const [tasks, setTasks] = createStore<{ list: Task[] }>({ list: load() });
// Panel visibility: 隐藏 / the header 任务 button toggles it; the next enqueue
// shows it again. Starts hidden when there is nothing to show.
export const [panelHidden, setPanelHidden] = createSignal(tasks.list.length === 0);

function persist() {
  try {
    const stored = tasks.list.slice(-MAX_STORED).map((t) => ({
      ...unwrap(t), file: undefined, body: undefined, secret: undefined, layers: [], notes: t.notes.slice(-MAX_STORED_NOTES),
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch { /* quota / private mode — the in-memory queue still works */ }
}

const upd = (id: string, patch: Partial<Task>) => setTasks("list", (t) => t.id === id, patch);
const find = (id: string) => tasks.list.find((t) => t.id === id);

const xhrs = new Map<string, XMLHttpRequest>();
// browser-pull tasks stream over WebSocket instead of XHR; their AbortController
// lives here so cancel()/settle() can reach it the same way.
const browserAborts = new Map<string, AbortController>();
const waiters = new Map<string, (t: Task) => void>();
let nextId = Date.now();

const DETAIL_LABELS: Record<string, string> = {
  image: "镜像", images: "镜像", ids: "镜像 ID", ref: "镜像引用", source: "来源",
  name: "名称", tag: "标签", platform: "平台", mode: "模式", force: "强制",
  username: "用户名", role: "角色", driver: "驱动", subnet: "子网", gateway: "网关", parent: "父接口",
  old_path: "原路径", new_path: "新路径", target_id: "目标容器", target_path: "目标路径", container: "容器",
  base_dir: "项目目录", compose_file: "Compose 文件", env_file: "环境文件", pull_policy: "拉取策略",
  proxy_url: "拉取代理", registry_id: "镜像仓库", registry_ids: "镜像仓库",
  workerUrl: "下载代理", canBuild: "包含构建",
};
const HIDDEN_KEYS = /^(password|passwd|secret|token|authorization|auth|credentials?|registry_auth)$/i;
const ENV_KEYS = /^(env|environment)$/i;
const CONTENT_KEYS = /^(cmd|command|content|data)$/i;

const safeJSON = (value: unknown) => JSON.stringify(value, (key, nested) => {
  if (HIDDEN_KEYS.test(key)) return "已隐藏";
  if (ENV_KEYS.test(key)) return `${Array.isArray(nested) ? nested.length : 1} 项（值已隐藏）`;
  return nested;
});

function safeDetailValue(key: string, value: unknown): string | string[] | undefined {
  if (value == null || value === "") return;
  if (HIDDEN_KEYS.test(key)) return "已隐藏";
  if (ENV_KEYS.test(key)) return `${Array.isArray(value) ? value.length : 1} 项（值已隐藏）`;
  if (CONTENT_KEYS.test(key)) return `${typeof value === "string" ? value.length : safeJSON(value).length} 字符（内容已隐藏）`;
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) {
    const values = value.map((v) => typeof v === "object" ? safeJSON(v) : String(v));
    return values.length ? values : undefined;
  }
  if (typeof value === "object") return safeJSON(value);
  return String(value);
}

// Capture display-safe request facts before body/file are stripped from task
// history. Unknown fields keep their API name so every operation still has a
// useful audit trail without teaching the queue about every feature page.
function taskDetails(spec: TaskSpec): TaskDetail[] {
  const details: TaskDetail[] = [];
  if (spec.file) {
    details.push({ label: "文件", value: spec.file.name });
    details.push({ label: "文件大小", value: `${spec.file.size} B` });
  }
  if (typeof spec.body === "string") details.push({ label: "内容大小", value: `${spec.body.length} 字符` });
  const body = spec.body && typeof spec.body === "object" && !Array.isArray(spec.body)
    ? spec.body as Record<string, unknown> : {};
  const facts: Record<string, unknown> = { ...body, ...spec.meta };
  for (const [key, raw] of Object.entries(facts)) {
    if (key === "type" || key === "verb" || key === "action" || key === "containerId" || key === "composeId") continue;
    const value = safeDetailValue(key, raw);
    if (value !== undefined) details.push({ label: DETAIL_LABELS[key] ?? key, value });
  }
  return details;
}

export function enqueue(spec: TaskSpec): { id: string; done: Promise<Task> } {
  const id = `t${nextId++}`;
  const task: Task = {
    ...spec, id, status: "queued", createdAt: Date.now(), details: taskDetails(spec), layers: [], notes: [], uploadPct: null, error: "",
  };
  const done = new Promise<Task>((resolve) => waiters.set(id, resolve));
  setTasks("list", (l) => {
    // Bound the in-memory list the same way as storage: drop the oldest finished tasks.
    const next = [...l, task];
    const overflow = next.length - MAX_STORED;
    if (overflow <= 0) return next;
    let dropped = 0;
    return next.filter((t) => { if (dropped < overflow && !isActive(t.status)) { dropped++; return false; } return true; });
  });
  setPanelHidden(false);
  persist();
  pump();
  return { id, done };
}

// Drop-in for api/client's post/put/del: resolves on success, rejects with
// the task's error message otherwise, so existing try/catch + toast stays.
export function queued(
  title: string, method: "POST" | "PUT" | "DELETE", url: string, body?: unknown,
  opts?: Pick<TaskSpec, "key" | "meta">,
): Promise<void> {
  return enqueue({ title, method, url, body, ...opts }).done.then((t) => {
    if (t.status !== "done") throw new Error(t.error || "任务失败");
  });
}

export function cancel(id: string) {
  const t = find(id);
  if (!t) return;
  if (t.status === "queued") { settle(id, "cancelled", "已取消"); return; }
  xhrs.get(id)?.abort();
  browserAborts.get(id)?.abort();
}

export function remove(id: string) {
  if (find(id)?.status === "running") return;
  setTasks("list", (l) => l.filter((t) => t.id !== id));
  persist();
}

export function clearFinished() {
  setTasks("list", (l) => l.filter((t) => isActive(t.status)));
  persist();
}

export const isPending = (pred: (t: Task) => boolean) => tasks.list.some((t) => isActive(t.status) && pred(t));

function settle(id: string, status: TaskStatus, error = "") {
  const t = find(id);
  if (!t || !isActive(t.status)) return;
  upd(id, { status, error: error.slice(0, MAX_ERROR), finishedAt: Date.now(), uploadPct: null });
  xhrs.delete(id);
  browserAborts.delete(id);
  persist();
  // Strip transient credentials before broadcasting: the snapshot goes to every
  // SETTLED_EVENT listener and to the enqueue().done/queued() promise consumers.
  const snapshot = { ...unwrap(find(id)!), secret: undefined };
  waiters.get(id)?.(snapshot);
  waiters.delete(id);
  window.dispatchEvent(new CustomEvent(SETTLED_EVENT, { detail: snapshot }));
  pump();
}

function pump() {
  const running = tasks.list.filter((t) => t.status === "running");
  let slots = MAX_CONCURRENT - running.length;
  const busy = new Set(running.map((t) => t.key).filter(Boolean));
  for (const t of tasks.list) {
    if (slots <= 0) break;
    if (t.status !== "queued") continue;
    if (t.key && busy.has(t.key)) continue;
    if (t.key) busy.add(t.key);
    slots--;
    start(t.id);
  }
}

const eventError = (evt: any): string => {
  if (typeof evt.error === "string" && evt.error.trim()) return evt.error.slice(0, MAX_ERROR);
  if (typeof evt.errorDetail === "string" && evt.errorDetail.trim()) return evt.errorDetail.slice(0, MAX_ERROR);
  if (evt.errorDetail && typeof evt.errorDetail.message === "string" && evt.errorDetail.message.trim()) {
    return evt.errorDetail.message.slice(0, MAX_ERROR);
  }
  if (evt.errorDetail != null || (evt.error != null && evt.error !== "")) return "操作失败";
  return "";
};

// Same unwrapping api/client's request() did: {"error": msg} bodies become msg.
function httpError(status: number, text: string): string {
  let msg = text || `请求失败 (${status})`;
  try { const j = JSON.parse(text); if (j?.error) msg = String(j.error); } catch { /* plain text body */ }
  return msg.slice(0, MAX_ERROR);
}

// XHR rather than fetch: fetch has no upload-progress events, and XHR's
// onprogress on the response side gives the same incremental NDJSON parsing
// — one transport covers uploads, streamed progress and plain JSON writes.
// startBrowserPull drives a browser-download → WebSocket import task, reporting
// progress through the same task-note channel the XHR path uses.
function startBrowserTask(id: string, run: (cb: BrowserPullCallbacks) => Promise<void>) {
  const ac = new AbortController();
  browserAborts.set(id, ac);
  const note = (m: string) =>
    setTasks("list", (x) => x.id === id, "notes", (n) => [...n, m.slice(0, MAX_ERROR)].slice(-MAX_NOTES));
  run({ note, progress: note, signal: ac.signal }).then(
    () => settle(id, "done"),
    (err) => settle(id, ac.signal.aborted ? "cancelled" : "error", err instanceof Error ? err.message : String(err)),
  );
}

function startBrowserPull(id: string) {
  const t = find(id)!;
  startBrowserTask(id, (cb) => runBrowserPull(
    {
      ref: String(t.meta?.ref ?? ""),
      platform: String(t.meta?.platform ?? ""),
      workerUrl: String(t.meta?.workerUrl ?? ""),
      token: getToken() ?? "",
      creds: t.secret?.creds,
    }, cb));
}

// startBrowserPullCompose preloads every project image in the browser, then
// (for "up") runs compose up with pull_policy=never so the daemon stays offline.
function startBrowserPullCompose(id: string) {
  const t = find(id)!;
  startBrowserTask(id, (cb) => runBrowserPullCompose(
    {
      id: String(t.meta?.composeId ?? ""),
      mode: t.meta?.mode === "up" ? "up" : t.meta?.mode === "build" ? "build" : "pull",
      workerUrl: String(t.meta?.workerUrl ?? ""),
      token: getToken() ?? "",
      creds: t.secret?.creds,
    },
    cb));
}

function startBrowserAction(id: string) {
  const t = find(id)!;
  startBrowserTask(id, (cb) => t.meta?.action === "create"
    ? runBrowserCreate({
      ref: String(t.meta?.ref ?? ""),
      platform: String(t.meta?.platform ?? ""),
      workerUrl: String(t.meta?.workerUrl ?? ""),
      token: getToken() ?? "",
      creds: t.secret?.creds,
      body: (t.body as Record<string, unknown> | undefined) ?? {},
    }, cb)
    : runBrowserUpgrade({
      id: String(t.meta?.containerId ?? ""),
      workerUrl: String(t.meta?.workerUrl ?? ""),
      token: getToken() ?? "",
      creds: t.secret?.creds,
    }, cb));
}

// startComposeUpdate runs the merged Pull operation: pull/build or browser
// preload, without Down/Up. body holds server options; secret.creds browser creds.
function startComposeUpdate(id: string) {
  const t = find(id)!;
  const ac = new AbortController();
  browserAborts.set(id, ac);
  const note = (m: string) =>
    setTasks("list", (x) => x.id === id, "notes", (n) => [...n, m.slice(0, MAX_ERROR)].slice(-MAX_NOTES));
  runComposeUpdate(
    {
      id: String(t.meta?.composeId ?? ""),
      mode: t.meta?.mode === "browser" ? "browser" : "server",
      canBuild: t.meta?.canBuild === true,
      workerUrl: String(t.meta?.workerUrl ?? ""),
      token: getToken() ?? "",
      creds: t.secret?.creds,
      pullOptions: (t.body as Record<string, unknown> | undefined) ?? undefined,
    },
    { note, progress: note, signal: ac.signal },
  ).then(
    () => settle(id, "done"),
    (err) => settle(id, ac.signal.aborted ? "cancelled" : "error", err instanceof Error ? err.message : String(err)),
  );
}

function start(id: string) {
  const t = find(id)!;
  upd(id, { status: "running", uploadPct: t.file ? 0 : null });
  persist();
  if (t.meta?.type === "browser-pull") { startBrowserPull(id); return; }
  if (t.meta?.type === "browser-pull-compose") { startBrowserPullCompose(id); return; }
  if (t.meta?.type === "browser-pull-action") { startBrowserAction(id); return; }
  if (t.meta?.type === "compose-update") { startComposeUpdate(id); return; }
  const { url, body, file, method } = t;
  const layerMap = new Map<string, LayerProgress>();
  let buf = "";
  let readLen = 0;
  let err = "";
  const fail = (m: string) => { if (!err) err = m; };

  const applyLine = (line: string) => {
    if (!line.trim()) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let evt: any;
    try { evt = JSON.parse(line); } catch { fail("无效的进度响应"); return; }
    if (!evt || typeof evt !== "object" || Array.isArray(evt)) { fail("无效的进度响应"); return; }
    // Docker reports failures as either {error} or {errorDetail:{message}};
    // inspect them before status/id so a terminal error cannot look complete.
    const failure = eventError(evt);
    if (failure) { fail(failure); return; }
    if (evt.id && typeof evt.status === "string") {
      const lid = String(evt.id);
      if (!layerMap.has(lid) && layerMap.size >= MAX_LAYERS) {
        const oldest = layerMap.keys().next().value;
        if (oldest !== undefined) layerMap.delete(oldest);
      }
      layerMap.set(lid, {
        id: lid,
        status: evt.status ?? layerMap.get(lid)?.status ?? "",
        current: evt.progressDetail?.current,
        total: evt.progressDetail?.total,
      });
      upd(id, { layers: [...layerMap.values()] });
    } else if (evt.status) {
      setTasks("list", (x) => x.id === id, "notes", (n) => [...n, String(evt.status).slice(0, MAX_ERROR)].slice(-MAX_NOTES));
    } else if (evt.stream) {
      setTasks("list", (x) => x.id === id, "notes", (n) => [...n, String(evt.stream).trim().slice(0, MAX_ERROR)].slice(-MAX_NOTES));
      if (evt.container_id) upd(id, { containerId: String(evt.container_id) });
    }
  };
  const consumeChunk = (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_PROGRESS_LINE) { buf = buf.slice(-MAX_PROGRESS_LINE); fail("进度行过大"); return; }
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    lines.forEach(applyLine);
  };

  const req = new XMLHttpRequest();
  xhrs.set(id, req);
  const token = getToken();
  // Streaming handlers answer text/plain NDJSON; plain writes answer 204 or a
  // JSON object (which may be {error} even on 2xx). Only the former is parsed
  // incrementally.
  const isJSON = () => (req.getResponseHeader("Content-Type") ?? "").includes("application/json");
  const consumeResponse = () => {
    if (isJSON()) return true;
    if (req.responseText.length > MAX_PROGRESS_RESPONSE) {
      settle(id, "error", "进度响应过大");
      req.abort();
      return false;
    }
    const text = req.responseText;
    if (text.length > readLen) { consumeChunk(text.slice(readLen)); readLen = text.length; }
    return true;
  };
  req.open(method ?? "POST", url);
  req.setRequestHeader("Authorization", `Bearer ${token ?? ""}`);
  let payload: XMLHttpRequestBodyInit | undefined;
  if (file) {
    // /api/images/import requires x-tar|octet-stream (server.go boundedBodyRequest); other upload routes don't check.
    req.setRequestHeader("Content-Type", "application/x-tar");
    req.upload.onprogress = (e) => { if (e.lengthComputable) upd(id, { uploadPct: (e.loaded / e.total) * 100 }); };
    payload = file;
  } else if (typeof body === "string") {
    // Raw file content (compose/config editors) — sent verbatim, same as api/client request().
    req.setRequestHeader("Content-Type", "text/plain");
    payload = body;
  } else if (body !== undefined) {
    req.setRequestHeader("Content-Type", "application/json");
    payload = JSON.stringify(body);
  }
  req.onprogress = () => { upd(id, { uploadPct: null }); consumeResponse(); };
  req.onload = () => {
    if (req.status === 401) {
      if (token === getToken()) { setToken(null); window.dispatchEvent(new CustomEvent("phyless:unauthorized")); }
      settle(id, "error", "未授权");
      return;
    }
    if (req.status < 200 || req.status >= 300) {
      settle(id, "error", httpError(req.status, req.responseText));
      return;
    }
    if (isJSON()) {
      let failure = "";
      try { const j = JSON.parse(req.responseText || "{}"); failure = j && typeof j === "object" ? eventError(j) : ""; } catch { /* non-JSON body on a 2xx — treat as success */ }
      settle(id, failure ? "error" : "done", failure);
      return;
    }
    if (!consumeResponse()) return;
    if (buf) applyLine(buf);
    settle(id, err ? "error" : "done", err);
  };
  req.onerror = () => settle(id, "error", "网络错误");
  req.onabort = () => settle(id, "cancelled", "已取消");
  req.send(payload);
}
