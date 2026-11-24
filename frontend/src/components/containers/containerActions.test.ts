import { describe, it, expect, vi } from "vitest";
import { containerRunCommand, findContainer, fmtRelTime } from "./containerActions";
import type { ContainerSummary } from "../../types";

const base: ContainerSummary = {
  Id: "abc123",
  Names: ["/web"],
  Image: "nginx:latest",
  State: "running",
  Status: "Up 2 minutes",
  Created: 0,
  Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: "tcp" }],
  Mounts: [],
  Command: "nginx",
};

describe("containerRunCommand", () => {
  it("includes name, published port, and image", () => {
    const cmd = containerRunCommand(base);
    expect(cmd).toContain("docker run");
    expect(cmd).toContain("--name web");
    expect(cmd).toContain("-p 8080:80");
    expect(cmd).toContain("nginx:latest");
  });
  it("omits port flag when not published", () => {
    const cmd = containerRunCommand({ ...base, Ports: [{ PrivatePort: 80, Type: "tcp" }] });
    expect(cmd).not.toContain("-p ");
  });
});

describe("findContainer", () => {
  const list = [{ Id: "abc123def", Names: ["/vpn"] }, { Id: "ffff", Names: ["/web"] }] as ContainerSummary[];
  it("resolves a container:<ref> target by full id, id prefix or name", () => {
    expect(findContainer(list, "abc123def")?.Names[0]).toBe("/vpn");
    expect(findContainer(list, "abc1")?.Names[0]).toBe("/vpn");
    expect(findContainer(list, "web")?.Id).toBe("ffff");
    expect(findContainer(list, "nope")).toBeUndefined();
  });
});

describe("fmtRelTime reactivity", () => {
  it("re-renders on a poll even though Created did not change", async () => {
    const { createRoot, createMemo } = await import("solid-js");
    const { setNow } = await import("../../stores/refresh");
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    const created = 1_000_000_000 - 120; // 2m ago
    createRoot((dispose) => {
      const text = createMemo(() => fmtRelTime(created));
      expect(text()).toBe("2m 前");
      vi.setSystemTime(1_000_000_000_000 + 3 * 60_000);
      setNow(Date.now());
      expect(text()).toBe("5m 前");
      dispose();
    });
    vi.useRealTimers();
  });
});
