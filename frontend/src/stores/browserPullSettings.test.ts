import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORKER_URL,
  validWorkerUrl,
  getWorkerUrl,
  getWorkerUrls,
  setWorkerUrl,
  saveWorkerUrl,
  removeWorkerUrl,
  getDownloadMode,
  setDownloadMode,
  getRememberedCreds,
  rememberCreds,
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
    rememberCreds("https://one.example", { "docker.io": { username: "u", secret: "s" } });
    expect(removeWorkerUrl("https://one.example")).toEqual(["https://two.example"]);
    expect(getWorkerUrls()).toEqual(["https://two.example"]);
    expect(getWorkerUrl()).toBe("https://two.example");
    expect(getRememberedCreds("https://one.example")).toBeNull();
  });
});

describe("download mode", () => {
  it("defaults to proxy and round-trips browser", () => {
    expect(getDownloadMode()).toBe("proxy");
    setDownloadMode("browser");
    expect(getDownloadMode()).toBe("browser");
    setDownloadMode("proxy");
    expect(getDownloadMode()).toBe("proxy");
  });
});

describe("remembered credentials", () => {
  it("round-trips per worker and per registry host, and clears with its address", () => {
    const one = "https://one.example";
    const two = "https://two.example";
    expect(getRememberedCreds(one)).toBeNull();
    rememberCreds(one, { "docker.io": { username: "hub-user", secret: "hub-secret" }, "ghcr.io": { username: "gh-user", secret: "gh-secret" } });
    rememberCreds(two, { "registry.example:5000": { username: "two-user", secret: "two-secret" } });
    expect(getRememberedCreds(one)).toEqual({ "docker.io": { username: "hub-user", secret: "hub-secret" }, "ghcr.io": { username: "gh-user", secret: "gh-secret" } });
    expect(getRememberedCreds(two)).toEqual({ "registry.example:5000": { username: "two-user", secret: "two-secret" } });
    rememberCreds(one, null);
    expect(getRememberedCreds(one)).toBeNull();
    expect(getRememberedCreds(two)).toEqual({ "registry.example:5000": { username: "two-user", secret: "two-secret" } });
  });
  it("does not store incomplete credentials or invalid hosts, and normalizes Hub aliases", () => {
    rememberCreds("https://one.example", { "docker.io": { username: "u", secret: "" }, "not a host": { username: "u", secret: "s" } });
    expect(getRememberedCreds("https://one.example")).toBeNull();
    rememberCreds("https://one.example", { "registry-1.docker.io": { username: "u", secret: "s" } });
    expect(getRememberedCreds("https://one.example")).toEqual({ "docker.io": { username: "u", secret: "s" } });
  });
  it("migrates legacy single-account credentials to Docker Hub", () => {
    setWorkerUrl("https://one.example");
    localStorage.setItem("phyless_pull_registry_creds", JSON.stringify({ username: "u", secret: "s" }));
    expect(getRememberedCreds("https://one.example")).toEqual({ "docker.io": { username: "u", secret: "s" } });
    expect(localStorage.getItem("phyless_pull_registry_creds")).toContain("https://one.example");
    localStorage.setItem("phyless_pull_registry_creds", JSON.stringify({ "https://two.example": { username: "u2", secret: "s2" } }));
    expect(getRememberedCreds("https://two.example")).toEqual({ "docker.io": { username: "u2", secret: "s2" } });
  });
});

it("prefills the phyless Worker until this browser saves its own", () => {
  expect(DEFAULT_WORKER_URL).toBe("https://registry-proxy.phyless.com");
  expect(getWorkerUrl()).toBe(DEFAULT_WORKER_URL);
  expect(getWorkerUrls()).toEqual([]);
  saveWorkerUrl("https://mine.example");
  expect(getWorkerUrl()).toBe("https://mine.example");
});
