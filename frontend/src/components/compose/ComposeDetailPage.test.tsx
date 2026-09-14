import { Suspense } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";

const mock = vi.hoisted(() => ({ get: vi.fn(), navigate: vi.fn(), removeTab: vi.fn() }));

vi.mock("@solidjs/router", () => ({
  useNavigate: () => mock.navigate,
  useParams: () => ({ id: "missing" }),
  useSearchParams: () => [{}, vi.fn()],
}));
vi.mock("../../api/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api/client")>(),
  get: mock.get,
}));
vi.mock("../../stores/resource", () => ({
  createResourceStore: () => ({ items: () => [], startPolling: vi.fn(), stopPolling: vi.fn() }),
}));
vi.mock("../../stores/tabs", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../stores/tabs")>(),
  removeTab: mock.removeTab,
}));
vi.mock("../containers/containerActions", () => ({
  createContainerActions: () => ({ isP: () => false, act: vi.fn() }),
}));

import { ApiError } from "../../api/client";
import { ComposeDetailPage } from "./ComposeDetailPage";

beforeEach(() => {
  mock.get.mockImplementation((path: string) => path.includes("/api/compose/detail?id=missing")
    ? Promise.reject(new ApiError(404, "not found"))
    : Promise.resolve([]));
});
afterEach(() => {
  cleanup();
  mock.get.mockReset();
  mock.navigate.mockReset();
  mock.removeTab.mockReset();
});

describe("ComposeDetailPage", () => {
  it("shows an error and returns home for a missing project", async () => {
    render(() => <Suspense fallback={<p>loading</p>}><ComposeDetailPage /></Suspense>);

    await screen.findByText("加载失败：not found");
    await waitFor(() => expect(mock.navigate).toHaveBeenCalledWith("/overview", { replace: true }));
    await waitFor(() => expect(mock.removeTab).toHaveBeenCalledWith("/compose/missing"));
  });
});
