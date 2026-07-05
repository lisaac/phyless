import { Component, createSignal } from "solid-js";
import { LogsView } from "../shared/LogsView";
import { TimeRangePicker, appendTimeRange, type TimeRange } from "../shared/TimeRangePicker";

// Reuses the exact same log-stream viewer as container/compose logs — each
// docker event arrives as one formatted line (see ws.Events' formatEvent).
export const EventsPage: Component = () => {
  const [range, setRange] = createSignal<TimeRange>({});
  const wsUrl = () => appendTimeRange("/ws/events", range());

  return (
    <div>
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 class="text-xl font-semibold">事件</h1>
        <TimeRangePicker onChange={setRange} />
      </div>
      <LogsView wsUrl={wsUrl()} heightClass="h-[calc(100vh-14rem)]" />
    </div>
  );
};
