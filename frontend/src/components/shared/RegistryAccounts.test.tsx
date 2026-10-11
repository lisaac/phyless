import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";

const { get, request, queued, confirm, verify } = vi.hoisted(() => ({ get: vi.fn(), request: vi.fn(), queued: vi.fn(), confirm: vi.fn(), verify: vi.fn() }));
vi.mock("../../api/client", () => ({ get, request, getToken: () => "token" }));
vi.mock("../../stores/taskQueue", () => ({ queued, enqueue: vi.fn() }));
vi.mock("./ConfirmModal", () => ({ confirmAction: confirm }));
vi.mock("../../api/registrySearch", () => ({ verifyRegistryCreds: verify }));

import { PullOptions, browserCreds, browserSecret, createPullOptions } from "./PullOptions";
import { getRememberedAccounts, rememberAccounts, saveWorkerUrl } from "../../stores/browserPullSettings";

let registries: { id: string; url: string; username: string }[];
beforeEach(() => {
  registries = [
    { id: "r1", url: "https://index.docker.io/v1/", username: "alice" },
    { id: "r2", url: "ghcr.io", username: "bob" },
    { id: "r3", url: "docker.io", username: "carol" },
  ];
  get.mockReset().mockImplementation(async (path: string) => {
    if (path === "/api/registries") return registries.map((r) => ({ ...r }));
    if (path === "/api/system/platform") return { os: "linux", architecture: "arm", variant: "v7" };
    return [];
  });
  request.mockReset().mockImplementation(async (_method: string, path: string) => {
    const m = path.match(/^\/api\/registries\/(\w+)\/credentials$/);
    if (m) { const r = registries.find((x) => x.id === m[1])!; return { url: r.url, username: r.username, password: `pw-${r.id}` }; }
    return { status: "ok" };
  });
  queued.mockReset().mockResolvedValue(undefined);
  confirm.mockReset().mockResolvedValue(true);
  verify.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); localStorage.clear(); });

const group = (name: string) => screen.getByRole("radiogroup", { name: `${name} 账号` });

