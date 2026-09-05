import { createSignal, type Accessor } from "solid-js";
import { get } from "../api/client";

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
  const schedule = () => {
    if (!polling || document.hidden || timer) return;
    timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000); // ponytail: one fallback poll per store
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
          setItems(data ?? []);
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
  };

  return { items, loading, error, refresh, startPolling, stopPolling };
}
