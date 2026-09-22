import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { ContainerRow } from "./ContainerRow";
import type { ContainerSummary } from "../../types";

const { get } = vi.hoisted(() => ({ get: vi.fn().mockResolvedValue([]) }));
vi.mock("@solidjs/router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../stores/auth", () => ({ hasRole: () => true }));
vi.mock("../../api/client", () => ({ get, getToken: () => "token" }));

afterEach(() => { cleanup(); get.mockClear(); });

const container = (Mounts: ContainerSummary["Mounts"], State = "running"): ContainerSummary => ({
  Id: "abc", Names: ["/web"], Image: "nginx", State, Status: "Up 1 minute",
  Created: 1, Ports: [], Mounts, Command: "nginx",
});

describe("ContainerRow volume links", () => {
  it.each([
    { mounts: [{ Source: "/host", Destination: "/data" }], title: "/host → /data", path: "%2Fdata" },
    { mounts: [], title: "从根目录浏览文件", path: "%2F" },
  ])("opens the file browser at $path", async ({ mounts, title, path }) => {
    render(() => <ContainerRow
      all={[]} c={container(mounts)} isP={() => false} act={() => {}} onViewCmd={() => {}}
    />);

    fireEvent.click(screen.getByTitle(title));

    expect(screen.getByRole("heading", { name: "文件 · web" })).toBeTruthy();
    await waitFor(() => expect(get).toHaveBeenCalledWith(`/api/containers/abc/files?path=${path}`));
  });

  it("opens a stopped container at root", async () => {
    render(() => <ContainerRow
      all={[]} c={container([], "exited")} isP={() => false} act={() => {}} onViewCmd={() => {}}
    />);
    fireEvent.click(screen.getByTitle("从根目录浏览文件"));
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/containers/abc/files?path=%2F"));
  });
});
