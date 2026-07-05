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

// ── Multi-command aware conversion — shared by RunComposeEditor (single OR
// multiple services, detected live from the content) and BulkRunModal ──────

export function mergeComposeYamls(yamls: string[]): string {
  const blocks = yamls.map((yaml) => {
    const lines = yaml.split("\n");
    const idx = lines.findIndex((l) => l.trimStart().startsWith("services:"));
    return idx === -1 ? "" : lines.slice(idx + 1).join("\n").trimEnd();
  });
  return "services:\n" + blocks.filter(Boolean).join("\n");
}

// Split multi-line CLI text into individual flat docker run commands. A
// single command with no blank-line separators still works: split() just
// returns the whole trimmed text as its one chunk.
export function splitRunCmds(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((chunk) => chunk.replace(/\\\n\s*/g, " ").trim())
    .filter((cmd) => cmd.startsWith("docker run"));
}

export function cliToCompose(text: string): string {
  const cmds = splitRunCmds(text);
  if (cmds.length === 0) throw new Error("未找到 docker run 命令");
  return mergeComposeYamls(cmds.map(runToCompose));
}

export function composeToCli(yaml: string): string {
  const cmds = composeToRuns(yaml);
  if (cmds.length === 0) throw new Error("未找到 services");
  return cmds.join("\n\n");
}

// How many services the current compose.yaml content describes — drives
// CreateContainerModal's single-vs-multi UI switch. Any parse error (mid-
// edit, invalid yaml) is treated as "1" rather than surfacing an error here;
// the editable panes already show their own conversion errors separately.
export function countComposeServices(yaml: string): number {
  try { return composeToRuns(yaml).length || 1; }
  catch { return 1; }
}
