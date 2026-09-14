import { beforeEach, describe, expect, it } from "vitest";
import { markSeen, removeTab, setTabs } from "./tabs";

describe("tab lifecycle", () => {
  beforeEach(() => setTabs([]));

  it("releases the animation marker when a tab closes", () => {
    expect(markSeen("/containers/one")).toBe(false);
    expect(markSeen("/containers/one")).toBe(true);
    removeTab("/containers/one");
    expect(markSeen("/containers/one")).toBe(false);
  });
});
