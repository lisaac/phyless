import { describe, expect, it, vi } from "vitest";
vi.mock("./client", () => ({ get: vi.fn(async (u: string) => u), getToken: () => "t" }));
import { fileSource, filesWindowUrl } from "./fileSources";

describe("fileSource", () => {
  it("builds per-kind endpoints", async () => {
    expect(await fileSource("container", "abc").listPath("/etc")).toBe("/api/containers/abc/files?path=%2Fetc");
    expect(await fileSource("image", "sha256:x").listPath("/")).toBe("/api/images/files?id=sha256%3Ax&path=%2F");
    expect(fileSource("compose", "p").downloadUrl!("/a")).toBe("/api/compose/files/download?id=p&path=%2Fa&token=t");
    expect(fileSource("volume", "v").downloadUrl).toBeUndefined();
    expect(fileSource("image", "i").remove).toBeUndefined();
    expect(fileSource("container", "c").create).toBeUndefined();
    expect(filesWindowUrl({ kind: "volume", id: "a b", name: "a b" }, "/x")).toBe("/files/volume/a%20b?name=a+b&path=%2Fx");
  });
});
