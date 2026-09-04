import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { PullStatusWidget } from "./PullStatusWidget";
import { PullOptions, pullOptionsPayload, readPullProxyUrl, rememberPullProxyUrl } from "./PullOptions";

vi.mock("@solidjs/router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../api/client", () => ({ getToken: () => "token", get: vi.fn() }));
vi.mock("../../stores/floatingStack", () => ({ useFloatingSlot: () => ({ setRef: vi.fn(), offset: () => 0 }) }));

class FakeXHR {
  static requests: FakeXHR[] = [];
  upload = {};
  status = 200;
  responseText = "";
  onload?: () => void;
  onprogress?: () => void;
  onabort?: () => void;
  onerror?: () => void;
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn();
  abort = vi.fn(() => this.onabort?.());
  constructor() { FakeXHR.requests.push(this); }
  finish(text: string) { this.responseText = text; this.onload?.(); }
}

beforeEach(() => { FakeXHR.requests = []; vi.stubGlobal("XMLHttpRequest", FakeXHR); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("pull progress outcome", () => {
  it.each([
    '{"id":"layer","status":"Pull complete","errorDetail":{"message":"denied"}}',
    '{"error":"denied"}',
    '{"id":"layer","status":"done","errorDetail":{"code":403}}',
    "null", "invalid JSON",
  ])("does not report HTTP 200 errors as success: %s", (line) => {
    const done = vi.fn(), settled = vi.fn();
    const view = render(() => <PullStatusWidget active title="Pull" url="/pull" onClose={() => {}} onDone={done} onSettled={settled} />);
    FakeXHR.requests[0].finish(line);
    expect(done).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector(".bg-emerald-500")).toBeNull();
  });

  it("clears request options after success without replaying the POST", () => {
    const [body, setBody] = createSignal<unknown>({ proxy_url: "http://proxy:8080" });
    const done = vi.fn();
    render(() => <PullStatusWidget active title="Pull" url="/pull" body={body()} onClose={() => {}} onDone={done} onSettled={() => setBody(undefined)} />);
    FakeXHR.requests[0].finish('{"status":"done"}\n');
    expect(done).toHaveBeenCalledTimes(1);
    expect(body()).toBeUndefined();
    expect(FakeXHR.requests).toHaveLength(1);
  });

  it("treats cancellation as failure and settles once", () => {
    const done = vi.fn(), settled = vi.fn();
    const view = render(() => <PullStatusWidget active title="Pull" url="/pull" onClose={() => {}} onDone={done} onSettled={settled} />);
    FakeXHR.requests[0].abort();
    FakeXHR.requests[0].finish('{"status":"done"}');
    expect(done).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(view.getByText("已取消")).toBeTruthy();
  });

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
