// Browser-download settings persisted per browser (origin localStorage):
// the CF worker URL, the chosen download mode, and — opt-in — a single private
// registry credential so the user need not retype it.
//
// SECURITY: remembered credentials live in localStorage in cleartext and are
// readable by any script that runs on this origin (i.e. an XSS would expose
// them). They are never sent to the phyless server. Remembering is off by
// default and can be cleared from the pull dialog.

const WORKER_KEY = "phyless_pull_worker_url";
const MODE_KEY = "phyless_pull_download_mode";
const CREDS_KEY = "phyless_pull_registry_creds";

export type DownloadMode = "proxy" | "browser";
export interface Creds {
  username: string;
  secret: string;
}

// Only https URLs without embedded credentials, query or fragment are stored;
// a path is allowed (Workers are often mounted under a route).
export function validWorkerUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "";
    if (url.username || url.password || url.search || url.hash) return "";
    if (url.host.endsWith(":")) return "";
    return value;
  } catch {
    return "";
  }
}

export function getWorkerUrl(): string {
  try {
    return validWorkerUrl(localStorage.getItem(WORKER_KEY) ?? "");
  } catch {
    return "";
  }
}

export function setWorkerUrl(raw: string): void {
  try {
    const value = validWorkerUrl(raw);
    if (value) localStorage.setItem(WORKER_KEY, value);
    else if (!raw.trim()) localStorage.removeItem(WORKER_KEY);
  } catch {
    /* storage disabled — in-memory state still works */
  }
}

export function getDownloadMode(): DownloadMode {
  try {
    return localStorage.getItem(MODE_KEY) === "browser" ? "browser" : "proxy";
  } catch {
    return "proxy";
  }
}

export function setDownloadMode(mode: DownloadMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

export function getRememberedCreds(): Creds | null {
  try {
    const raw = localStorage.getItem(CREDS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Creds>;
    if (typeof parsed?.username === "string" && typeof parsed?.secret === "string") {
      return { username: parsed.username, secret: parsed.secret };
    }
    return null;
  } catch {
    return null;
  }
}

export function rememberCreds(creds: Creds | null): void {
  try {
    if (creds && creds.username && creds.secret) localStorage.setItem(CREDS_KEY, JSON.stringify(creds));
    else localStorage.removeItem(CREDS_KEY);
  } catch {
    /* ignore */
  }
}
