import composerize from "composerize";
import decomposerize from "decomposerize";
import YAML from "yaml";

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

// Whitespace-splits a command line, treating a quoted segment as one token
// (decomposerize already quotes values containing spaces, e.g.
// `-e "FOO=hello world"`, so this must not split inside the quotes).
function tokenizeCmd(cmd: string): string[] {
  const re = /"[^"]*"|'[^']*'|\S+/g;
  return cmd.match(re) ?? [];
}

// decomposerize (and composerize's --network path) have no "one flag per
// line" option, and we were asked not to patch the library itself — this is
// the wrapper instead. Reformats decomposerize's single-line output into the
// same multi-line, backslash-continued style inspectToRunCmd already uses
// (api/inspect.ts), purely for readability. Not a full docker-CLI parser:
// it doesn't know which flags take a value, so it uses the one heuristic
// that's actually reliable here — `docker run [OPTIONS] IMAGE [CMD...]`
// means every flag (a token starting with "-") pairs with the next token
// UNLESS that next token is itself a flag, and once the first non-flag
// token (the image) appears, everything after it is positional and gets
// its own line without further flag-parsing (so `sh -c "..."` after the
// image doesn't get mistaken for more docker options).
export function formatRunCmdMultiline(cmd: string): string {
  const tokens = tokenizeCmd(cmd.trim());
  if (tokens.length < 2 || tokens[0] !== "docker" || tokens[1] !== "run") return cmd;
  const lines: string[] = ["docker run"];
  let i = 2;
  let pastFlags = false;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!pastFlags && tok.startsWith("-")) {
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
        lines.push(`${tok} ${tokens[i + 1]}`);
        i += 2;
      } else {
        lines.push(tok);
        i += 1;
      }
    } else {
      pastFlags = true;
      lines.push(tok);
      i += 1;
    }
  }
  return lines.join(" \\\n  ");
}

// ── Multi-command aware conversion — used by RunComposeEditor to handle
// either one service or many, detected live from the content ───────────────

// Merges each service's individually-composerized yaml into one document.
// Previously this just string-sliced out each yaml's "services:" section and
// discarded everything else — silently dropping composerize's own top-level
// networks:/volumes: blocks. That mattered specifically for named networks:
// composerize already marks any named (non-default) --network as
// `external: true` + `name:` by default (it has no way to know whether the
// network is meant to be created fresh or already exists, so it conserva-
// tively assumes external and leaves a comment explaining how to change
// that) — the merge was throwing that away, so `docker compose` ended up
// trying to create a brand new project-namespaced network instead of
// joining the real one. Parsing for real instead of slicing text preserves it.
export function mergeComposeYamls(yamls: string[]): string {
  const services: Record<string, unknown> = {};
  const networks: Record<string, unknown> = {};
  const volumes: Record<string, unknown> = {};
  for (const yaml of yamls) {
    let doc: Record<string, unknown>;
    try { doc = YAML.parse(yaml) ?? {}; } catch { continue; }
    Object.assign(services, doc.services as Record<string, unknown> | undefined);
    Object.assign(networks, doc.networks as Record<string, unknown> | undefined);
    Object.assign(volumes, doc.volumes as Record<string, unknown> | undefined);
  }
  const out: Record<string, unknown> = { services };
  if (Object.keys(networks).length > 0) out.networks = networks;
  if (Object.keys(volumes).length > 0) out.volumes = volumes;
  return YAML.stringify(out);
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
  // Multi-line per command for readability. splitRunCmds (the reverse
  // direction) already un-wraps "\\\n"-continued lines back to one line per
  // command before re-parsing, so this round-trips cleanly.
  return cmds.map(formatRunCmdMultiline).join("\n\n");
}

// How many services the current compose.yaml content describes — drives
// CreateContainerModal's single-vs-multi UI switch. Any parse error (mid-
// edit, invalid yaml) is treated as "1" rather than surfacing an error here;
// the editable panes already show their own conversion errors separately.
export function countComposeServices(yaml: string): number {
  try { return composeToRuns(yaml).length || 1; }
  catch { return 1; }
}
