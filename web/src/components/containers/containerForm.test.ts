import { describe, it, expect } from "vitest";
import { emptyForm, formToPayload, parseRunIntoForm } from "./containerForm";

describe("formToPayload", () => {
  it("interprets Docker memory units as bytes by default", () => {
    for (const [value, mb] of [["268435456", "256"], ["256m", "256"], ["1g", "1024"], ["1024k", "1"], ["1048576b", "1"]]) {
      expect(parseRunIntoForm(`docker run --memory ${value} alpine`).memory).toBe(mb);
    }
    expect(parseRunIntoForm("docker run --memory-swap -1 alpine").memory_swap).toBe("-1");
    expect(parseRunIntoForm("docker run --memory-swap 536870912 alpine").memory_swap).toBe("512");
  });
  it("splits env/labels and converts memory MB to bytes", () => {
    const f = emptyForm();
    f.name = "web";
    f.image = "nginx";
    f.env = "A=1\nB=2";
    f.labels = "team=infra";
    f.memory = "256";
    const p = formToPayload(f);
    expect(p.name).toBe("web");
    expect(p.env).toEqual(["A=1", "B=2"]);
    expect(p.labels).toEqual({ team: "infra" });
    expect(p.memory).toBe(256 * 1024 * 1024);
  });
  it("omits empty optional fields", () => {
    const f = emptyForm();
    f.image = "nginx";
    const p = formToPayload(f);
    expect(p.image).toBe("nginx");
    expect("memory" in p).toBe(false);
    expect("env" in p).toBe(false);
  });
});
