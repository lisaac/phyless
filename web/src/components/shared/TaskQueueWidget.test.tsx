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
  it("shows the latest 5 tasks, expands to all, and reveals layer detail", async () => {
    const q = await import("../../stores/taskQueue");
    const { TaskQueueWidget } = await import("./TaskQueueWidget");
    for (let i = 1; i <= 6; i++) q.enqueue({ title: `task ${i}`, url: `/t${i}` });
    FakeXHR.requests[0].finish('{"id":"layer1","status":"Downloading","progressDetail":{"current":5,"total":10}}\n');
    const view = render(() => <TaskQueueWidget />);
    expect(view.queryAllByText(/^task \d$/)).toHaveLength(5);
    expect(view.queryByText("task 1")).toBeNull(); // oldest is hidden
    fireEvent.click(view.getByText("显示全部 (6)"));
    expect(view.queryAllByText(/^task \d$/)).toHaveLength(6);
    expect(view.queryByText("layer1")).toBeNull();
    const row = view.getByText("task 1").parentElement!;
    fireEvent.click(row.querySelector("button")!);
    expect(view.getByText("layer1")).toBeTruthy();
    expect(view.getByText("Downloading")).toBeTruthy();
  });

  it("auto-hides 10 s after every task settled successfully, not after an error", async () => {
    vi.useFakeTimers();
    const q = await import("../../stores/taskQueue");
    const { TaskQueueWidget } = await import("./TaskQueueWidget");
    q.enqueue({ title: "one", url: "/1" });
    const view = render(() => <TaskQueueWidget />);
    FakeXHR.requests[0].finish("");
    vi.advanceTimersByTime(9_000);
    expect(view.getByText("one")).toBeTruthy();
    vi.advanceTimersByTime(1_000);
    expect(view.queryByText("one")).toBeNull();
    q.enqueue({ title: "two", url: "/2" });
    FakeXHR.requests[1].finish('{"error":"denied"}\n');
    vi.advanceTimersByTime(20_000);
    expect(view.getByText("two")).toBeTruthy();
    vi.useRealTimers();
  });

  it("hides on 隐藏 and comes back when a new task is enqueued", async () => {
    const q = await import("../../stores/taskQueue");
    const { TaskQueueWidget } = await import("./TaskQueueWidget");
    q.enqueue({ title: "one", url: "/1" });
    const view = render(() => <TaskQueueWidget />);
    fireEvent.click(view.getByTitle("隐藏"));
    expect(view.queryByText("one")).toBeNull();
    q.enqueue({ title: "two", url: "/2" });
    expect(view.getByText("two")).toBeTruthy();
  });
});
