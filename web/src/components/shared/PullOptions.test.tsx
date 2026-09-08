import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { PullOptions, pullOptionsPayload, readPullProxyUrl, rememberPullProxyUrl } from "./PullOptions";

vi.mock("../../api/client", () => ({ getToken: () => "token", get: vi.fn() }));

afterEach(() => { cleanup(); localStorage.clear(); });

describe("pull options", () => {
  it("builds only explicit request fields", () => {
    expect(pullOptionsPayload({ proxyUrl: " ", registryIds: [], platform: "" })).toEqual({});
    expect(pullOptionsPayload({ proxyUrl: " http://proxy:8080 ", registryIds: ["one"], platform: " linux/arm64 " })).toEqual({
      proxy_url: "http://proxy:8080", registry_ids: ["one"], platform: "linux/arm64",
    });
  });

  it("remembers a valid proxy endpoint without persisting credentials", () => {
    rememberPullProxyUrl(" http://proxy.example:8080 ");
    expect(readPullProxyUrl()).toBe("http://proxy.example:8080");

    rememberPullProxyUrl("http://user:secret@proxy.example:8080");
    expect(readPullProxyUrl()).toBe("http://proxy.example:8080");
    expect(localStorage.getItem("phyless_pull_proxy_url")).not.toContain("secret");

    rememberPullProxyUrl("socks5://proxy.example");
    expect(readPullProxyUrl()).toBe("http://proxy.example:8080");
  });

  it("clears the remembered proxy when the field is emptied", () => {
    rememberPullProxyUrl("http://proxy.example:8080");
    rememberPullProxyUrl(" ");
    expect(readPullProxyUrl()).toBe("");
  });

  it("loads the remembered proxy when a pull form opens", () => {
    rememberPullProxyUrl("http://proxy.example:8080");
    const onChange = vi.fn();
    render(() => <PullOptions proxyUrl="" onProxyUrlChange={onChange} />);
    expect(onChange).toHaveBeenCalledWith("http://proxy.example:8080");
  });
});
