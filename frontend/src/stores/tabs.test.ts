import { beforeEach, describe, expect, it } from "vitest";
import { markSeen, moveTab, openOrActivate, removeTab, setTabs, tabs } from "./tabs";

describe("tab lifecycle", () => {
  beforeEach(() => setTabs([]));

  it("releases the animation marker when a tab closes", () => {
    expect(markSeen("/containers/one")).toBe(false);
    expect(markSeen("/containers/one")).toBe(true);
    removeTab("/containers/one");
    expect(markSeen("/containers/one")).toBe(false);
  });

  it("skips sidebar pages and reorders by drag index", () => {
    for (const p of ["/containers", "/containers/a", "/compose/b", "/containers/c"]) openOrActivate(p, p);
    expect(tabs().map((t) => t.path)).toEqual(["/containers/a", "/compose/b", "/containers/c"]);
    moveTab("/containers/a", 2);
    expect(tabs().map((t) => t.path)).toEqual(["/compose/b", "/containers/c", "/containers/a"]);
    moveTab("/containers/a", 0);
    expect(tabs().map((t) => t.path)).toEqual(["/containers/a", "/compose/b", "/containers/c"]);
  });
});
