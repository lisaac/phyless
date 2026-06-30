import { describe, it, expect, vi, beforeEach } from "vitest";
import { currentUser, doLogin, doLogout, hasRole } from "./auth";
import * as client from "../api/client";

beforeEach(() => {
  localStorage.clear();
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
});
