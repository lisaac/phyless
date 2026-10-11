// Browser-download settings persisted per browser (origin localStorage):
// saved CF worker URLs, the chosen download mode, and — opt-in — private
// registry credentials keyed by Worker URL (so one endpoint cannot reuse
// another endpoint's credentials) and then by registry host.
//
// SECURITY: remembered credentials live in localStorage in cleartext and are
// readable by any script that runs on this origin (i.e. an XSS would expose
// them). They are never sent to the phyless server. Remembering is off by
// default and can be cleared from the pull dialog.

import { registryCredsHost, type Creds } from "../api/registryPull";

const WORKER_KEY = "phyless_pull_worker_url";
const WORKER_LIST_KEY = "phyless_pull_worker_urls";
const MODE_KEY = "phyless_pull_download_mode";
const CREDS_KEY = "phyless_pull_registry_creds";

export type DownloadMode = "proxy" | "browser";

/** Prefilled until this browser saves its own Worker address. */
export const DEFAULT_WORKER_URL = "https://registry-proxy.phyless.com";

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
    const current = validWorkerUrl(localStorage.getItem(WORKER_KEY) ?? "");
    if (current) return current;
  } catch {
    // Fall through to the list reader below.
  }
  return getWorkerUrls()[0] ?? DEFAULT_WORKER_URL;
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

function uniqueWorkerUrls(values: unknown[]): string[] {
  return [...new Set(values.map((value) => typeof value === "string" ? validWorkerUrl(value) : "").filter(Boolean))];
}

// Saved browser-proxy endpoints are origin-local. Migrate the old single-value
// key the first time the list is read.
export function getWorkerUrls(): string[] {
  try {
    const raw = localStorage.getItem(WORKER_LIST_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return uniqueWorkerUrls(parsed);
    }
    const legacy = validWorkerUrl(localStorage.getItem(WORKER_KEY) ?? "");
    if (legacy) {
      const urls = [legacy];
      localStorage.setItem(WORKER_LIST_KEY, JSON.stringify(urls));
      return urls;
    }
  } catch {
    // Browser storage may be disabled or contain malformed legacy data.
  }
  return [];
}

export function saveWorkerUrl(raw: string): string[] {
  const value = validWorkerUrl(raw);
  if (!value) return getWorkerUrls();
  const urls = [value, ...getWorkerUrls().filter((url) => url !== value)];
  try {
    localStorage.setItem(WORKER_LIST_KEY, JSON.stringify(urls));
    localStorage.setItem(WORKER_KEY, value);
  } catch {
    // Keep the current component value usable when storage is unavailable.
  }
  return urls;
}

export function removeWorkerUrl(raw: string): string[] {
  const value = validWorkerUrl(raw);
  const urls = getWorkerUrls().filter((url) => url !== value);
  rememberAccounts(value, null);
  try {
    if (urls.length) {
      localStorage.setItem(WORKER_LIST_KEY, JSON.stringify(urls));
      localStorage.setItem(WORKER_KEY, urls[0]);
    } else {
      localStorage.removeItem(WORKER_LIST_KEY);
      localStorage.removeItem(WORKER_KEY);
    }
  } catch {
    // Ignore storage failures; the caller still receives the new list.
  }
  return urls;
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

function isCreds(value: unknown): value is Creds {
  return !!value && typeof value === "object" &&
    typeof (value as Creds).username === "string" && typeof (value as Creds).secret === "string" &&
    !!(value as Creds).username && !!(value as Creds).secret;
}

/** A registry account saved in this browser for the frontend proxy. */
export interface StoredAccount { id: string; host: string; username: string; secret: string }
/** One Worker's accounts plus which account each registry uses:
 *  "b:<id>" (a browser account) or "s:<registry id>" (a phyless server account,
 *  whose secret is fetched on use and never stored here). */
export interface RememberedAccounts { accounts: StoredAccount[]; use: string[] }

export const newAccountId = () => (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 12);
const useKeyPattern = /^[bs]:[\w-]{1,64}$/;

function readAccounts(value: unknown): RememberedAccounts | null {
  if (!value || typeof value !== "object" || !Array.isArray((value as RememberedAccounts).accounts)) return null;
  const raw = value as { accounts: unknown[]; use?: unknown };
  const accounts: StoredAccount[] = [];
  for (const a of raw.accounts) {
    const host = registryCredsHost(String((a as StoredAccount)?.host ?? ""));
    const id = String((a as StoredAccount)?.id ?? "");
    if (host && /^[\w-]{1,64}$/.test(id) && isCreds(a)) accounts.push({ id, host, username: a.username, secret: a.secret });
  }
  const use = Array.isArray(raw.use) ? raw.use.filter((k): k is string => typeof k === "string" && useKeyPattern.test(k)) : [];
  return accounts.length || use.length ? { accounts, use } : null;
}

function readCreds(): Record<string, RememberedAccounts> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CREDS_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const all: Record<string, RememberedAccounts> = {};
    for (const [url, value] of Object.entries(parsed)) {
      const workerUrl = validWorkerUrl(url);
      const data = workerUrl ? readAccounts(value) : null;
      if (data) all[workerUrl] = data;
    }
    return all;
  } catch {
    return {};
  }
}

export function getRememberedAccounts(workerUrl: string): RememberedAccounts | null {
  const url = validWorkerUrl(workerUrl);
  if (!url) return null;
  const data = readCreds()[url];
  return data ? structuredClone(data) : null;
}

export function rememberAccounts(workerUrl: string, data: RememberedAccounts | null): void {
  const url = validWorkerUrl(workerUrl);
  if (!url) return;
  try {
    const all = readCreds();
    const read = data ? readAccounts(data) : null;
    if (read) all[url] = read;
    else delete all[url];
    if (Object.keys(all).length) localStorage.setItem(CREDS_KEY, JSON.stringify(all));
    else localStorage.removeItem(CREDS_KEY);
  } catch {
    /* ignore */
  }
}
