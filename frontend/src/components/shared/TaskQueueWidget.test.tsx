import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";

vi.mock("@solidjs/router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../api/client", () => ({ getToken: () => "token", setToken: vi.fn() }));
vi.mock("../../stores/floatingStack", () => ({ useFloatingSlot: () => ({ setRef: vi.fn(), offset: () => 0 }) }));

class FakeXHR {
  static requests: FakeXHR[] = [];
  upload = {}; status = 200; responseText = "";
  onload?: () => void; onabort?: () => void;
  open = vi.fn(); setRequestHeader = vi.fn(); send = vi.fn();
  getResponseHeader() { return null; }
  abort = vi.fn(() => this.onabort?.());
  constructor() { FakeXHR.requests.push(this); }
  finish(text: string) { this.responseText = text; this.onload?.(); }
}

beforeEach(() => { FakeXHR.requests = []; vi.stubGlobal("XMLHttpRequest", FakeXHR); localStorage.clear(); vi.resetModules(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("TaskQueueWidget", () => {
  it("shows the latest 12 tasks, expands to all, and reveals layer detail", async () => {
    const q = await import("../../stores/taskQueue");
    const { TaskQueueWidget } = await import("./TaskQueueWidget");
    for (let i = 1; i <= 13; i++) q.enqueue({ title: `task ${i}`, url: `/t${i}` });
    FakeXHR.requests[0].finish('{"id":"layer1","status":"Downloading","progressDetail":{"current":5,"total":10}}\n');
    q.setPanelHidden(false);
    const view = render(() => <TaskQueueWidget />);
    expect(view.queryAllByText(/^task \d+$/)).toHaveLength(12);
    expect(view.queryByText("task 1")).toBeNull(); // oldest is hidden
    fireEvent.click(view.getByText("显示全部 (13)"));
    expect(view.queryAllByText(/^task \d+$/)).toHaveLength(13);
    expect(view.queryByText("layer1")).toBeNull();
    // A row expands on click; the ✕ button cancels/removes, so click the title.
    fireEvent.click(view.getByText("task 1"));
    expect(view.getByText("layer1")).toBeTruthy();
    expect(view.getByText("Downloading")).toBeTruthy();
  });

  it("shows complete request and per-image targets in expanded detail", async () => {
    const q = await import("../../stores/taskQueue");
    const { TaskQueueWidget } = await import("./TaskQueueWidget");
    q.enqueue({
      title: "删除 2 个镜像", url: "/api/images/delete", body: { ids: ["sha256:a", "sha256:b"] },
      meta: { type: "image-delete", images: ["nginx:latest · a", "redis:7 · b"], ids: ["sha256:a", "sha256:b"] },
    });
    q.enqueue({ title: "拉取 ghcr.io/acme/app:v2", url: "/api/images/pull", body: { image: "ghcr.io/acme/app:v2" }, meta: { type: "pull" } });
    q.setPanelHidden(false);
    const view = render(() => <TaskQueueWidget />);
    fireEvent.click(view.getByText("删除 2 个镜像"));
    expect(view.getByText("POST /api/images/delete")).toBeTruthy();
    expect(view.getByText("nginx:latest · a")).toBeTruthy();
    expect(view.getByText("redis:7 · b")).toBeTruthy();
    expect(view.getByText("sha256:a")).toBeTruthy();
    expect(view.getByText("sha256:b")).toBeTruthy();
    fireEvent.click(view.getByText("拉取 ghcr.io/acme/app:v2"));
    expect(view.getByText("ghcr.io/acme/app:v2")).toBeTruthy();
  });

  it("auto-hides 10 s after every task settled successfully, not after an error", async () => {
    vi.useFakeTimers();
    const q = await import("../../stores/taskQueue");
    const { TaskQueueWidget } = await import("./TaskQueueWidget");
    q.enqueue({ title: "one", url: "/1" });
    q.setPanelHidden(false);
    const view = render(() => <TaskQueueWidget />);
    FakeXHR.requests[0].finish("");
    vi.advanceTimersByTime(9_000);
    expect(view.getByText("one")).toBeTruthy();
    // 10 s auto-hide fires, then the drawer slide-out unmounts (ANIM_MS).
    vi.advanceTimersByTime(1_500);
    expect(view.queryByText("one")).toBeNull();
    q.enqueue({ title: "two", url: "/2" });
    q.setPanelHidden(false);
    FakeXHR.requests[1].finish('{"error":"denied"}\n');
    vi.advanceTimersByTime(20_000);
    expect(view.getByText("two")).toBeTruthy();
    vi.useRealTimers();
  });

  it("keeps the drawer closed when a new task is enqueued", async () => {
    const q = await import("../../stores/taskQueue");
    const { TaskQueueWidget } = await import("./TaskQueueWidget");
    q.enqueue({ title: "one", url: "/1" });
    const view = render(() => <TaskQueueWidget />);
    expect(view.queryByText("one")).toBeNull();
    q.setPanelHidden(false);
    expect(view.getByText("one")).toBeTruthy();
  });
});
