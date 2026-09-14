import { Suspense } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";

const mock = vi.hoisted(() => ({ get: vi.fn(), navigate: vi.fn(), removeTab: vi.fn() }));

vi.mock("@solidjs/router", () => ({
  A: (props: { children?: any }) => <a>{props.children}</a>,
  useNavigate: () => mock.navigate,
  useParams: () => ({ id: "missing" }),
  useSearchParams: () => [{}, vi.fn()],
}));
vi.mock("../../api/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api/client")>(),
  get: mock.get,
}));
vi.mock("../../stores/tabs", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../stores/tabs")>(),
  removeTab: mock.removeTab,
}));

import { ApiError } from "../../api/client";
import { ContainerDetailPage } from "./ContainerDetailPage";

beforeEach(() => {
  mock.get.mockImplementation((path: string) => path.includes("/containers/missing/inspect")
    ? Promise.reject(new ApiError(404, "not found"))
    : Promise.resolve([]));
});
afterEach(() => {
  cleanup();
  mock.get.mockReset();
  mock.navigate.mockReset();
  mock.removeTab.mockReset();
});

describe("ContainerDetailPage", () => {
  it("shows an error and returns home for a missing container", async () => {
    render(() => <Suspense fallback={<p>loading</p>}><ContainerDetailPage /></Suspense>);

    await screen.findByText("加载失败：not found");
    await waitFor(() => expect(mock.navigate).toHaveBeenCalledWith("/overview", { replace: true }));
    await waitFor(() => expect(mock.removeTab).toHaveBeenCalledWith("/containers/missing"));
  });
});
