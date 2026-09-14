import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { App } from "./App";
import { dockerServerChanged } from "./stores/dockerServer";

const routeMock = vi.hoisted(() => ({ suspendContainer: false, layoutMounts: 0, overviewMounts: 0 }));

vi.mock("./stores/auth", () => ({
  currentUser: () => ({ id: "1", username: "admin", role: "admin" }),
  doLogout: vi.fn(),
  loadSession: () => Promise.resolve(),
}));
vi.mock("./components/shared/Layout", () => ({ Layout: (props: { children?: any }) => <div data-testid="layout" data-mount={++routeMock.layoutMounts}>{props.children}</div> }));
vi.mock("./components/shared/Toast", () => ({ ToastHost: () => null }));
vi.mock("./components/shared/ConfirmModal", () => ({ ConfirmModal: () => null }));
vi.mock("./components/overview/OverviewPage", () => ({ OverviewPage: () => <div data-mount={++routeMock.overviewMounts}>overview-page</div> }));
vi.mock("./components/containers/ContainerDetailPage", async () => {
  const { createResource } = await import("solid-js");
  return {
    ContainerDetailPage: () => {
      const [loaded] = createResource(() => routeMock.suspendContainer ? new Promise<true>(() => {}) : Promise.resolve(true));
      return <div>{loaded() && "container-detail-page"}</div>;
    },
  };
});
vi.mock("./components/containers/TerminalWindowPage", () => ({ TerminalWindowPage: () => <div>terminal-page</div> }));

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  routeMock.layoutMounts = 0;
  routeMock.overviewMounts = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  routeMock.suspendContainer = false;
  window.history.replaceState(null, "", "/");
});

describe("route fallback", () => {
  it.each(["/missing/path", "/images/missing"])("redirects unmatched URL %s to the home page", async (path) => {
    window.history.replaceState(null, "", path);
    render(() => <App />);

    await screen.findByText("overview-page");
    expect(window.location.pathname).toBe("/overview");
  });

  it("keeps the layout while a protected page is loading", async () => {
    routeMock.suspendContainer = true;
    window.history.replaceState(null, "", "/containers/abc");
    render(() => <App />);

    await screen.findByText("加载中…");
    expect(screen.getByTestId("layout")).toBeTruthy();
  });

  it.each([
    ["/containers/abc", "container-detail-page"],
    ["/terminal/abc", "terminal-page"],
  ])("does not catch valid route %s", async (path, page) => {
    window.history.replaceState(null, "", path);
    render(() => <App />);

    await screen.findByText(page);
    expect(window.location.pathname).toBe(path);
  });

  it("recreates Docker-backed views after a server switch", async () => {
    render(() => <App />);
    await screen.findByText("overview-page");
    const layoutBefore = routeMock.layoutMounts;
    const overviewBefore = routeMock.overviewMounts;
    dockerServerChanged();
    expect(routeMock.layoutMounts).toBe(layoutBefore + 1);
    expect(routeMock.overviewMounts).toBe(overviewBefore + 1);
  });
});
