import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { OverviewPage } from "./OverviewPage";

const apiMock = vi.hoisted(() => ({ get: vi.fn(), setToken: vi.fn() }));

vi.mock("@solidjs/router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../api/client", () => ({
  get: apiMock.get,
  getToken: () => null,
  readSignal: () => ({ signal: new AbortController().signal, dispose: () => {} }),
  setToken: apiMock.setToken,
}));
vi.mock("../../stores/resource", () => ({
  createResourceStore: () => ({ items: () => [], startPolling: vi.fn(), stopPolling: vi.fn() }),
}));
vi.mock("../../stores/refresh", () => ({ REFRESH_EVENT: "phyless:refresh" }));

beforeEach(() => {
  apiMock.get.mockResolvedValue({
    host_name: "docker-host", server_version: "28.0.1", api_version: "1.50", min_api_version: "1.24",
    operating_system: "Ubuntu 24.04", os_type: "linux", architecture: "amd64", kernel_version: "6.8",
    n_cpu: 8, mem_total: 16_000_000_000, n_goroutines: 42, n_fds: 99, docker_root_dir: "/var/lib/docker",
    storage_driver: "overlay2", storage_available: "120 GB", cgroup_driver: "systemd", cgroup_version: "2",
    logging_driver: "json-file", default_runtime: "runc", live_restore: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OverviewPage", () => {
  it("shows the Docker daemon summary", async () => {
    render(() => <OverviewPage />);

    await screen.findByText("Docker 信息");
    expect(apiMock.get).toHaveBeenCalledWith("/api/system/info");
    expect(screen.getByText("28.0.1")).toBeTruthy();
    expect(screen.getByText("1.50（最低 1.24）")).toBeTruthy();
    expect(screen.getByText("16.0 GB")).toBeTruthy();
    expect(screen.getByText("/var/lib/docker")).toBeTruthy();
    expect(screen.getByText("120 GB")).toBeTruthy();
  });
});