describe("server registry accounts (server-side pulls)", () => {
  it("groups accounts by registry and picks one (or none) per registry", async () => {
    const pull = createPullOptions();
    render(() => <PullOptions options={pull} />);
    await screen.findByText("alice");
    const hub = group("Docker Hub");
    expect(within(hub).getByText("carol")).toBeTruthy();
    expect((within(hub).getByLabelText("docker.io 不使用账号") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(hub).getByLabelText("使用 carol @ docker.io"));
    fireEvent.click(within(group("GitHub")).getByLabelText("使用 bob @ ghcr.io"));
    expect(pull.payload()).toEqual({ registry_ids: ["r3", "r2"] });
    fireEvent.click(within(hub).getByLabelText("使用 alice @ docker.io"));
    expect(pull.payload()).toEqual({ registry_ids: ["r2", "r1"] });
    expect((within(hub).getByLabelText("使用 alice @ docker.io") as HTMLInputElement).checked).toBe(true);
    expect((within(hub).getByLabelText("使用 carol @ docker.io") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(hub).getByLabelText("docker.io 不使用账号"));
    expect(pull.payload()).toEqual({ registry_ids: ["r2"] });
  });

  it("verifies over the pull path (with the server proxy when chosen)", async () => {
    request.mockRejectedValueOnce(new Error("registry returned HTTP 401 (UNAUTHORIZED)"));
    const pull = createPullOptions();
    render(() => <PullOptions options={pull} />);
    await screen.findByText("alice");
    fireEvent.click(screen.getByRole("button", { name: "验证账号 alice @ docker.io" }));
    expect(await screen.findByText("registry returned HTTP 401 (UNAUTHORIZED)")).toBeTruthy();
    expect(request).toHaveBeenLastCalledWith("POST", "/api/registries/r1/test", {});
    fireEvent.click(screen.getByLabelText("服务端代理"));
    fireEvent.input(screen.getByPlaceholderText("http://host.docker.internal:7890"), { target: { value: "http://proxy:7890" } });
    fireEvent.click(screen.getByRole("button", { name: "验证账号 bob @ ghcr.io" }));
    expect(await screen.findByText("✓ 可用")).toBeTruthy();
    expect(request).toHaveBeenLastCalledWith("POST", "/api/registries/r2/test", { proxy_url: "http://proxy:7890" });
  });

  it("adds into a registry group (auto-picked, verified), edits keeping the password, deletes after confirming", async () => {
    const pull = createPullOptions();
    render(() => <PullOptions options={pull} />);
    await screen.findByText("alice");
    fireEvent.click(screen.getByRole("button", { name: "为 ghcr.io 添加账号" }));
    expect((screen.getByLabelText("Registry 地址") as HTMLInputElement).value).toBe("ghcr.io");
    fireEvent.input(screen.getByLabelText("私有镜像用户名"), { target: { value: "dave" } });
    fireEvent.input(screen.getByLabelText("密码 / Token"), { target: { value: "pw" } });
    queued.mockImplementationOnce(async () => { registries.push({ id: "r4", url: "ghcr.io", username: "dave" }); });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await within(group("GitHub")).findByText("dave")).toBeTruthy();
    expect(queued).toHaveBeenLastCalledWith("添加仓库账号 ghcr.io", "POST", "/api/registries", { url: "ghcr.io", username: "dave", password: "pw" });
    expect(pull.payload()).toEqual({ registry_ids: ["r4"] });
    expect(request).toHaveBeenLastCalledWith("POST", "/api/registries/r4/test", {});

    fireEvent.click(screen.getByRole("button", { name: "编辑账号 bob @ ghcr.io" }));
    expect((screen.getByLabelText("密码 / Token") as HTMLInputElement).placeholder).toMatch(/留空不修改/);
    fireEvent.input(screen.getByLabelText("私有镜像用户名"), { target: { value: "bob2" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await vi.waitFor(() => expect(queued).toHaveBeenLastCalledWith("更新仓库账号 ghcr.io", "PUT", "/api/registries/r2", { url: "ghcr.io", username: "bob2", password: "" }));

    confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "删除账号 dave @ ghcr.io" }));
    await Promise.resolve();
    expect(queued).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "删除账号 dave @ ghcr.io" }));
    await vi.waitFor(() => expect(queued).toHaveBeenLastCalledWith("删除仓库账号 ghcr.io", "DELETE", "/api/registries/r4"));
    expect(pull.payload()).toEqual({});
  });

  it("shows the managed daemon's platform as the platform default", async () => {
    const pull = createPullOptions();
    render(() => <PullOptions options={pull} showPlatform />);
    await vi.waitFor(() => expect((screen.getByLabelText(/平台/) as HTMLInputElement).placeholder).toBe("linux/arm/v7（当前 Docker daemon）"));
    expect(pull.payload()).toEqual({});
  });
});

