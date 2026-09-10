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
    expect(removeWorkerUrl("https://one.example")).toEqual(["https://two.example"]);
    expect(getWorkerUrls()).toEqual(["https://two.example"]);
    expect(getWorkerUrl()).toBe("https://two.example");
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
  it("round-trips and clears", () => {
    expect(getRememberedCreds()).toBeNull();
    rememberCreds({ username: "u", secret: "s" });
    expect(getRememberedCreds()).toEqual({ username: "u", secret: "s" });
    rememberCreds(null);
    expect(getRememberedCreds()).toBeNull();
  });
  it("does not store incomplete credentials", () => {
    rememberCreds({ username: "u", secret: "" });
    expect(getRememberedCreds()).toBeNull();
  });
});
