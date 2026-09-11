import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { App } from "./App";

const routeMock = vi.hoisted(() => ({ suspendContainer: false }));

vi.mock("./stores/auth", () => ({
  currentUser: () => ({ id: "1", username: "admin", role: "admin" }),
  doLogout: vi.fn(),
  loadSession: () => Promise.resolve(),
}));
vi.mock("./components/shared/Layout", () => ({ Layout: (props: { children?: any }) => <div data-testid="layout">{props.children}</div> }));
vi.mock("./components/shared/Toast", () => ({ ToastHost: () => null }));
vi.mock("./components/shared/ConfirmModal", () => ({ ConfirmModal: () => null }));
vi.mock("./components/overview/OverviewPage", () => ({ OverviewPage: () => <div>overview-page</div> }));
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

beforeEach(() => vi.stubGlobal("scrollTo", vi.fn()));

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
});
