import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import {
  PullOptions,
  createPullOptions,
  pullOptionsPayload,
  readPullProxyUrl,
  readPullProxyUrls,
  rememberPullProxyUrl,
  removePullProxyUrl,
  savePullProxyUrl,
} from "./PullOptions";

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

  it("manages multiple saved proxy urls", () => {
    expect(savePullProxyUrl("http://one.example:8080")).toEqual(["http://one.example:8080"]);
    expect(savePullProxyUrl("socks5://two.example:1080")).toEqual(["socks5://two.example:1080", "http://one.example:8080"]);
    expect(removePullProxyUrl("socks5://two.example:1080")).toEqual(["http://one.example:8080"]);
    expect(readPullProxyUrls()).toEqual(["http://one.example:8080"]);
  });

  it("saves on blur, deduplicates, and deletes from the dropdown", () => {
    const pull = createPullOptions();
    render(() => <PullOptions options={pull} />);
    fireEvent.click(screen.getByLabelText(/使用代理/));
    const input = screen.getByPlaceholderText("http://host.docker.internal:7890") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "http://proxy.example:8080" } });
    fireEvent.blur(input);
    fireEvent.input(input, { target: { value: "http://proxy.example:8080" } });
    fireEvent.blur(input);
    expect(readPullProxyUrls()).toEqual(["http://proxy.example:8080"]);

    fireEvent.focus(input);
    const remove = screen.getByRole("button", { name: "删除地址 http://proxy.example:8080" });
    fireEvent.click(remove);
    expect(readPullProxyUrls()).toEqual([]);
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
