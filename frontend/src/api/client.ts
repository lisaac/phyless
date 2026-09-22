const TOKEN_KEY = "phyless_token";
let readController = new AbortController();

// Docker server changes invalidate every read from the prior runtime. The task
// queue cancels its XHR writes separately at the same transition.
export function cancelPendingReads(): void {
  readController.abort();
  readController = new AbortController();
}

// Direct GET helpers with their own local cancellation also join this signal.
// dispose removes the two listeners after the request settles.
export function readSignal(signal?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const shared = readController.signal;
  if (!signal || signal === shared) return { signal: shared, dispose: () => {} };
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (shared.aborted || signal.aborted) abort();
  else {
    shared.addEventListener("abort", abort, { once: true });
    signal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      shared.removeEventListener("abort", abort);
      signal.removeEventListener("abort", abort);
    },
  };
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

export const isApiNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(t: string | null): void {
  if (t === null) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, t);
}

export async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (typeof body === "string") {
    // Raw file content (compose/config file editors) — JSON.stringify-ing a
    // string wraps it in quotes and escapes it, silently corrupting whatever
    // gets saved. Send it verbatim; the backend just io.ReadAll()s the body.
    headers["Content-Type"] = "text/plain";
    payload = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const read = method === "GET" ? readSignal(signal) : undefined;
  try {
    const res = await fetch(path, { method, headers, body: payload, signal: read?.signal ?? signal });
    if (res.status === 401 && token === getToken()) {
      setToken(null);
      window.dispatchEvent(new CustomEvent("phyless:unauthorized"));
      throw new ApiError(401, "unauthorized");
    }
    if (res.status === 401) throw new ApiError(401, "unauthorized");
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      let msg = text || res.statusText;
      try {
        const j = JSON.parse(text);
        if (j?.error) msg = j.error;
      } catch {}
      throw new ApiError(res.status, msg);
    }
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get("Content-Type") ?? "";
    const text = await res.text();
    if (ct.includes("application/json")) return JSON.parse(text) as T;
    // Try to parse as JSON even without Content-Type header
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  } finally {
    read?.dispose();
  }
}

export const get = <T>(p: string, signal?: AbortSignal) => request<T>("GET", p, undefined, signal);
// No post/put/del: every server-mutating request goes through
// stores/taskQueue.ts (enqueue / queued) so it survives navigation and
// shows in the task panel.

// Image refs (e.g. "sha256:abc", "nginx:latest") contain colons, so the id
// travels as a query param rather than a path segment — see server.go.
export const imageInspectUrl = (id: string) => `/api/images/inspect?id=${encodeURIComponent(id)}`;

export async function login(username: string, password: string, signal?: AbortSignal): Promise<string> {
  const out = await request<{ token: string }>("POST", "/api/auth/login", { username, password }, signal);
  signal?.throwIfAborted();
  setToken(out.token);
  return out.token;
}

export async function setup(password: string, signal?: AbortSignal): Promise<string> {
  const out = await request<{ token: string }>("POST", "/api/auth/setup", { password }, signal);
  signal?.throwIfAborted();
  setToken(out.token);
  return out.token;
}
