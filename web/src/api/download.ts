import { createSignal } from "solid-js";
import { getToken, setToken } from "./client";

export const DOWNLOAD_FALLBACK_LIMIT = 64 * 1024 * 1024;

interface WritableFile {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

interface SavePickerWindow extends Window {
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<{ createWritable(): Promise<WritableFile> }>;
}

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

// Streams a GET response to the native save picker when available, otherwise
// keeps a bounded fallback in memory (reporting bytes-so-far via onProgress —
// the exact total isn't known upfront for a tar built on the fly). url must carry whatever auth it needs itself
// (a query ?token= for routes gated by wsAuth, nothing extra for routes
// under the normal header-based auth middleware) — this always also sends
// the Authorization header, which routes that don't check it simply ignore.
const MAX_ERROR_BYTES = 64 * 1024;

async function readResponsePrefix(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < MAX_ERROR_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_ERROR_BYTES - bytes;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: bytes < MAX_ERROR_BYTES });
      if (chunk.byteLength < value.byteLength) break;
    }
    return text.slice(0, MAX_ERROR_BYTES);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function streamDownload(
  url: string,
  filename: string,
  onProgress: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  let writable: WritableFile | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const token = getToken();
  try {
    const picker = (window as SavePickerWindow).showSaveFilePicker;
    if (picker) {
      try {
        const handle = await picker.call(window, { suggestedName: filename });
        writable = await handle.createWritable();
      } catch (e) {
        // A deliberate picker cancellation is a cancellation of the download.
        if ((e as DOMException).name === "AbortError") throw e;
      }
    }

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token ?? ""}` },
      signal,
    });
    if (res.status === 401) {
      if (token === getToken()) {
        setToken(null);
        window.dispatchEvent(new CustomEvent("phyless:unauthorized"));
      }
      throw new Error("unauthorized");
    }
    if (!res.ok) {
      const message = await readResponsePrefix(res);
      throw new Error(message || res.statusText || `下载失败 (${res.status})`);
    }
    reader = res.body?.getReader();
    if (!reader) throw new Error("empty response");

    const chunks: Uint8Array[] = [];
    let total = 0;
    const declared = Number(res.headers.get("Content-Length"));
    if (!writable && Number.isFinite(declared) && declared > DOWNLOAD_FALLBACK_LIMIT) {
      throw new Error(`文件超过浏览器回退下载上限 ${fmtBytes(DOWNLOAD_FALLBACK_LIMIT)}`);
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (writable) await writable.write(value);
      else {
        if (total > DOWNLOAD_FALLBACK_LIMIT) throw new Error(`文件超过浏览器回退下载上限 ${fmtBytes(DOWNLOAD_FALLBACK_LIMIT)}`);
        chunks.push(value);
      }
      onProgress(total);
    }

    if (writable) {
      await writable.close();
      writable = undefined;
      return;
    }
    const blob = new Blob(chunks as BlobPart[]);
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
  } catch (e) {
    if (reader) await reader.cancel().catch(() => undefined);
    if (writable) {
      await writable.abort().catch(() => undefined);
      writable = undefined;
    }
    throw e;
  } finally {
    reader?.releaseLock();
  }
}

export interface DownloadState {
  active: boolean;
  filename: string;
  bytes: number;
  done: boolean;
  error: string;
}

// Shared download state machine — used by any page that offers a "download
// this file/dir as a tar" action via FileBrowser's onDownload. Tracks one
// in-flight download at a time; starting a new one aborts the previous.
export function createDownloadTask() {
  const [state, setState] = createSignal<DownloadState>({ active: false, filename: "", bytes: 0, done: false, error: "" });
  let controller: AbortController | undefined;
  let generation = 0;

  const start = async (url: string, filename: string) => {
    controller?.abort();
    const gen = ++generation;
    const c = new AbortController();
    controller = c;
    setState({ active: true, filename, bytes: 0, done: false, error: "" });
    try {
      await streamDownload(url, filename, (bytes) => setState((s) => ({ ...s, bytes })), c.signal);
      if (gen === generation) setState((s) => ({ ...s, done: true }));
    } catch (e) {
      if (gen === generation) setState((s) => ({ ...s, done: true, error: (e as Error).message }));
    } finally {
      if (controller === c) controller = undefined;
    }
  };

  const cancel = () => { generation++; controller?.abort(); setState((s) => ({ ...s, active: false })); };

  return { state, start, cancel };
}
