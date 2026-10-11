import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";

const { get, request, queued, confirm } = vi.hoisted(() => ({ get: vi.fn(), request: vi.fn(), queued: vi.fn(), confirm: vi.fn() }));
vi.mock("../../api/client", () => ({ get, request, getToken: () => "token" }));
vi.mock("../../stores/taskQueue", () => ({ queued, enqueue: vi.fn() }));
vi.mock("./ConfirmModal", () => ({ confirmAction: confirm }));

import { PullOptions, createPullOptions } from "./PullOptions";

let registries: { id: string; url: string; username: string }[];
beforeEach(() => {
  registries = [
    { id: "r1", url: "https://index.docker.io/v1/", username: "alice" },
    { id: "r2", url: "ghcr.io", username: "bob" },
  ];
  get.mockReset().mockImplementation(async (path: string) => {
    if (path === "/api/registries") return registries.map((r) => ({ ...r }));
    if (path === "/api/system/platform") return { os: "linux", architecture: "arm", variant: "v7" };
    return [];
  });
  request.mockReset().mockResolvedValue({ status: "ok" });
  queued.mockReset().mockResolvedValue(undefined);
  confirm.mockReset().mockResolvedValue(true);
});
afterEach(() => { cleanup(); localStorage.clear(); });

describe("server registry accounts", () => {
  it("shows stored accounts as cards and selects one for this pull", async () => {
    const pull = createPullOptions();
    render(() => <PullOptions options={pull} />);
    expect(await screen.findByText("alice · docker.io")).toBeTruthy();
    expect(screen.getByText("bob · ghcr.io")).toBeTruthy();
    expect(screen.getByText("服务端仓库账号（2）")).toBeTruthy();
    fireEvent.click(screen.getByText("bob · ghcr.io"));
    expect(pull.value.registryId).toBe("r2");
    expect(pull.payload()).toEqual({ registry_id: "r2" });
    fireEvent.click(screen.getByLabelText("本次拉取使用 alice @ docker.io"));
    expect(pull.value.registryId).toBe("r1");
    fireEvent.click(screen.getByText("alice · docker.io"));
    expect(pull.value.registryId).toBe("");
  });

  it("multi-selects for batch pulls", async () => {
    const pull = createPullOptions();
    render(() => <PullOptions options={pull} multipleRegistries />);
    await screen.findByText("alice · docker.io");
    fireEvent.click(screen.getByText("alice · docker.io"));
    fireEvent.click(screen.getByText("bob · ghcr.io"));
    expect(pull.payload()).toEqual({ registry_ids: ["r1", "r2"] });
  });

  it("verifies over the pull path (with the server proxy when chosen)", async () => {
    request.mockRejectedValueOnce(new Error("registry returned HTTP 401 (UNAUTHORIZED)"));
    const pull = createPullOptions();
    render(() => <PullOptions options={pull} />);
    await screen.findByText("alice · docker.io");
    fireEvent.click(screen.getByRole("button", { name: "验证账号 docker.io" }));
    expect(await screen.findByText("registry returned HTTP 401 (UNAUTHORIZED)")).toBeTruthy();
    expect(request).toHaveBeenLastCalledWith("POST", "/api/registries/r1/test", {});
    fireEvent.click(screen.getByLabelText("服务端代理"));
    fireEvent.input(screen.getByPlaceholderText("http://host.docker.internal:7890"), { target: { value: "http://proxy:7890" } });
    fireEvent.click(screen.getByRole("button", { name: "验证账号 ghcr.io" }));
    expect(await screen.findByText("✓ 可用")).toBeTruthy();
    expect(request).toHaveBeenLastCalledWith("POST", "/api/registries/r2/test", { proxy_url: "http://proxy:7890" });
  });

  it("adds (auto-selected and verified), edits keeping the password, and deletes after confirming", async () => {
    const pull = createPullOptions();
    render(() => <PullOptions options={pull} />);
    await screen.findByText("alice · docker.io");
    fireEvent.click(screen.getByRole("button", { name: "+ 添加" }));
    fireEvent.input(screen.getByLabelText("Registry 地址"), { target: { value: "https://Quay.io/" } });
    fireEvent.input(screen.getByLabelText("私有镜像用户名"), { target: { value: "carol" } });
    fireEvent.input(screen.getByLabelText("密码 / Token"), { target: { value: "pw" } });
    queued.mockImplementationOnce(async () => { registries.push({ id: "r3", url: "quay.io", username: "carol" }); });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("carol · quay.io")).toBeTruthy();
    expect(queued).toHaveBeenLastCalledWith("添加仓库账号 quay.io", "POST", "/api/registries", { url: "quay.io", username: "carol", password: "pw" });
    expect(pull.value.registryId).toBe("r3");
    expect(request).toHaveBeenLastCalledWith("POST", "/api/registries/r3/test", {});

    fireEvent.click(screen.getByRole("button", { name: "编辑账号 ghcr.io" }));
    expect((screen.getByLabelText("密码 / Token") as HTMLInputElement).placeholder).toMatch(/留空不修改/);
    fireEvent.input(screen.getByLabelText("私有镜像用户名"), { target: { value: "bob2" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await vi.waitFor(() => expect(queued).toHaveBeenLastCalledWith("更新仓库账号 ghcr.io", "PUT", "/api/registries/r2", { url: "ghcr.io", username: "bob2", password: "" }));

    confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "删除账号 quay.io" }));
    await Promise.resolve();
    expect(queued).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "删除账号 quay.io" }));
    await vi.waitFor(() => expect(queued).toHaveBeenLastCalledWith("删除仓库账号 quay.io", "DELETE", "/api/registries/r3"));
    expect(pull.value.registryId).toBe("");
  });

  it("shows the managed daemon's platform as the platform default", async () => {
    const pull = createPullOptions();
    render(() => <PullOptions options={pull} showPlatform />);
    await vi.waitFor(() => expect((screen.getByLabelText(/平台/) as HTMLInputElement).placeholder).toBe("linux/arm/v7（当前 Docker daemon）"));
    expect(pull.payload()).toEqual({});
  });
});
