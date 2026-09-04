import { describe, expect, it } from "vitest";
import { containersOf, LABEL_CONFIG_FILES, LABEL_PROJECT } from "./composeShared";
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
  } as ContainerSummary));

  it("uses the resolved project name instead of the display name or shared files", () => {
    expect(containersOf({ ...project, project_name: "deployed" }, containers)).toEqual([containers[0]]);
  });

  it("supports multi-file responses without a resolved name", () => {
    expect(containersOf(project, containers)).toEqual(containers);
    expect(containersOf({ ...project, compose_file: "/stack/compose.yaml,/stack/different.yaml" }, containers)).toEqual([]);
    expect(containersOf({ ...project, compose_file: "" }, containers)).toEqual([]);
  });
});
