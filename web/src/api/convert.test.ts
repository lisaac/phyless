import { describe, it, expect } from "vitest";
import { runToCompose, composeToRun, composeToRuns, mergeComposeYamls, formatRunCmdMultiline, composeToCli, cliToCompose } from "./convert";

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

describe("mergeComposeYamls", () => {
  it("preserves the external network marking composerize already adds for named networks", () => {
    // composerize marks any named --network external by default (it can't
    // know whether the network is meant to be created fresh) — the old
    // string-slicing merge discarded this top-level networks: block
    // entirely, which is the bug this fix addresses.
    const runs = [
      "docker run -d --name a --network pod_default nginx",
      "docker run -d --name b --network pod_default redis",
    ];
    const merged = mergeComposeYamls(runs.map(runToCompose));
    expect(merged).toContain("external: true");
    expect(merged).toContain("name: pod_default");
  });

  it("keeps both services in the merged services block", () => {
    const runs = ["docker run -d --name a nginx", "docker run -d --name b redis"];
    const merged = mergeComposeYamls(runs.map(runToCompose));
    expect(merged).toContain("nginx");
    expect(merged).toContain("redis");
  });
});

describe("formatRunCmdMultiline", () => {
  it("puts each flag (and its value) on its own backslash-continued line", () => {
    const out = formatRunCmdMultiline('docker run --name web -p 8080:80 -e "FOO=hello world" nginx');
    expect(out).toBe('docker run \\\n  --name web \\\n  -p 8080:80 \\\n  -e "FOO=hello world" \\\n  nginx');
  });

  it("does not flag-parse past the image (entrypoint/cmd args stay their own lines)", () => {
    const out = formatRunCmdMultiline("docker run --name web nginx sh -c echo hi");
    expect(out).toBe("docker run \\\n  --name web \\\n  nginx \\\n  sh \\\n  -c \\\n  echo \\\n  hi");
  });

  it("leaves non-docker-run input untouched", () => {
    expect(formatRunCmdMultiline("echo hello")).toBe("echo hello");
  });
});

describe("composeToCli / cliToCompose round-trip with multiline formatting", () => {
  it("composeToCli formats each command as multiline", () => {
    const yaml = `services:\n  web:\n    image: nginx\n    ports:\n      - "8080:80"\n`;
    const cli = composeToCli(yaml);
    expect(cli).toContain(" \\\n  ");
  });

  it("cliToCompose still parses the multiline output composeToCli produces", () => {
    const yaml = `services:\n  a:\n    image: nginx\n  b:\n    image: redis\n`;
    const cli = composeToCli(yaml);
    const back = cliToCompose(cli);
    expect(back).toContain("nginx");
    expect(back).toContain("redis");
  });
});
