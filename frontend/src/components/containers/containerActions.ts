import { enqueue, isPending } from "../../stores/taskQueue";
import type { ContainerSummary } from "../../types";

export function containerName(c: ContainerSummary): string {
  return (c.Names[0] ?? "").replace(/^\//, "");
}

export function fmtRelTime(unix: number): string {
  const diff = Date.now() - unix * 1000;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m}m 前`;
  if (h < 24) return `${h}h 前`;
  if (d < 30) return `${d}d 前`;
  const dt = new Date(unix * 1000);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

// Show last 1-2 path segments, max ~16 chars.
// Middle-ellipsis: keep the start and end of the path so both context and target are visible.
export function midPath(p: string, max = 26): string {
  if (!p || p.length <= max) return p;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - head - 1;
  return p.slice(0, head) + "…" + p.slice(p.length - tail);
}

export const VERB_LABEL: Record<string, string> = {
  start: "启动", stop: "停止", restart: "重启", pause: "暂停", unpause: "恢复", kill: "强制关闭", delete: "删除",
};

// Per-container start/stop/pause/kill/delete through the global task queue
// (stores/taskQueue.ts): same container id = same key, so verbs on one
// container run in order; list stores refresh themselves on settle.
export function createContainerActions() {
  const isP = (id: string, verb: string) => isPending((t) => t.meta?.containerId === id && t.meta?.verb === verb);
  const act = (id: string, verb: string, name?: string) => enqueue({
    title: `${VERB_LABEL[verb] ?? verb} ${name || id.slice(0, 12)}`,
    method: verb === "delete" ? "DELETE" : "POST",
    url: verb === "delete" ? `/api/containers/${id}` : `/api/containers/${id}/${verb}`,
    key: id,
    meta: { containerId: id, verb },
  }).done;
  return { isP, act };
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
