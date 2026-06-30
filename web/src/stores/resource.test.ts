import { describe, it, expect, vi, beforeEach } from "vitest";
import { createResourceStore } from "./resource";
import * as client from "../api/client";

beforeEach(() => vi.restoreAllMocks());

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
});
