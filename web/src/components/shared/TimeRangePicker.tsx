import { Component, createSignal, Show, For } from "solid-js";

// Shared by events/container-logs/compose-logs: preset (实时/1h/24h/7d) or a
// custom range, reported as unix-seconds since/until (undefined = unbounded,
// i.e. "live"). Callers turn this into their own wsUrl via appendTimeRange.
type Preset = "live" | "1h" | "24h" | "7d" | "custom";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "live", label: "实时" },
  { key: "1h", label: "最近 1 小时" },
  { key: "24h", label: "最近 24 小时" },
  { key: "7d", label: "最近 7 天" },
  { key: "custom", label: "自定义" },
];

export type TimeRange = { since?: number; until?: number };

// datetime-local has no timezone info — Date.parse treats it as local time,
// which is what the picker actually shows, so this is correct without any
// extra UTC conversion.
function toUnix(datetimeLocal: string): number | undefined {
  if (!datetimeLocal) return undefined;
  const ms = new Date(datetimeLocal).getTime();
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

// Docker replays history up to `until` (or now, if omitted) then keeps
// streaming live only when `until` is unset/in the future — appends
// since/until as query params, joining with & instead of ? if the base
// already has some (e.g. compose logs' "?id=X").
export function appendTimeRange(base: string, range: TimeRange): string {
  const params = new URLSearchParams();
  if (range.since !== undefined) params.set("since", String(range.since));
  if (range.until !== undefined) params.set("until", String(range.until));
  const qs = params.toString();
  if (!qs) return base;
  return base + (base.includes("?") ? "&" : "?") + qs;
}

export const TimeRangePicker: Component<{ onChange: (range: TimeRange) => void }> = (props) => {
  const [preset, setPreset] = createSignal<Preset>("live");
  const [sinceInput, setSinceInput] = createSignal("");
  const [untilInput, setUntilInput] = createSignal("");

  const apply = (p: Preset, sinceStr: string, untilStr: string) => {
    if (p === "live") { props.onChange({}); return; }
    const now = Math.floor(Date.now() / 1000);
    if (p === "1h") { props.onChange({ since: now - 3600 }); return; }
    if (p === "24h") { props.onChange({ since: now - 86400 }); return; }
    if (p === "7d") { props.onChange({ since: now - 7 * 86400 }); return; }
    props.onChange({ since: toUnix(sinceStr), until: toUnix(untilStr) });
  };

  const selectPreset = (p: Preset) => { setPreset(p); apply(p, sinceInput(), untilInput()); };

  return (
    <div class="flex flex-wrap items-center gap-1.5">
      <For each={PRESETS}>
        {(p) => (
          <button
            class={`px-2.5 py-1 text-xs transition-colors ${
              preset() === p.key
                ? "bg-indigo-600 text-white"
                : "border border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-200"
            }`}
            onClick={() => selectPreset(p.key)}
          >{p.label}</button>
        )}
      </For>
      <Show when={preset() === "custom"}>
        <input
          type="datetime-local"
          class="border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-indigo-500"
          value={sinceInput()}
          onInput={(e) => { setSinceInput(e.currentTarget.value); apply("custom", e.currentTarget.value, untilInput()); }}
        />
        <span class="text-xs text-zinc-500">至</span>
        <input
          type="datetime-local"
          class="border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-indigo-500"
          value={untilInput()}
          onInput={(e) => { setUntilInput(e.currentTarget.value); apply("custom", sinceInput(), e.currentTarget.value); }}
        />
      </Show>
    </div>
  );
};
