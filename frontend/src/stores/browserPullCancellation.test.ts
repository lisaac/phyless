import { afterEach, expect, it, vi } from "vitest";
import { runBrowserPull, runBrowserPullCompose, runBrowserUpgrade, runComposeUpdate, type BrowserPullCallbacks } from "./browserPull";
import { runUpdateCheck } from "./updateCheck";

afterEach(() => vi.unstubAllGlobals());

const pendingReadRunners: [string, (cb: BrowserPullCallbacks) => Promise<void>][] = [
  ["platform", (cb) => runBrowserPull({ ref: "nginx", platform: "", workerUrl: "https://w", token: "t" }, cb)],
  ["compose plan", (cb) => runBrowserPullCompose({ id: "p", mode: "up", workerUrl: "https://w", token: "t" }, cb)],
  ["compose update plan", (cb) => runComposeUpdate({ id: "p", canBuild: true, mode: "server", token: "t" }, cb)],
  ["upgrade inspect", (cb) => runBrowserUpgrade({ id: "c", workerUrl: "https://w", token: "t" }, cb)],
  ["update check inspect", (cb) => runUpdateCheck({ ids: ["c"], mode: "browser", workerUrl: "https://w" }, cb)],
];

it.each(pendingReadRunners)("cancels a task while waiting for %s", async (_name, run) => {
  const fetch = vi.fn((_url, init: RequestInit) => new Promise<Response>((_, reject) => {
    if (init.signal?.aborted) reject(new Error("cancelled"));
    else init.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  }));
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const pending = run({ signal: controller.signal, note: vi.fn() });
  expect(fetch).toHaveBeenCalledOnce();
  controller.abort();
  await expect(pending).rejects.toBeDefined();
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
});
