import { getToken, readSignal, setToken } from "./client";

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
// internal/api/filecontent.go's maxFileContent). Returns null on 401 (after
// dispatching the same global unauthorized event the rest of the app uses).
export async function fetchTextFile(url: string, signal?: AbortSignal): Promise<{ text: string; truncated: boolean } | null> {
  const token = getToken();
  const read = readSignal(signal);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token ?? ""}` }, signal: read.signal });
    if (res.status === 401) {
      if (token === getToken()) {
        setToken(null);
        window.dispatchEvent(new CustomEvent("phyless:unauthorized"));
      }
      return null;
    }
    if (!res.ok) throw new Error(await res.text());
    const text = await res.text();
    return { text, truncated: res.headers.get("X-Truncated") === "true" };
  } finally {
    read.dispose();
  }
}
