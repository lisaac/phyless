import { createSignal, type Accessor } from "solid-js";
import { get } from "../api/client";
import { SETTLED_EVENT } from "./taskQueue";
import { REFRESH_EVENT, autoRefresh, refreshSeconds } from "./refresh";

export interface ResourceStore<T> {
  items: Accessor<T[]>;
  loading: Accessor<boolean>;
  error: Accessor<string>;
  refresh: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
}

export function createResourceStore<T>(path: string): ResourceStore<T> {
  const [items, setItems] = createSignal<T[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  let generation = 0;
  let polling = false;
  let lastSerialized = "[]";
  const onVisibilityChange = () => {
    if (document.hidden) {
      if (timer) clearInterval(timer);
      timer = undefined;
      generation++;
      setLoading(false);
    } else if (polling) {
      void refresh();
      schedule();
    }
  };
  // Any queued write finishing (stores/taskQueue.ts), a manual refreshAll()
  // or an auto-refresh setting change (stores/refresh.ts) refreshes every
  // polling store and restarts its timer with the current settings.
  const onSettled = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (!document.hidden) { void refresh(); schedule(); }
  };
  const schedule = () => {
    if (!polling || document.hidden || timer || !autoRefresh()) return;
    timer = setInterval(() => { if (!document.hidden) void refresh(); }, refreshSeconds() * 1000); // ponytail: one fallback poll per store
  };

  const refresh = () => {
    if (inFlight) return inFlight;
    const requestGeneration = generation;
    setLoading(true);
    let request!: Promise<void>;
    request = (async () => {
      try {
        const data = await get<T[]>(path);
        if (requestGeneration === generation) {
          // ponytail: JSON compare of the fetched payload — O(payload) per poll, but it
          // saves <For> re-creating every row when nothing changed. Switch to a per-item
          // keyed reconcile if the payload ever gets big enough for the compare to hurt.
          const serialized = JSON.stringify(data ?? []);
          if (serialized !== lastSerialized) {
            lastSerialized = serialized;
            setItems(data ?? []);
          }
          setError("");
        }
      } catch (e) {
        if (requestGeneration === generation) setError((e as Error).message);
      } finally {
        if (inFlight === request) {
          inFlight = undefined;
          if (requestGeneration === generation) setLoading(false);
          if (requestGeneration !== generation && polling && !document.hidden) void refresh();
        }
      }
    })();
    inFlight = request;
    return request;
  };

  const startPolling = () => {
    if (polling) return;
    polling = true;
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener(SETTLED_EVENT, onSettled);
    window.addEventListener(REFRESH_EVENT, onSettled);
    if (!document.hidden) {
      void refresh();
      schedule();
    }
  };
  const stopPolling = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    polling = false;
    generation++;
    setLoading(false);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener(SETTLED_EVENT, onSettled);
    window.removeEventListener(REFRESH_EVENT, onSettled);
  };

  return { items, loading, error, refresh, startPolling, stopPolling };
}
