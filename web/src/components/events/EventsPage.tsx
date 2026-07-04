import { Component } from "solid-js";
import { LogsView } from "../shared/LogsView";

// Reuses the exact same log-stream viewer as container/compose logs — each
// docker event arrives as one full JSON line (see ws.Events, which now
// appends "\n" per message), giving the full event payload (all Actor
// attributes) instead of a curated 4-column table.
export const EventsPage: Component = () => (
  <div>
    <h1 class="mb-4 text-xl font-semibold">事件</h1>
    <LogsView wsUrl="/ws/events" />
  </div>
);
