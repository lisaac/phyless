import composerize from "composerize";
import decomposerize from "decomposerize";

export function runToCompose(cmd: string): string {
  const trimmed = cmd.trim();
  if (!trimmed) throw new Error("empty command");
  try {
    const yaml = composerize(trimmed);
    if (!yaml || !yaml.includes("services:")) throw new Error("conversion produced no services");
    return yaml;
  } catch (e) {
    throw new Error(`cannot convert to compose: ${(e as Error).message}`);
  }
}

export function composeToRun(yaml: string): string {
  const trimmed = yaml.trim();
  if (!trimmed) throw new Error("empty compose");
  try {
    const out = decomposerize(trimmed);
    if (!out || !out.includes("docker run")) throw new Error("conversion produced no command");
    return out;
  } catch (e) {
    throw new Error(`cannot convert to docker run: ${(e as Error).message}`);
  }
}

// composeToRuns splits decomposerize output into individual `docker run` commands.
// decomposerize joins multiple services with newlines; each line is a full command.
export function composeToRuns(yaml: string): string[] {
  const out = composeToRun(yaml);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("docker run"));
}
