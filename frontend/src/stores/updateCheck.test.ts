import { describe, expect, it, vi } from "vitest";
import { runUpdateCheck, updateCheckFor, isUpgradable, type UpdateCheckDeps } from "./updateCheck";

const cb = () => ({ note: vi.fn(), progress: vi.fn(), signal: new AbortController().signal });

const containers: Record<string, { Image: string; Config: { Image: string } }> = {
  a: { Image: "sha256:new", Config: { Image: "nginx:latest" } },
  b: { Image: "sha256:old", Config: { Image: "nginx:latest" } },
  c: { Image: "sha256:x", Config: { Image: "redis:7" } },
  d: { Image: "sha256:p", Config: { Image: "sha256:p" } },
};
const images: Record<string, { Id: string; Os: string; Architecture: string }> = {
  "sha256:new": { Id: "sha256:new", Os: "linux", Architecture: "amd64" },
  "sha256:old": { Id: "sha256:old", Os: "linux", Architecture: "amd64" },
  "sha256:x": { Id: "sha256:x", Os: "linux", Architecture: "amd64" },
  "nginx:latest": { Id: "sha256:new", Os: "linux", Architecture: "amd64" },
  "redis:7": { Id: "sha256:x", Os: "linux", Architecture: "amd64" },
};

function deps(): UpdateCheckDeps {
  return {
    post: vi.fn(async () => []),
    inspectContainer: vi.fn(async (id: string) => ({ Id: id, ...containers[id] })),
    inspectImage: vi.fn(async (ref: string) => images[ref] ?? null),
    resolve: vi.fn(async (ref: string) => ref === "redis:7" ? { config: "sha256:r2", manifest: "sha256:m" } : { config: "sha256:new", manifest: "sha256:m" }),
  };
}

describe("runUpdateCheck (browser)", () => {
  it("classifies containers and resolves each ref/platform once", async () => {
    const d = deps();
    await runUpdateCheck({ ids: ["a", "b", "c", "d"], mode: "browser", workerUrl: "https://w" }, cb(), d);
    expect(updateCheckFor("a", "sha256:new")?.status).toBe("latest");
    expect(updateCheckFor("b", "sha256:old")?.status).toBe("local-newer");
    expect(updateCheckFor("c", "sha256:x")?.status).toBe("update");
    expect(updateCheckFor("d")?.status).toBe("unsupported");
    expect(d.resolve).toHaveBeenCalledTimes(2);
    // A result stops applying once the container runs another image.
    expect(updateCheckFor("c", "sha256:r2")).toBeUndefined();
    expect(isUpgradable(updateCheckFor("c", "sha256:x"))).toBe(true);
  });

  it("server mode posts ids with the pull options", async () => {
    const d = deps();
    await runUpdateCheck({ ids: ["a"], mode: "server", pullOptions: { proxy_url: "http://p:1" } }, cb(), d);
    expect(d.post).toHaveBeenCalledWith({ ids: ["a"], proxy_url: "http://p:1" });
  });
});
