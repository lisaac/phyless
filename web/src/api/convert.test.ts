import { describe, it, expect } from "vitest";
import { runToCompose, composeToRun, composeToRuns } from "./convert";

describe("runToCompose", () => {
  it("converts a docker run command to compose yaml", () => {
    const yaml = runToCompose("docker run -d --name web -p 8080:80 nginx");
    expect(yaml).toContain("services:");
    expect(yaml).toContain("nginx");
  });
  it("throws a readable error on garbage input", () => {
    expect(() => runToCompose("")).toThrow();
  });
});

describe("composeToRun", () => {
  it("converts compose yaml back to a docker run command", () => {
    const yaml = `services:\n  web:\n    image: nginx\n    ports:\n      - "8080:80"\n`;
    const run = composeToRun(yaml);
    expect(run).toContain("docker run");
    expect(run).toContain("nginx");
  });
});

describe("composeToRuns", () => {
  it("splits multi-service output into separate commands", () => {
    const yaml = `services:\n  a:\n    image: nginx\n  b:\n    image: redis\n`;
    const runs = composeToRuns(yaml);
    expect(runs.length).toBe(2);
    expect(runs.every((r) => r.startsWith("docker run"))).toBe(true);
  });
});
