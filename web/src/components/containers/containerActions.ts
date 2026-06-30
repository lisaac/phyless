import type { ContainerSummary } from "../../types";

export function containerName(c: ContainerSummary): string {
  return (c.Names[0] ?? "").replace(/^\//, "");
}

// containerRunCommand builds a best-effort docker run string from a summary.
// ponytail: summaries lack full config; this seeds the converter, user can edit.
export function containerRunCommand(c: ContainerSummary): string {
  const parts = ["docker run -d"];
  const name = containerName(c);
  if (name) parts.push(`--name ${name}`);
  for (const p of c.Ports) {
    if (p.PublicPort) parts.push(`-p ${p.PublicPort}:${p.PrivatePort}`);
  }
  parts.push(c.Image);
  return parts.join(" ");
}
