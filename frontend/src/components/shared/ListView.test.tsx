import { afterEach, describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import { createListView } from "./ListView";

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
});
