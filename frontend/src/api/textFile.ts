import { backendFetch, getToken, readSignal, setToken } from "./client";
import { readTarFirstFile } from "./dockerTar";
import { confirmAction } from "../components/shared/ConfirmModal";

// Extensions the CodeEditor/browser can render safely as text. Anything else
// (images, archives, binaries…) gets a confirmation dialog first — the editor loads
// content via res.text(), which silently mangles non-UTF8 bytes into
// replacement characters instead of erroring, so a binary file would
// otherwise open looking "fine" and then corrupt on save. Shared by the
// compose project file browser and the /etc config file browser.
const TEXT_EXT = /\.(ya?ml|json|env|txt|md|conf|cfg|ini|sh|bash|zsh|py|js|ts|jsx|tsx|go|rb|toml|properties|gitignore|dockerignore|lock|xml|html?|css|sql)$/i;
const KNOWN_TEXT_NAMES = /^(dockerfile|makefile|readme|license)$/i;

export function looksTextFile(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  if (KNOWN_TEXT_NAMES.test(name)) return true;
  if (!name.includes(".")) return true; // extensionless files are usually scripts/config
  return TEXT_EXT.test(name);
}

// Bypasses the generic get() helper (which only returns a parsed body) since
// callers need the X-Truncated response header to know whether Save would
// destroy the rest of a file that got capped server-side (see
// backend/internal/api/filecontent.go's maxFileContent). Returns null on 401 (after
// dispatching the same global unauthorized event the rest of the app uses).
export async function fetchTextFile(url: string, signal?: AbortSignal): Promise<{ text: string; truncated: boolean } | null> {
  const read = readSignal(signal);
  try {
    const res = await authedGet(url, read.signal);
    if (!res) return null;
    const text = await res.text();
    return { text, truncated: res.headers.get("X-Truncated") === "true" };
  } finally {
    read.dispose();
  }
}

async function authedGet(url: string, signal: AbortSignal): Promise<Response | null> {
  const token = getToken();
  const res = await backendFetch(url, { headers: { Authorization: `Bearer ${token ?? ""}` }, signal });
  if (res.status === 401) {
    if (token === getToken()) {
      setToken(null);
      window.dispatchEvent(new CustomEvent("phyless:unauthorized"));
    }
    return null;
  }
  if (!res.ok) throw new Error(await res.text());
  return res;
}

// Same 2MB cap as backend/internal/api/filecontent.go's maxFileContent.
export const MAX_VIEW_BYTES = 2 << 20;

export type TarText =
  | { kind: "text"; text: string; size: number; truncated: boolean }
  | { kind: "binary" | "dir"; size?: number }
  | { kind: "link"; target: string };

// Container/image files only come out as a tar (docker cp). Reads the first
// entry, stops the download at MAX_VIEW_BYTES, and decodes it as UTF-8.
export async function fetchTarText(url: string, signal?: AbortSignal): Promise<TarText | null> {
  const read = readSignal(signal);
  try {
    const res = await authedGet(url, read.signal);
    if (!res) return null;
    if (!res.body) throw new Error("empty response");
    const f = await readTarFirstFile(res.body, MAX_VIEW_BYTES);
    if (f.kind !== "file") return f;
    return decodeText(f.bytes, f.size, f.truncated);
  } finally {
    read.dispose();
  }
}

export function decodeText(bytes: Uint8Array, size: number, truncated: boolean): TarText {
  if (bytes.subarray(0, 8192).includes(0)) return { kind: "binary", size };
  try {
    // stream:true when truncated so a multibyte char cut at the cap isn't an error.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated });
    return { kind: "text", text, size, truncated };
  } catch {
    return { kind: "binary", size };
  }
}

// Shared "open anyway?" gate before showing a file that doesn't look like text.
export async function confirmOpenText(path: string): Promise<boolean> {
  return looksTextFile(path) || confirmAction(`${path.split("/").pop()} 看起来不是文本文件，仍要打开？`, { title: "打开非文本文件", confirmText: "继续打开" });
}
