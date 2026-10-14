import { afterEach, describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import { createListView, by } from "./ListView";

const items = Array.from({ length: 500 }, (_, i) => ({ name: `item-${i}` }));

let dispose: (() => void) | undefined;
afterEach(() => dispose?.());

// createRoot's body runs inside one update cycle, so effects (the limit reset)
// only flush after it returns — build the view here, assert outside.
const view = () => createRoot((d) => { dispose = d; return createListView(() => items, (i) => i.name); });

describe("createListView", () => {
  it("filters case-insensitively on the trimmed query", () => {
    const v = view();
    expect(v.filtered()).toBe(items); // empty query: same array, no copy
    v.setQuery("  ITEM-499 ");
    expect(v.filtered().map((i) => i.name)).toEqual(["item-499"]);
  });

  it("grows on loadMore and resets the limit when the query changes", () => {
    const v = view();
    const page = v.visible().length;
    expect(page).toBeGreaterThan(0);
    expect(v.hasMore()).toBe(true);

    v.loadMore();
    expect(v.visible().length).toBe(page * 2);

    v.setQuery("item-1");
    expect(v.visible().length).toBe(page);
  });

  it("filters by chip and cycles header sort asc → desc → off", () => {
    const rows = [{ n: "b10", v: 2 }, { n: "a2", v: 1 }, { n: "b9", v: 3 }];
    const v = createRoot((d) => {
      dispose = d;
      return createListView(() => rows, (r) => r.n, {
        sort: { n: by((r) => r.n), v: by((r) => r.v) },
        filters: [
          { key: "b", label: "b", tone: "zinc", match: (r) => r.n.startsWith("b") },
          { key: "a", label: "a", tone: "zinc", match: (r) => r.n.startsWith("a") },
          { key: "big", label: "big", tone: "zinc", group: "v", match: (r) => r.v > 1 },
        ],
      });
    });
    v.toggleSort("n");
    expect(v.filtered().map((r) => r.n)).toEqual(["a2", "b9", "b10"]); // natural order
    v.toggleSort("n");
    expect(v.filtered().map((r) => r.n)).toEqual(["b10", "b9", "a2"]);
    v.toggleSort("n");
    expect(v.filtered()).toBe(rows);
    v.toggleSort("v");
    v.setFilter(["b"]);
    expect(v.count("b")).toBe(2);
    expect(v.filtered().map((r) => r.v)).toEqual([2, 3]);
    v.setFilter(["b", "a"]); // same group → OR
    expect(v.filtered().map((r) => r.v)).toEqual([1, 2, 3]);
    v.setFilter(["a", "big"]); // different groups → AND
    expect(v.filtered()).toEqual([]);
  });
});
