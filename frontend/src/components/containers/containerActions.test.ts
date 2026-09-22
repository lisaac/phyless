import { describe, it, expect } from "vitest";
import { containerRunCommand, findContainer } from "./containerActions";
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
