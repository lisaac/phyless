import { Component, For, Match, Show, Switch, createEffect, createSignal, on } from "solid-js";
import { createStore } from "solid-js/store";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { PullOptions, createPullOptions } from "./PullOptions";
import { RemoveOldImageCheckbox } from "./RemoveOldImage";
import { confirmAction } from "./ConfirmModal";
import { toast } from "./Toast";
import {
  AUTO_STATUS_LABEL, UPDATE_STATUS_LABEL, WEEKDAYS, autoUpdateFor, statusTone, deleteAutoUpdate, runAutoUpdate, saveAutoUpdate, scheduleLabel,
  type AutoUpdateKind, type AutoUpdatePolicy, type Schedule, type ScheduleKind,
} from "../../stores/autoUpdate";

// The one auto-update UI for containers and Compose projects: a header badge,
// the settings dialog and the run/update record shared with the global page.
// Pages own the button that opens the dialog.

const inputCls = "min-w-0 border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs outline-none transition-colors focus:border-indigo-500";

export const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "");

const TONE_CLS = { bad: "text-red-400", warn: "text-amber-400", ok: "text-emerald-400" };
export const toneCls = (s?: string) => TONE_CLS[statusTone(s)];

function badgeTitle(p: AutoUpdatePolicy): string {
  const lines = [`自动${p.mode === "update" ? "更新" : "检查"}：${scheduleLabel(p.schedule)}${p.enabled ? "" : "（已停用）"}`];
  if (p.last_run_at) lines.push(`上次运行 ${fmtTime(p.last_run_at)}：${p.last_status ? AUTO_STATUS_LABEL[p.last_status] : ""}`);
  if (p.last_error) lines.push(p.last_error);
  if (p.last_update_at) lines.push(`最近更新 ${fmtTime(p.last_update_at)}：${p.last_update_status ? UPDATE_STATUS_LABEL[p.last_update_status] : ""}`);
  return lines.join("\n");
}

/** Last run and last update of a policy, with reasons; dialog and global page. */
export const AutoUpdateRecord: Component<{ policy: AutoUpdatePolicy; log?: boolean }> = (props) => (
  <div class="space-y-1 text-xs">
    <div>
      <span class="text-zinc-500">上次运行 </span>
      <Show when={props.policy.last_run_at} fallback={<span class="text-zinc-500">尚未运行</span>}>
        <span class="text-zinc-400">{fmtTime(props.policy.last_run_at)} </span>
        <span class={toneCls(props.policy.last_status)}>{props.policy.last_status ? AUTO_STATUS_LABEL[props.policy.last_status] : ""}</span>
      </Show>
      <Show when={props.policy.missing_since}>
        <span class="text-zinc-500">（自 {fmtTime(props.policy.missing_since)} 起找不到目标）</span>
      </Show>
      <Show when={props.policy.last_error}><div class="break-all text-red-400">{props.policy.last_error}</div></Show>
    </div>
    <div>
      <span class="text-zinc-500">最近更新 </span>
      <Show when={props.policy.last_update_at} fallback={<span class="text-zinc-500">从未更新</span>}>
        <span class="text-zinc-400">{fmtTime(props.policy.last_update_at)} </span>
        <span class={toneCls(props.policy.last_update_status)}>
          {props.policy.last_update_status ? UPDATE_STATUS_LABEL[props.policy.last_update_status] : ""}
        </span>
        <Show when={props.policy.last_update_message}>
          <div class={`break-all ${statusTone(props.policy.last_update_status) === "bad" ? "text-red-400" : "text-zinc-400"}`}>
            {props.policy.last_update_message}
          </div>
        </Show>
      </Show>
    </div>
    <Show when={props.log && props.policy.last_log?.length}>
      <details>
        <summary class="cursor-pointer text-zinc-500">上次运行日志</summary>
        <pre class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all bg-zinc-950 p-2 font-mono text-[11px] text-zinc-400">{props.policy.last_log!.join("\n")}</pre>
      </details>
    </Show>
  </div>
);

/** Small marker next to a container/project name; nothing without a policy. */
export const AutoUpdateBadge: Component<{ kind: AutoUpdateKind; target?: string }> = (props) => {
  const p = () => autoUpdateFor(props.kind, props.target);
  const tone = () => (p()?.enabled ? toneCls(p()?.last_status) : "text-zinc-500");
  return (
    <Show when={p()}>
      {(pol) => <span class={`shrink-0 cursor-help text-[10px] font-normal ${tone()}`} title={badgeTitle(pol())}>⟳ 自动</span>}
    </Show>
  );
};

const defaultSchedule = (): Schedule => ({ kind: "daily", time: "04:00", every: 24, weekday: 0, day: 1 });

