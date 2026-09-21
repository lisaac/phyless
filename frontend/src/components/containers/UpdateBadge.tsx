import { Component, Show } from "solid-js";
import { UPDATE_LABEL, isUpgradable, type UpdateCheck } from "../../stores/updateCheck";
import { fmtRelTime } from "./containerActions";

const short = (d?: string) => (d ? d.replace(/^sha256:/, "").slice(0, 12) : "?");

export function updateCheckTitle(c: UpdateCheck): string {
  const lines = [UPDATE_LABEL[c.status]];
  if (c.remote_id) lines.push(`本地 ${short(c.local_id)} → 远端 ${short(c.remote_id)}`);
  if (c.error) lines.push(c.error);
  lines.push(`检查于 ${fmtRelTime(Math.floor(c.checkedAt / 1000))}`);
  return lines.join("\n");
}

// The one "upgrade available" marker, shared by container rows, the detail
// header and the upgrade dialog. "latest" renders nothing to keep lists quiet;
// failures collapse to a grey "?" with the reason in the tooltip.
export const UpdateBadge: Component<{ check?: UpdateCheck; showLatest?: boolean }> = (p) => (
  <Show when={p.check}>
    {(c) => (
      <Show
        when={isUpgradable(c())}
        fallback={
          <Show when={c().status !== "latest" || p.showLatest}>
            <span class="shrink-0 cursor-help text-[10px] text-zinc-500" title={updateCheckTitle(c())}>
              {c().status === "latest" ? "✓ 最新" : "?"}
            </span>
          </Show>
        }
      >
        <span
          class="shrink-0 cursor-help border border-amber-500/40 bg-amber-500/10 px-1 text-[10px] leading-4 text-amber-400"
          title={updateCheckTitle(c())}
        >
          {UPDATE_LABEL[c().status]}
        </span>
      </Show>
    )}
  </Show>
);
