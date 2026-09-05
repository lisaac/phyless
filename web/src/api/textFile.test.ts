import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTextFile } from "./textFile";
import { getToken, setToken } from "./client";

beforeEach(() => {
  setToken(null);
  vi.restoreAllMocks();
});

describe("fetchTextFile", () => {
  it("does not clear a newer token when an older request returns 401", async () => {
    setToken("old-token");
    const unauthorized = vi.fn();
    window.addEventListener("phyless:unauthorized", unauthorized);
    vi.stubGlobal("fetch", vi.fn(async () => {
      setToken("new-token");
      return new Response("", { status: 401 });
    }));
    await expect(fetchTextFile("/file")).resolves.toBeNull();
    expect(getToken()).toBe("new-token");
    expect(unauthorized).not.toHaveBeenCalled();
    window.removeEventListener("phyless:unauthorized", unauthorized);
  });
});