describe("frontend proxy accounts", () => {
  const browserMode = async () => {
    saveWorkerUrl("https://worker.example");
    const pull = createPullOptions();
    render(() => <PullOptions options={pull} allowBrowser />);
    fireEvent.click(screen.getByLabelText("浏览器代理导入"));
    expect(screen.getByText("前端代理仓库账号")).toBeTruthy();
    await screen.findByText("alice");
    return pull;
  };

  it("adds several browser accounts per registry, typing without losing focus, and uses the picked one", async () => {
    const pull = await browserMode();
    fireEvent.click(screen.getByRole("button", { name: "为 docker.io 添加账号" }));
    const username = screen.getByLabelText("私有镜像用户名") as HTMLInputElement;
    username.focus();
    fireEvent.input(username, { target: { value: "a" } });
    fireEvent.input(username, { target: { value: "me" } });
    expect(document.activeElement).toBe(username);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("请填写用户名和密码 / Token")).toBeTruthy();
    fireEvent.input(screen.getByLabelText("密码 / Token"), { target: { value: "s1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByLabelText("使用 me @ docker.io（浏览器）")).toBeTruthy();
    expect(browserCreds(pull.value)).toEqual({ "docker.io": { username: "me", secret: "s1" } });
    expect(verify).toHaveBeenLastCalledWith("https://worker.example", "docker.io", { username: "me", secret: "s1" }, expect.any(AbortSignal));

    fireEvent.click(screen.getByRole("button", { name: "为 docker.io 添加账号" }));
    fireEvent.input(screen.getByLabelText("私有镜像用户名"), { target: { value: "me2" } });
    fireEvent.input(screen.getByLabelText("密码 / Token"), { target: { value: "s2" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByLabelText("使用 me2 @ docker.io（浏览器）");
    expect(browserCreds(pull.value)).toEqual({ "docker.io": { username: "me2", secret: "s2" } });
    fireEvent.click(screen.getByLabelText("使用 me @ docker.io（浏览器）"));
    expect(browserSecret(pull.value)).toEqual({ creds: { "docker.io": { username: "me", secret: "s1" } } });
    fireEvent.click(screen.getByLabelText("docker.io 不使用账号"));
    expect(browserCreds(pull.value)).toBeUndefined();
  });

  it("uses a server account through the frontend proxy: secret fetched on pick, kept in memory only", async () => {
    const pull = await browserMode();
    fireEvent.click(screen.getByLabelText(/记住凭据/));
    fireEvent.click(screen.getByLabelText("使用 bob @ ghcr.io（服务端）"));
    await vi.waitFor(() => expect(browserCreds(pull.value)).toEqual({ "ghcr.io": { username: "bob", secret: "pw-r2" } }));
    expect(request).toHaveBeenCalledWith("POST", "/api/registries/r2/credentials");
    const stored = localStorage.getItem("phyless_pull_registry_creds") ?? "";
    expect(stored).toContain("s:r2");
    expect(stored).not.toContain("pw-r2");
    fireEvent.click(screen.getByRole("button", { name: "验证账号 bob @ ghcr.io" }));
    await vi.waitFor(() => expect(verify).toHaveBeenLastCalledWith("https://worker.example", "ghcr.io", { username: "bob", secret: "pw-r2" }, expect.any(AbortSignal)));
    // Server accounts are managed in the server modes, not here.
    expect(screen.queryByRole("button", { name: "删除账号 bob @ ghcr.io" })).toBeNull();
  });

  it("drops a server pick whose secret cannot be fetched", async () => {
    const pull = await browserMode();
    request.mockImplementationOnce(async () => { throw new Error("forbidden"); });
    fireEvent.click(screen.getByLabelText("使用 carol @ docker.io（服务端）"));
    expect(await screen.findByText("无法取用服务端账号：forbidden")).toBeTruthy();
    expect(pull.value.browserUse).toEqual([]);
  });

  it("restores remembered picks per worker and edits/deletes browser accounts", async () => {
    saveWorkerUrl("https://one.example");
    rememberAccounts("https://one.example", { accounts: [{ id: "x1", host: "docker.io", username: "kept", secret: "k" }], use: ["b:x1", "s:r2"] });
    saveWorkerUrl("https://worker.example");
    const pull = createPullOptions();
    render(() => <PullOptions options={pull} allowBrowser />);
    fireEvent.click(screen.getByLabelText("浏览器代理导入"));
    await screen.findByText("alice");
    expect(screen.queryByText("kept")).toBeNull();
    const worker = screen.getByPlaceholderText("https://your-worker.workers.dev");
    fireEvent.focus(worker);
    fireEvent.click(screen.getByText("https://one.example"));
    expect(await screen.findByText("kept")).toBeTruthy();
    expect((screen.getByLabelText(/记住凭据/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("使用 kept @ docker.io（浏览器）") as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "编辑账号 kept @ docker.io" }));
    fireEvent.input(screen.getByLabelText("私有镜像用户名"), { target: { value: "kept2" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("kept2");
    expect(getRememberedAccounts("https://one.example")!.accounts[0].username).toBe("kept2");
    fireEvent.click(screen.getByRole("button", { name: "删除账号 kept2 @ docker.io" }));
    expect(getRememberedAccounts("https://one.example")).toEqual({ accounts: [], use: ["s:r2"] });
  });

  it("opens the add form when the search panel asks for a Docker Hub account", async () => {
    const pull = await browserMode();
    pull.set("addAccount", "docker.io");
    expect((await screen.findByLabelText("Registry 地址") as HTMLInputElement).value).toBe("docker.io");
    expect(pull.value.addAccount).toBe("");
  });
});
