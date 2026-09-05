import { describe, expect, it } from "vitest";
import { networkRates } from "./stats";

describe("networkRates", () => {
  it("uses elapsed sample time and establishes a zero-rate baseline", () => {
    const first = networkRates({ rx: 100, tx: 50 }, undefined, 1_000);
    expect(first.rx).toBe(0);
    const second = networkRates({ rx: 300, tx: 150 }, first.sample, 1_500);
    expect(second.rx).toBe(400);
    expect(second.tx).toBe(200);
  });

  it("resets the baseline when a daemon counter goes backwards", () => {
    const first = networkRates({ rx: 100, tx: 50 }, undefined, 1_000);
    const reset = networkRates({ rx: 10, tx: 5 }, first.sample, 2_000);
    expect(reset.rx).toBe(0);
    expect(reset.tx).toBe(0);
    const next = networkRates({ rx: 20, tx: 15 }, reset.sample, 3_000);
    expect(next.rx).toBe(10);
    expect(next.tx).toBe(10);
  });
});
