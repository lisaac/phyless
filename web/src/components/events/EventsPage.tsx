import { Component, createSignal, Show, For } from "solid-js";
import { LogsView } from "../shared/LogsView";

// Reuses the exact same log-stream viewer as container/compose logs — each
// docker event arrives as one formatted line (see ws.Events' formatEvent).
type Preset = "live" | "1h" | "24h" | "7d" | "custom";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "live", label: "实时" },
  { key: "1h", label: "最近 1 小时" },
  { key: "24h", label: "最近 24 小时" },
  { key: "7d", label: "最近 7 天" },
  { key: "custom", label: "自定义" },
];

// datetime-local has no timezone info — Date.parse treats it as local time,
// which is what the picker actually shows, so this is correct without any
// extra UTC conversion.
function toUnix(datetimeLocal: string): number | undefined {
  if (!datetimeLocal) return undefined;
  const ms = new Date(datetimeLocal).getTime();
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

export const EventsPage: Component = () => {
  const [preset, setPreset] = createSignal<Preset>("live");
  const [sinceInput, setSinceInput] = createSignal("");
  const [untilInput, setUntilInput] = createSignal("");

  // Docker replays history up to `until` (or now, if omitted) then keeps
  // streaming live only when `until` is unset/in the future — so "live"
  // just omits both bounds, and any past-dated preset naturally stops after
  // replaying instead of continuing to tail.
  const wsUrl = () => {
    const p = preset();
    if (p === "live") return "/ws/events";
    const now = Math.floor(Date.now() / 1000);
    let since: number | undefined;
    let until: number | undefined;
    if (p === "1h") since = now - 3600;
    else if (p === "24h") since = now - 86400;
    else if (p === "7d") since = now - 7 * 86400;
    else { since = toUnix(sinceInput()); until = toUnix(untilInput()); }
    const params = new URLSearchParams();
    if (since !== undefined) params.set("since", String(since));
    if (until !== undefined) params.set("until", String(until));
    const qs = params.toString();
    return qs ? `/ws/events?${qs}` : "/ws/events";
  };

  return (
    <div>
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 class="text-xl font-semibold">事件</h1>
        <div class="flex flex-wrap items-center gap-1.5">
          <For each={PRESETS}>
            {(p) => (
              <button
                class={`px-2.5 py-1 text-xs transition-colors ${
                  preset() === p.key
                    ? "bg-indigo-600 text-white"
                    : "border border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-200"
                }`}
                onClick={() => setPreset(p.key)}
              >{p.label}</button>
            )}
          </For>
          <Show when={preset() === "custom"}>
            <input
              type="datetime-local"
              class="border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-indigo-500"
              value={sinceInput()}
              onInput={(e) => setSinceInput(e.currentTarget.value)}
            />
            <span class="text-xs text-zinc-500">至</span>
            <input
              type="datetime-local"
              class="border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-indigo-500"
              value={untilInput()}
              onInput={(e) => setUntilInput(e.currentTarget.value)}
            />
          </Show>
        </div>
      </div>
      <LogsView wsUrl={wsUrl()} />
    </div>
  );
};
