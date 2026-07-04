import type { ContainerSummary } from "../../types";

export function containerName(c: ContainerSummary): string {
  return (c.Names[0] ?? "").replace(/^\//, "");
}

export const STATE_DOT: Record<string, string> = {
  running:    "bg-emerald-500",
  paused:     "bg-amber-500/80",
  restarting: "bg-sky-500/70",
  exited:     "bg-zinc-600",
  dead:       "bg-red-600/80",
  created:    "bg-zinc-600",
};

// Parse Docker's English duration string ("2 hours", "About a minute", …) into compact form
function fmtDockerDur(s: string): string {
  if (/less than a second/i.test(s)) return "<1s";
  if (/about a minute/i.test(s)) return "~1m";
  const m = s.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?/i);
  if (!m) return s.trim();
  const units: Record<string, string> = { second: "s", minute: "m", hour: "h", day: "d", week: "w", month: "mo", year: "y" };
  return m[1] + (units[m[2].toLowerCase()] ?? m[2]);
}

// "Up 2 hours" / "Exited (0) 3 hours ago" → "运行 2h" / "停止 3h 前"
export function fmtContainerStatus(state: string, status: string): string {
  if (state === "running") {
    const dur = status.replace(/^Up\s+/i, "").replace(/\s*\(Paused\)\s*$/i, "");
    return `运行 ${fmtDockerDur(dur)}`;
  }
  if (state === "paused") {
    const dur = status.replace(/^Up\s+/i, "").replace(/\s*\(Paused\)\s*$/i, "");
    return `暂停 ${fmtDockerDur(dur)}`;
  }
  if (state === "exited") {
    const m = status.match(/Exited\s+\(\d+\)\s+(.+?)\s+ago/i);
    return m ? `停止 ${fmtDockerDur(m[1])} 前` : "已停止";
  }
  if (state === "restarting") {
    const m = status.match(/Restarting\s+\(\d+\)\s+(.+?)\s+ago/i);
    return m ? `重启 ${fmtDockerDur(m[1])} 前` : "重启中";
  }
  if (state === "created") return "已创建";
  if (state === "dead") return "已终止";
  return state;
}

// containerRunCommand builds a best-effort docker run string from a summary.
// ponytail: summaries lack full config; this seeds the converter, user can edit.
export function containerRunCommand(c: ContainerSummary): string {
  const parts = ["docker run -d"];
  const name = containerName(c);
  if (name) parts.push(`--name ${name}`);
  for (const p of c.Ports) {
    if (p.PublicPort) parts.push(`-p ${p.PublicPort}:${p.PrivatePort}`);
  }
  parts.push(c.Image);
  return parts.join(" ");
}
