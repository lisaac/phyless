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
}));
vi.mock("../../stores/taskQueue", () => ({
  tasks: { list: [] }, panelHidden: () => true, setPanelHidden: vi.fn(), isActive: () => false,
}));
vi.mock("../../stores/refresh", () => ({
  autoRefresh: () => true, refreshSeconds: () => 5, setAutoRefresh: vi.fn(),
  setRefreshSeconds: vi.fn(), refreshAll: vi.fn(),
}));
vi.mock("../../stores/theme", () => ({ theme: () => "dark", toggleTheme: vi.fn() }));

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
});