export const AutoUpdateModal: Component<{
  kind: AutoUpdateKind;
  target: string | null; // container name or Compose project id; null = closed
  title: string;
  onClose: () => void;
}> = (props) => {
  const pull = createPullOptions();
  const policy = () => autoUpdateFor(props.kind, props.target ?? undefined);
  const [enabled, setEnabled] = createSignal(true);
  const [mode, setMode] = createSignal<"check" | "update">("check");
  const [sched, setSched] = createStore<Schedule>(defaultSchedule());
  const [removeOld, setRemoveOld] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  // Fill the form whenever the dialog opens.
  createEffect(on(() => props.target, (t) => {
    if (!t) return;
    const p = policy();
    pull.reset();
    setEnabled(p?.enabled ?? true);
    setMode(p?.mode ?? "check");
    setSched({ ...defaultSchedule(), ...p?.schedule });
    setRemoveOld(p?.remove_old_image ?? false);
    if (p) pull.set({ useProxy: !!p.proxy_url, proxyUrl: p.proxy_url || pull.value.proxyUrl, registryIds: p.registry_ids ?? [] });
  }));

  const close = () => { pull.reset(); props.onClose(); };

  const schedulePayload = (): Schedule => {
    const s = sched;
    switch (s.kind) {
      case "hours": return { kind: "hours", every: Number(s.every) };
      case "daily": return { kind: "daily", time: s.time };
      case "weekly": return { kind: "weekly", weekday: Number(s.weekday), time: s.time };
      case "monthly": return { kind: "monthly", day: Number(s.day), time: s.time };
    }
  };

  const save = async () => {
    const o = pull.payload();
    setBusy(true);
    try {
      await saveAutoUpdate({
        id: policy()?.id, kind: props.kind, target: props.target!, enabled: enabled(), mode: mode(), schedule: schedulePayload(),
        proxy_url: o.proxy_url as string | undefined, registry_ids: o.registry_ids as string[] | undefined,
        remove_old_image: mode() === "update" && removeOld(),
      });
      close();
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    const p = policy();
    if (!p || !await confirmAction(`删除 ${props.title} 的自动更新设置？`, { title: "删除自动更新", confirmText: "删除" })) return;
    try { await deleteAutoUpdate(p); close(); } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <Modal open={!!props.target} onClose={close} title={`自动更新 — ${props.title}`}>
      <div class="space-y-3 text-xs text-zinc-300">
        <label class="flex items-center gap-2">
          <input type="checkbox" checked={enabled()} onChange={(e) => setEnabled(e.currentTarget.checked)} />
          启用
        </label>

        <div>
          <div class="mb-1 text-zinc-500">发现新版本时</div>
          <div class="flex flex-wrap gap-x-4 gap-y-1">
            <label class="flex items-center gap-1.5">
              <input type="radio" name="auto-update-mode" checked={mode() === "check"} onChange={() => setMode("check")} />
              只检查并标记
            </label>
            <label class="flex items-center gap-1.5">
              <input type="radio" name="auto-update-mode" checked={mode() === "update"} onChange={() => setMode("update")} />
              自动更新
            </label>
          </div>
        </div>

        <div>
          <div class="mb-1 text-zinc-500">时间（按服务端时区）</div>
          <div class="flex flex-wrap items-center gap-2">
            <select class={inputCls} value={sched.kind} onChange={(e) => setSched("kind", e.currentTarget.value as ScheduleKind)}>
              <option value="hours">每 N 小时</option>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
            </select>
            <Switch>
              <Match when={sched.kind === "hours"}>
                <input type="number" min="1" max="168" class={`${inputCls} w-20`} value={sched.every}
                  onInput={(e) => setSched("every", e.currentTarget.valueAsNumber)} />
                <span>小时</span>
              </Match>
              <Match when={sched.kind === "weekly"}>
                <select class={inputCls} value={sched.weekday} onChange={(e) => setSched("weekday", Number(e.currentTarget.value))}>
                  <For each={WEEKDAYS}>{(d, i) => <option value={i()}>{d}</option>}</For>
                </select>
              </Match>
              <Match when={sched.kind === "monthly"}>
                <input type="number" min="1" max="31" class={`${inputCls} w-16`} value={sched.day}
                  onInput={(e) => setSched("day", e.currentTarget.valueAsNumber)} />
                <span>日</span>
              </Match>
            </Switch>
            <Show when={sched.kind !== "hours"}>
              <input type="time" class={inputCls} value={sched.time} onInput={(e) => setSched("time", e.currentTarget.value)} />
            </Show>
          </div>
          <Show when={sched.kind === "monthly" && (sched.day ?? 0) > 28}>
            <p class="mt-1 text-zinc-500">当月没有这一天时，在当月最后一天执行。</p>
          </Show>
        </div>

        <Show when={mode() === "update"}>
          <p class="border border-amber-500/30 bg-amber-500/5 p-2 text-amber-400">
            更新会短暂停止并重建{props.kind === "compose" ? "有新版本的服务（只更新 image 服务，build 服务不重建）" : "容器"}，建议设在夜间。
          </p>
        </Show>

        <div>
          <div class="mb-1 text-zinc-500">拉取方式（定时任务在服务端执行，不支持浏览器代理）</div>
          <PullOptions options={pull} />
        </div>

        <Show when={mode() === "update"}>
          <RemoveOldImageCheckbox checked={removeOld()} onChange={setRemoveOld} />
        </Show>

        <Show when={policy()}>
          {(p) => <div class="border-t border-zinc-800 pt-2"><AutoUpdateRecord policy={p()} log /></div>}
        </Show>
      </div>

      <div class="mt-4 flex flex-wrap justify-end gap-2">
        <Show when={policy()}>
          <Button variant="danger" class="mr-auto" onClick={() => void remove()}>删除</Button>
          <Button title="按已保存的设置立即执行一次" onClick={() => { runAutoUpdate(policy()!); close(); }}>立即执行</Button>
        </Show>
        <Button onClick={close}>取消</Button>
        <Button variant="primary" disabled={busy()} onClick={() => void save()}>保存</Button>
      </div>
    </Modal>
  );
};
