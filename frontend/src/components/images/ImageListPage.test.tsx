import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { ImageListPage } from "./ImageListPage";

const { get, enqueue } = vi.hoisted(() => ({ get: vi.fn().mockResolvedValue([]), enqueue: vi.fn() }));
vi.mock("@solidjs/router", () => ({ A: (props: { children: unknown }) => props.children }));
vi.mock("../../api/client", () => ({ get, getToken: () => "token" }));
vi.mock("../../stores/auth", () => ({ hasRole: () => true }));
vi.mock("../../stores/taskQueue", () => ({ enqueue, queued: vi.fn(), isPending: () => false, SETTLED_EVENT: "settled" }));
vi.mock("../../stores/resource", () => ({ createResourceStore: () => ({
  items: () => [{ Id: "sha256:abc", RepoTags: ["example/app:v2"], RepoDigests: [], Size: 123, Created: 1, UsedBy: [] }],
  loading: () => false, error: () => "", startPolling: vi.fn(), stopPolling: vi.fn(), refresh: vi.fn(),
}) }));

beforeEach(() => { vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); localStorage.clear(); });

describe("ImageListPage 升级按钮", () => {
  it("预填镜像 tag，展示拉取选项，并提交该 tag", async () => {
    render(() => <ImageListPage />);
    fireEvent.click(screen.getByTitle("升级：重新拉取该镜像标签"));
    expect(screen.getByRole("heading", { name: "拉取镜像" })).toBeTruthy();
    expect((screen.getByPlaceholderText("nginx:latest") as HTMLInputElement).value).toBe("example/app:v2");
    expect(await screen.findByText("服务端代理")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "拉取" }));
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      url: "/api/images/pull", body: expect.objectContaining({ image: "example/app:v2" }),
    }));
  });
});
