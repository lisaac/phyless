import { describe, it, expect, vi, beforeEach } from "vitest";
import { currentUser, doLogin, doLogout, hasRole, loadSession } from "./auth";
import * as queue from "./taskQueue";
import * as client from "../api/client";

beforeEach(() => {
  localStorage.clear();
  doLogout();
  vi.restoreAllMocks();
});

describe("auth store", () => {
  it("doLogin sets currentUser from /api/auth/me", async () => {
    vi.spyOn(client, "login").mockResolvedValue("tok");
    vi.spyOn(client, "get").mockResolvedValue({ id: "1", username: "admin", role: "admin" });
    await doLogin("admin", "admin");
    expect(currentUser()?.username).toBe("admin");
  });

  it("hasRole compares role levels", async () => {
    vi.spyOn(client, "login").mockResolvedValue("tok");
    vi.spyOn(client, "get").mockResolvedValue({ id: "1", username: "op", role: "operator" });
    await doLogin("op", "x");
    expect(hasRole("viewer")).toBe(true);
    expect(hasRole("operator")).toBe(true);
    expect(hasRole("admin")).toBe(false);
  });

  it("doLogout clears currentUser", async () => {
    vi.spyOn(client, "login").mockResolvedValue("tok");
    vi.spyOn(client, "get").mockResolvedValue({ id: "1", username: "admin", role: "admin" });
    await doLogin("admin", "admin");
    doLogout();
    expect(currentUser()).toBeNull();
  });

  it("keeps the token when session loading gets a transient error", async () => {
    setTokenForTest("session-token");
    vi.spyOn(client, "get").mockRejectedValue(new client.ApiError(503, "unavailable"));
    await loadSession();
    expect(localStorage.getItem("phyless_token")).toBe("session-token");
  });
});

function setTokenForTest(token: string): void {
  localStorage.setItem("phyless_token", token);
}


it("cancels pending reads and writes when logging out", () => {
  const reads = vi.spyOn(client, "cancelPendingReads");
  const writes = vi.spyOn(queue, "cancelActiveTasks");
  doLogout();
  expect(reads).toHaveBeenCalledOnce();
  expect(writes).toHaveBeenCalledOnce();
});

it("does not restore a logged-out session from a late profile response", async () => {
  setTokenForTest("old");
  let finish!: (user: unknown) => void;
  vi.spyOn(client, "get").mockImplementation(() => new Promise((resolve) => { finish = resolve; }) as never);
  const pending = loadSession();
  doLogout();
  finish({ id: "old", username: "old", role: "admin" });
  await pending;
  expect(currentUser()).toBeNull();
});

it("rejects a late login profile after logout", async () => {
  vi.spyOn(client, "login").mockResolvedValue("tok");
  let finish!: (user: unknown) => void;
  vi.spyOn(client, "get").mockImplementation(() => new Promise((resolve) => { finish = resolve; }) as never);
  const pending = doLogin("admin", "password");
  await Promise.resolve();
  doLogout();
  finish({ id: "old", username: "old", role: "admin" });
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(currentUser()).toBeNull();
});
