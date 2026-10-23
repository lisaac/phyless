import { describe, expect, it, vi } from "vitest";
vi.mock("./client", () => ({
  get: vi.fn(async (u: string) => u),
  getToken: () => "t",
  request: vi.fn(async (_m: string, u: string, _b: unknown, _s: unknown, onHeaders: (h: Headers) => void) => {
    onHeaders(new Headers(u.includes("images") ? { "X-Phyless-Helper": "phyless-autoremove-browse-x", "X-Phyless-Helper-Life": "300" } : {}));
    return [u];
  }),
}));
import { fileSource, filesWindowUrl } from "./fileSources";

describe("fileSource", () => {
  it("builds per-kind endpoints", async () => {
    const own = await fileSource("container", "abc").listPath("/etc");
    expect([...own, own.helper]).toEqual(["/api/containers/abc/files?path=%2Fetc", undefined]);
    const boxed = await fileSource("image", "sha256:x").listPath("/");
    expect([...boxed, boxed.helper]).toEqual(["/api/images/files?id=sha256%3Ax&path=%2F", { name: "phyless-autoremove-browse-x", life: 300 }]);
    expect(fileSource("compose", "p").downloadUrl!("/a")).toBe("/api/compose/files/download?id=p&path=%2Fa&token=t");
    expect(fileSource("volume", "v").downloadUrl("/a")).toMatch(/^\/api\/volumes\/v\/files\/download\?path=%2Fa&token=/);
    expect(fileSource("image", "i").remove).toBeUndefined();
    expect(fileSource("container", "c").create).toBeUndefined();
    expect(filesWindowUrl({ kind: "volume", id: "a b", name: "a b" }, "/x")).toBe("/files/volume/a%20b?name=a+b&path=%2Fx");
  });
});
