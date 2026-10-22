import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { Layout } from "./Layout";

vi.mock("@solidjs/router", () => ({
  useLocation: () => ({ pathname: "/overview" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("./Sidebar", () => ({ Sidebar: () => null }));
vi.mock("./TaskQueueWidget", () => ({ TaskQueueWidget: () => null }));
vi.mock("../../stores/tabs", () => ({
  tabs: () => [], openOrActivate: vi.fn(), leftNeighbor: vi.fn(),
  removeTab: vi.fn(), labelFor: () => "总览", markSeen: () => true,
  tabSearch: () => "", setTabSearch: vi.fn(),
}));
vi.mock("../../stores/taskQueue", () => ({
  tasks: { list: [] }, panelHidden: () => true, setPanelHidden: vi.fn(), runningCount: () => 0,
  unseenFailureCount: () => 0, showTaskPanel: vi.fn(),
  ENQUEUED_EVENT: "phyless:task-enqueued",
}));
vi.mock("../../stores/refresh", () => ({
  autoRefresh: () => true, refreshSeconds: () => 5, setAutoRefresh: vi.fn(),
  setRefreshSeconds: vi.fn(), refreshAll: vi.fn(),
}));
import { setAutoRefresh, setRefreshSeconds } from "../../stores/refresh";

afterEach(cleanup);

describe("Layout refresh settings", () => {
  it("closes when clicking outside", () => {
    render(() => <Layout><button>页面内容</button></Layout>);
    const details = screen.getByLabelText("刷新设置").closest("details")!;
    details.open = true;

    fireEvent.pointerDown(screen.getByText("自动刷新"));
    expect(details.open).toBe(true);

    fireEvent.pointerDown(screen.getByText("页面内容"));
    expect(details.open).toBe(false);
  });

  it("edits auto-refresh from the split button's popover", () => {
    render(() => <Layout><button>页面内容</button></Layout>);
    expect(screen.getByLabelText("刷新设置").getAttribute("title")).toContain("每 5 秒");
    fireEvent.click(screen.getByRole("switch", { name: "自动刷新" }));
    expect(setAutoRefresh).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "30s" }));
    expect(setRefreshSeconds).toHaveBeenCalledWith(30);
  });

  it("flies a newly queued task from the last pointer position to the task button", () => {
    render(() => <Layout><button>页面内容</button></Layout>);
    fireEvent.pointerDown(document, { clientX: 24, clientY: 48 });
    window.dispatchEvent(new CustomEvent("phyless:task-enqueued", { detail: { id: "t1" } }));

    const flight = document.querySelector(".task-launch-flight")!;
    expect(flight).toBeTruthy();
    fireEvent.animationEnd(flight);
    expect(document.querySelector(".task-launch-flight")).toBeNull();
  });
});
