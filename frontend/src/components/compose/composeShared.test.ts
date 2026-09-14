import { describe, expect, it } from "vitest";
import { composeActionAvailability, composeProjectState, containersOf, servicesHaveBuild, VERB_LABEL, LABEL_CONFIG_FILES, LABEL_PROJECT } from "./composeShared";
import type { ComposeProject, ContainerSummary } from "../../types";

describe("Compose container matching", () => {
  const project: ComposeProject = {
    id: "1", name: "Display name", base_dir: "/stack",
    compose_file: "/stack/compose.yaml,/stack/override.yaml",
  };
  const containers = ["deployed", "other"].map((name) => ({
    Id: name, Labels: {
      [LABEL_PROJECT]: name,
      [LABEL_CONFIG_FILES]: "/stack/compose.yaml,/stack/override.yaml",
    },
  } as unknown as ContainerSummary));

  it("uses the resolved project name instead of the display name or shared files", () => {
    expect(containersOf({ ...project, project_name: "deployed" }, containers)).toEqual([containers[0]]);
  });

  it("supports multi-file responses without a resolved name", () => {
    expect(containersOf(project, containers)).toEqual(containers);
    expect(containersOf({ ...project, compose_file: "/stack/compose.yaml,/stack/different.yaml" }, containers)).toEqual([]);
    expect(containersOf({ ...project, compose_file: "" }, containers)).toEqual([]);
  });
});

describe("servicesHaveBuild", () => {
  it("is true only when some service declares build", () => {
    expect(servicesHaveBuild({ app: { build: { context: "." } }, db: { image: "pg" } })).toBe(true);
    expect(servicesHaveBuild({ app: { image: "busybox" } })).toBe(false);
    expect(servicesHaveBuild({})).toBe(false);
    expect(servicesHaveBuild(undefined)).toBe(false);
  });

  it("labels compose verbs", () => {
    expect(VERB_LABEL.build).toBe("Build");
    expect(VERB_LABEL.pause).toBe("Pause");
    expect(VERB_LABEL.pull).toBe("Pull/Build");
    expect(VERB_LABEL.update).toBe("Update");
  });
});

describe("Compose action availability", () => {
  it("only enables lifecycle actions that can change the project state", () => {
    expect(composeActionAvailability({ running: 2, total: 2 })).toEqual({ up: false, pause: true, restart: true, stop: true, down: true });
    expect(composeActionAvailability({ running: 0, total: 2 })).toEqual({ up: true, pause: false, restart: false, stop: false, down: true });
    expect(composeActionAvailability({ running: 1, total: 2 })).toEqual({ up: true, pause: true, restart: true, stop: true, down: true });
    expect(composeActionAvailability({ running: 0, total: 0 })).toEqual({ up: true, pause: false, restart: false, stop: false, down: false });
  });
});

describe("Compose project state", () => {
  it("distinguishes empty, stopped, partly running, and fully running projects", () => {
    expect(composeProjectState({ running: 0, total: 0 })).toBe("empty");
    expect(composeProjectState({ running: 0, total: 2 })).toBe("stopped");
    expect(composeProjectState({ running: 1, total: 2 })).toBe("partial");
    expect(composeProjectState({ running: 2, total: 2 })).toBe("running");
  });
});
