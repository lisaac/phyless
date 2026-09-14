import { describe, it, expect, vi, beforeEach } from "vitest";
import { createResourceStore } from "./resource";
import * as client from "../api/client";
import { setAutoRefresh, setRefreshSeconds, refreshAll } from "./refresh";

beforeEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe("createResourceStore", () => {
  it("loads items from the endpoint on refresh", async () => {
    vi.spyOn(client, "get").mockResolvedValue([{ id: "1" }, { id: "2" }]);
    const store = createResourceStore<{ id: string }>("/api/things");
    await store.refresh();
    expect(store.items().length).toBe(2);
    expect(store.error()).toBe("");
  });

  it("captures error message on failure", async () => {
    vi.spyOn(client, "get").mockRejectedValue(new Error("boom"));
    const store = createResourceStore("/api/things");
    await store.refresh();
    expect(store.error()).toContain("boom");
  });

  it("deduplicates an in-flight request and ignores it after stop", async () => {
    let resolve!: (value: { id: string }[]) => void;
    const pending = new Promise<{ id: string }[]>((r) => { resolve = r; });
    vi.spyOn(client, "get").mockImplementation(() => pending as never);
    const store = createResourceStore<{ id: string }>("/api/things");
    const first = store.refresh();
    const second = store.refresh();
    expect(first).toBe(second);
    expect(client.get).toHaveBeenCalledTimes(1);
    store.stopPolling();
    resolve([{ id: "late" }]);
    await first;
    expect(store.items()).toEqual([]);
  });

  it("pauses polling while hidden and refreshes once when visible", async () => {
    vi.useFakeTimers();
    vi.spyOn(client, "get").mockResolvedValue([]);
    const store = createResourceStore("/api/things");
    store.startPolling();
    await Promise.resolve();
    expect(client.get).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(15_000);
    expect(client.get).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(client.get).toHaveBeenCalledTimes(2);
    store.stopPolling();
    vi.useRealTimers();
  });
});

describe("createResourceStore + task queue", () => {
  it("refreshes when a queued task settles while polling", async () => {
    const get = vi.spyOn(client, "get").mockResolvedValue([]);
    const store = createResourceStore("/api/things");
    store.startPolling();
    await Promise.resolve();
    const before = get.mock.calls.length;
    window.dispatchEvent(new CustomEvent("phyless:task-settled", { detail: { status: "done" } }));
    expect(get.mock.calls.length).toBe(before + 1);
    store.stopPolling();
    window.dispatchEvent(new CustomEvent("phyless:task-settled", { detail: { status: "done" } }));
    expect(get.mock.calls.length).toBe(before + 1);
  });
});

describe("createResourceStore + refresh settings", () => {
  it("stops polling when auto-refresh is off and refreshes on refreshAll", async () => {
    vi.useFakeTimers();
    const get = vi.spyOn(client, "get").mockResolvedValue([]);
    const store = createResourceStore("/api/things");
    store.startPolling();
    await Promise.resolve();
    setAutoRefresh(false);
    await Promise.resolve();
    const before = get.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(get.mock.calls.length).toBe(before);
    refreshAll();
    expect(get.mock.calls.length).toBe(before + 1);
    store.stopPolling();
    setAutoRefresh(true);
    vi.useRealTimers();
  });

  it("changing the interval restarts the timer with the new cadence", async () => {
    vi.useFakeTimers();
    const get = vi.spyOn(client, "get").mockResolvedValue([]);
    const store = createResourceStore("/api/things");
    store.startPolling();
    await Promise.resolve();
    setRefreshSeconds(2);
    await Promise.resolve();
    const before = get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(get.mock.calls.length).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(get.mock.calls.length).toBe(before + 2);
    store.stopPolling();
    setRefreshSeconds(5);
    vi.useRealTimers();
  });
});
