// navigator.clipboard is undefined in insecure contexts (plain http:// on a
// LAN IP, not localhost) — calling .writeText there throws, and every
// existing call site did `void navigator.clipboard.writeText(...)` with no
// catch, so the failure was silently swallowed and a "已复制" success toast
// fired regardless of whether anything actually reached the clipboard. This
// falls back to the legacy execCommand path, which still works over plain
// HTTP, and reports real success/failure to the caller.
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* fall through to legacy path */ }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
