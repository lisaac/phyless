import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { PullOptions, createPullOptions, pullOptionsPayload, readPullProxyUrl, rememberPullProxyUrl } from "./PullOptions";

vi.mock("../../api/client", () => ({ getToken: () => "token", get: vi.fn() }));

afterEach(() => { cleanup(); localStorage.clear(); });

describe("pull options", () => {
  it("builds only explicit request fields", () => {
    expect(pullOptionsPayload({ proxyUrl: " ", registryIds: [], platform: "" })).toEqual({});
    expect(pullOptionsPayload({ proxyUrl: " http://proxy:8080 ", registryIds: ["one"], platform: " linux/arm64 " })).toEqual({
      registry_ids: ["one"], platform: "linux/arm64",
    });
    expect(pullOptionsPayload({ useProxy: true, proxyUrl: " http://proxy:8080 " })).toEqual({ proxy_url: "http://proxy:8080" });
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

  it("remembers the proxy url but only sends it after opting in", () => {
    rememberPullProxyUrl("http://proxy.example:8080");
    const pull = createPullOptions();
    render(() => <PullOptions options={pull} />);
    const url = screen.getByPlaceholderText("http://host.docker.internal:7890") as HTMLInputElement;
    expect(url.value).toBe("http://proxy.example:8080");
    expect(url.disabled).toBe(true);
    expect(pull.payload()).toEqual({});

    fireEvent.click(screen.getByLabelText(/使用代理/));
    expect(url.disabled).toBe(false);
    expect(pull.payload()).toEqual({ proxy_url: "http://proxy.example:8080" });

    pull.reset();
    expect(pull.value.useProxy).toBe(false);
    expect(pull.value.proxyUrl).toBe("http://proxy.example:8080");
  });
});
