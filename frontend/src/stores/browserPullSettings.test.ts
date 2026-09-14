import { beforeEach, describe, expect, it } from "vitest";
import {
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
    expect(getWorkerUrl()).toBe("");
  });

  it("manages multiple saved worker urls", () => {
    expect(saveWorkerUrl("https://one.example")).toEqual(["https://one.example"]);
    expect(saveWorkerUrl("https://two.example")).toEqual(["https://two.example", "https://one.example"]);
    expect(saveWorkerUrl("https://one.example")).toEqual(["https://one.example", "https://two.example"]);
    rememberCreds("https://one.example", { username: "u", secret: "s" });
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
  it("round-trips separately for each worker and clears with its address", () => {
    const one = "https://one.example";
    const two = "https://two.example";
    expect(getRememberedCreds(one)).toBeNull();
    rememberCreds(one, { username: "one-user", secret: "one-secret" });
    rememberCreds(two, { username: "two-user", secret: "two-secret" });
    expect(getRememberedCreds(one)).toEqual({ username: "one-user", secret: "one-secret" });
    expect(getRememberedCreds(two)).toEqual({ username: "two-user", secret: "two-secret" });
    rememberCreds(one, null);
    expect(getRememberedCreds(one)).toBeNull();
    expect(getRememberedCreds(two)).toEqual({ username: "two-user", secret: "two-secret" });
  });
  it("does not store incomplete credentials", () => {
    rememberCreds("https://one.example", { username: "u", secret: "" });
    expect(getRememberedCreds("https://one.example")).toBeNull();
  });
  it("migrates a legacy credential to the current worker", () => {
    setWorkerUrl("https://one.example");
    localStorage.setItem("phyless_pull_registry_creds", JSON.stringify({ username: "u", secret: "s" }));
    expect(getRememberedCreds("https://one.example")).toEqual({ username: "u", secret: "s" });
    expect(localStorage.getItem("phyless_pull_registry_creds")).toContain("https://one.example");
  });
});
