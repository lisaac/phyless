import { describe, expect, it, vi } from "vitest";
import { runComposeUpdate, type ComposeUpdateDeps, type ComposePullPlan } from "./browserPull";

function deps(plan: ComposePullPlan, over: Partial<ComposeUpdateDeps> = {}): ComposeUpdateDeps {
  return {
    fetchPlan: vi.fn(async () => plan),
    runBrowserPull: vi.fn(async () => {}),
    streamCompose: vi.fn(async () => {}),
    ...over,
  };
}
const cb = () => ({ note: vi.fn(), progress: vi.fn(), signal: new AbortController().signal });
const verbs = (sc: ReturnType<typeof vi.fn>) => sc.mock.calls.map((c) => c[0]);

describe("runComposeUpdate", () => {
  it("server mode runs build→pull→down→up(never) in order", async () => {
    const d = deps({ images: [], rejected: [] });
    await runComposeUpdate({ id: "1", mode: "server", canBuild: true, token: "t", pullOptions: { proxy_url: "http://p" } }, cb(), d);
    const sc = d.streamCompose as ReturnType<typeof vi.fn>;
    expect(verbs(sc)).toEqual(["build", "pull", "down", "up"]);
    expect(sc.mock.calls[0][2]).toMatchObject({ body: { proxy_url: "http://p" } }); // build carries proxy opts
    expect(sc.mock.calls[1][2]).toMatchObject({ body: { proxy_url: "http://p" } }); // pull carries proxy opts
    expect(sc.mock.calls[3][2]).toMatchObject({ body: { pull_policy: "never" } }); // up forces never
    expect(d.runBrowserPull).not.toHaveBeenCalled();
    expect(d.fetchPlan).not.toHaveBeenCalled();
  });

  it("skips build when canBuild is false", async () => {
    const d = deps({ images: [], rejected: [] });
    await runComposeUpdate({ id: "1", mode: "server", canBuild: false, token: "t" }, cb(), d);
    expect(verbs(d.streamCompose as ReturnType<typeof vi.fn>)).toEqual(["pull", "down", "up"]);
  });

  it("stops after a failed build — never reaches down/up", async () => {
    const streamCompose = vi.fn(async (verb: string) => { if (verb === "build") throw new Error("build boom"); });
    const d = deps({ images: [], rejected: [] }, { streamCompose });
    await expect(runComposeUpdate({ id: "1", mode: "server", canBuild: true, token: "t" }, cb(), d)).rejects.toThrow(/build boom/);
    expect(verbs(streamCompose)).toEqual(["build"]);
  });

  it("browser mode: build server-side, preload pull images, then down→up(never)", async () => {
    const d = deps({
      images: [{ service: "web", ref: "nginx:1" }],
      build_bases: [{ service: "api", ref: "alpine:3.20" }],
      rejected: [{ service: "api", ref: "", reason: "build" }],
    });
    await runComposeUpdate({ id: "1", mode: "browser", canBuild: true, workerUrl: "https://w", token: "tok" }, cb(), d);
    const sc = d.streamCompose as ReturnType<typeof vi.fn>;
    expect(verbs(sc)).toEqual(["build", "down", "up"]); // no server pull in browser mode
    expect(sc.mock.calls[0][2].body).toBeUndefined(); // browser mode build has no server proxy payload
    expect(d.runBrowserPull).toHaveBeenCalledTimes(2); // base before build + service image
    expect((d.runBrowserPull as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ ref: "alpine:3.20", workerUrl: "https://w" });
    expect((d.runBrowserPull as ReturnType<typeof vi.fn>).mock.calls[1][0]).toMatchObject({ ref: "nginx:1", workerUrl: "https://w" });
  });

  it("browser mode: digest-rejected service aborts before any pull", async () => {
    const d = deps({ images: [{ service: "web", ref: "nginx:1" }], rejected: [{ service: "db", ref: "x@sha256:...", reason: "digest" }] });
    await expect(runComposeUpdate({ id: "1", mode: "browser", canBuild: false, workerUrl: "https://w", token: "t" }, cb(), d)).rejects.toThrow(/无法用浏览器下载/);
    expect(d.runBrowserPull).not.toHaveBeenCalled();
    expect(d.streamCompose).not.toHaveBeenCalled();
  });
});
