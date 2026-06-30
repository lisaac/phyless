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

  const refresh = async () => {
    setLoading(true);
    try {
      const data = await get<T[]>(path);
      setItems(data ?? []);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const startPolling = () => {
    if (timer) return;
    void refresh();
    timer = setInterval(() => void refresh(), 5000); // ponytail: 5s fallback poll per spec
  };
  const stopPolling = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  return { items, loading, error, refresh, startPolling, stopPolling };
}
