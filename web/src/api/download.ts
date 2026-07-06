import { getToken, setToken } from "./client";

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

// Streams a GET response into memory (reporting bytes-so-far via onProgress
// — the exact total isn't known upfront for a tar being built on the fly,
// so this is a running count rather than a percentage) and triggers a
// browser save once complete. url must carry whatever auth it needs itself
// (a query ?token= for routes gated by wsAuth, nothing extra for routes
// under the normal header-based auth middleware) — this always also sends
// the Authorization header, which routes that don't check it simply ignore.
export async function streamDownload(
  url: string,
  filename: string,
  onProgress: (bytes: number) => void,
): Promise<void> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } });
  if (res.status === 401) {
    setToken(null);
    window.dispatchEvent(new CustomEvent("phyless:unauthorized"));
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error(await res.text());
  const reader = res.body?.getReader();
  if (!reader) throw new Error("empty response");

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    onProgress(total);
  }

  const blob = new Blob(chunks as BlobPart[]);
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(blobUrl);
}
