import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORKER_URL,
  validWorkerUrl,
  getWorkerUrl,
  getWorkerUrls,
  setWorkerUrl,
  saveWorkerUrl,
  removeWorkerUrl,
  getPullMode,
  setPullMode,
  getRememberedAccounts,
  rememberAccounts,
} from "./browserPullSettings";

beforeEach(() => localStorage.clear());

describe("validWorkerUrl", () => {
  it("accepts https URLs (with an optional path)", () => {
    expect(validWorkerUrl("https://w.example")).toBe("https://w.example");
    expect(validWorkerUrl("https://w.example/proxy")).toBe("https://w.example/proxy");
  });
  it("rejects http, credentials, query and fragment", () => {
    expect(validWorkerUrl("http://w.example")).toBe("");
    expect(validWorkerUrl("https://u:p@w.example")).toBe("");
    expect(validWorkerUrl("https://w.example?x=1")).toBe("");
    expect(validWorkerUrl("https://w.example#h")).toBe("");
  });
});

describe("worker url persistence", () => {
  it("stores valid urls and ignores invalid ones", () => {
    setWorkerUrl("https://w.example");
    expect(getWorkerUrl()).toBe("https://w.example");
    setWorkerUrl("http://bad");
    expect(getWorkerUrl()).toBe("https://w.example"); // unchanged
    setWorkerUrl("");
    expect(getWorkerUrl()).toBe(DEFAULT_WORKER_URL);
  });

  it("manages multiple saved worker urls", () => {
    expect(saveWorkerUrl("https://one.example")).toEqual(["https://one.example"]);
    expect(saveWorkerUrl("https://two.example")).toEqual(["https://two.example", "https://one.example"]);
    expect(saveWorkerUrl("https://one.example")).toEqual(["https://one.example", "https://two.example"]);
    rememberAccounts("https://one.example", { accounts: [{ id: "a1", host: "docker.io", username: "u", secret: "s" }], use: ["b:a1"] });
    expect(removeWorkerUrl("https://one.example")).toEqual(["https://two.example"]);
    expect(getWorkerUrls()).toEqual(["https://two.example"]);
    expect(getWorkerUrl()).toBe("https://two.example");
    expect(getRememberedAccounts("https://one.example")).toBeNull();
  });
});

describe("pull mode", () => {
  it("defaults to none, round-trips all modes, reads legacy proxy as none", () => {
    expect(getPullMode()).toBe("none");
    setPullMode("server");
    expect(getPullMode()).toBe("server");
    setPullMode("browser");
    expect(getPullMode()).toBe("browser");
    localStorage.setItem("phyless_pull_download_mode", "proxy");
    expect(getPullMode()).toBe("none");
  });
});

describe("remembered accounts", () => {
  const hub = { id: "a1", host: "docker.io", username: "hub-user", secret: "hub-secret" };
  const hub2 = { id: "a2", host: "docker.io", username: "second", secret: "s2" };
  const gh = { id: "a3", host: "ghcr.io", username: "gh-user", secret: "gh-secret" };
  it("round-trips several accounts per registry and the picks, per worker", () => {
    const one = "https://one.example";
    const two = "https://two.example";
    expect(getRememberedAccounts(one)).toBeNull();
    rememberAccounts(one, { accounts: [hub, hub2, gh], use: ["b:a2", "s:r9"] });
    rememberAccounts(two, { accounts: [gh], use: [] });
    expect(getRememberedAccounts(one)).toEqual({ accounts: [hub, hub2, gh], use: ["b:a2", "s:r9"] });
    expect(getRememberedAccounts(two)).toEqual({ accounts: [gh], use: [] });
    rememberAccounts(one, null);
    expect(getRememberedAccounts(one)).toBeNull();
    expect(getRememberedAccounts(two)).toEqual({ accounts: [gh], use: [] });
  });
  it("drops incomplete accounts, invalid hosts and keys, and normalizes Hub aliases", () => {
    rememberAccounts("https://one.example", {
      accounts: [{ ...hub, secret: "" }, { ...gh, host: "not a host" }, { ...hub2, host: "registry-1.docker.io" }],
      use: ["b:a2", "x:bad", "b:../x"],
    });
    expect(getRememberedAccounts("https://one.example")).toEqual({ accounts: [{ ...hub2, host: "docker.io" }], use: ["b:a2"] });
  });
  it("ignores the old per-host format", () => {
    localStorage.setItem("phyless_pull_registry_creds", JSON.stringify({ "https://one.example": { "docker.io": { username: "u", secret: "s" } } }));
    expect(getRememberedAccounts("https://one.example")).toBeNull();
  });
});

it("prefills the phyless Worker until this browser saves its own", () => {
  expect(DEFAULT_WORKER_URL).toBe("https://registry-proxy.phyless.com");
  expect(getWorkerUrl()).toBe(DEFAULT_WORKER_URL);
  expect(getWorkerUrls()).toEqual([]);
  saveWorkerUrl("https://mine.example");
  expect(getWorkerUrl()).toBe("https://mine.example");
});
