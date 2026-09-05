import { describe, expect, it } from "vitest";
import { canSaveFile, createLatestFileRequest } from "./latestFile";

describe("createLatestFileRequest", () => {
  it("invalidates an older same-path request when the project changes", () => {
    const guard = createLatestFileRequest();
    const first = guard.begin({ id: "project-a", path: "/compose.yaml" });
    const second = guard.begin({ id: "project-b", path: "/compose.yaml" });
    expect(first.signal.aborted).toBe(true);
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it("invalidates a pending request when the editor is disposed", () => {
    const guard = createLatestFileRequest();
    const request = guard.begin({ id: "project", path: "/compose.yaml" });
    guard.cancel();
    expect(request.signal.aborted).toBe(true);
    expect(guard.isCurrent(request)).toBe(false);
  });

  it("does not allow saving while loading or after the target changes", () => {
    const loaded = { id: "project-a", path: "/compose.yaml" };
    expect(canSaveFile(loaded, loaded, true, "", false)).toBe(false);
    expect(canSaveFile(loaded, { id: "project-b", path: "/compose.yaml" }, false, "", false)).toBe(false);
    expect(canSaveFile(loaded, loaded, false, "", false)).toBe(true);
  });
});
