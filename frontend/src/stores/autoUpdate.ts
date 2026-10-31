import { createPollingResource } from "./resource";
import { SETTLED_EVENT, enqueue, queued } from "./taskQueue";
import { REFRESH_EVENT } from "./refresh";

// Scheduled update policies (backend/internal/api/autoupdate.go). The server
// runs them; the browser only edits and shows them, so there is no polling:
// one load on first use, then reloads after any finished task or refresh.

export type AutoUpdateKind = "container" | "compose";
export type ScheduleKind = "hours" | "daily" | "weekly" | "monthly";
export interface Schedule { kind: ScheduleKind; every?: number; time?: string; weekday?: number; day?: number }

export interface AutoUpdatePolicy {
  id: string;
  kind: AutoUpdateKind;
  target: string;
  enabled: boolean;
  mode: "check" | "update";
  schedule: Schedule;
  proxy_url?: string;
  registry_ids?: string[];
  remove_old_image?: boolean;
  updated_at?: string;
  last_run_at?: string;
  last_status?: "running" | "latest" | "available" | "updated" | "handed-off" | "skipped" | "error";
  last_error?: string;
  last_log?: string[];
}

let store: ReturnType<typeof createPollingResource<AutoUpdatePolicy[]>> | undefined;

/** The policy of a target; the first call loads the list and subscribes. */
export function autoUpdateFor(kind: AutoUpdateKind, target: string | undefined): AutoUpdatePolicy | undefined {
  if (!store) {
    const s = store = createPollingResource<AutoUpdatePolicy[]>("/api/auto-updates", [], "id");
    const reload = () => void s.refresh();
    window.addEventListener(SETTLED_EVENT, reload);
    window.addEventListener(REFRESH_EVENT, reload);
    reload();
  }
  return target ? store.items().find((p) => p.kind === kind && p.target === target) : undefined;
}

export const saveAutoUpdate = (p: Omit<AutoUpdatePolicy, "id"> & { id?: string }) =>
  queued(`自动更新设置 — ${p.target}`, "PUT", "/api/auto-updates", p);

export const deleteAutoUpdate = (p: AutoUpdatePolicy) =>
  queued(`删除自动更新 — ${p.target}`, "DELETE", `/api/auto-updates/${encodeURIComponent(p.id)}`);

export const runAutoUpdate = (p: AutoUpdatePolicy) =>
  enqueue({ title: `自动更新（立即执行）— ${p.target}`, url: `/api/auto-updates/${encodeURIComponent(p.id)}/run`, key: `auto-update:${p.id}` });

export const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function scheduleLabel(s: Schedule): string {
  switch (s.kind) {
    case "hours": return `每 ${s.every} 小时`;
    case "daily": return `每天 ${s.time}`;
    case "weekly": return `每${WEEKDAYS[s.weekday ?? 0]} ${s.time}`;
    case "monthly": return `每月 ${s.day} 日 ${s.time}`;
  }
}

export const AUTO_STATUS_LABEL: Record<NonNullable<AutoUpdatePolicy["last_status"]>, string> = {
  running: "运行中",
  latest: "已是最新",
  available: "有新版本",
  updated: "已更新",
  "handed-off": "已交给 helper 更新",
  skipped: "已跳过",
  error: "失败",
};
