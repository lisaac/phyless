import { afterEach, expect, it } from "vitest";
import { refreshSeconds, setRefreshSeconds } from "./refresh";

afterEach(() => setRefreshSeconds(5));

it("keeps timer delays finite and inside the signed 32-bit millisecond range", () => {
  for (const invalid of [Infinity, -Infinity, NaN]) {
    setRefreshSeconds(invalid);
    expect(refreshSeconds()).toBe(5);
  }
  setRefreshSeconds(Number.MAX_VALUE);
  expect(refreshSeconds() * 1000).toBeLessThanOrEqual(2 ** 31 - 1);
  setRefreshSeconds(2.9);
  expect(refreshSeconds()).toBe(2);
});
