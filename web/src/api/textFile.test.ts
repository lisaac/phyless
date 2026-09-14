import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTextFile } from "./textFile";
import { getToken, setToken } from "./client";
import { cancelDockerServerRequests } from "../stores/dockerServer";

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

  it("aborts a direct file read when the Docker server changes", async () => {
    const aborted = new Error("aborted");
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(aborted), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = fetchTextFile("/file");
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal;
    cancelDockerServerRequests();

    expect(signal?.aborted).toBe(true);
    await expect(pending).rejects.toBe(aborted);
  });
});
