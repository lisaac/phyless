import { describe, it, expect } from "vitest";
import { containerRunCommand } from "./containerActions";
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
