const TOKEN_KEY = "phyless_token";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(t: string | null): void {
  if (t === null) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, t);
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401) {
    setToken(null);
    window.dispatchEvent(new CustomEvent("phyless:unauthorized"));
    throw new ApiError(401, "unauthorized");
  }
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
}

export const get = <T>(p: string) => request<T>("GET", p);
export const post = <T>(p: string, body?: unknown) => request<T>("POST", p, body);
export const put = <T>(p: string, body?: unknown) => request<T>("PUT", p, body);
export const del = <T>(p: string) => request<T>("DELETE", p);

// Image refs (e.g. "sha256:abc", "nginx:latest") contain colons, so the id
// travels as a query param rather than a path segment — see server.go.
export const imageInspectUrl = (id: string) => `/api/images/inspect?id=${encodeURIComponent(id)}`;

export async function login(username: string, password: string): Promise<string> {
  const out = await request<{ token: string }>("POST", "/api/auth/login", { username, password });
  setToken(out.token);
  return out.token;
}
