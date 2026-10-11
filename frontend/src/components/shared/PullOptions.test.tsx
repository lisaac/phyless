import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import {
  PullOptions,
  createPullOptions,
  pullOptionsPayload,
  readPullProxyUrl,
  readPullProxyUrls,
  rememberPullProxyUrl,
  removePullProxyUrl,
  savePullProxyUrl,
  browserCreds,
  browserSecret,
} from "./PullOptions";
import { rememberCreds, saveWorkerUrl } from "../../stores/browserPullSettings";

vi.mock("../../api/client", () => ({ getToken: () => "token", get: vi.fn() }));
const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("../../api/registrySearch", () => ({ verifyRegistryCreds: verify }));

afterEach(() => { cleanup(); localStorage.clear(); });

describe("pull options", () => {
  it("builds only explicit request fields", () => {
    expect(pullOptionsPayload({ proxyUrl: " ", registryIds: [], platform: "" })).toEqual({});
    expect(pullOptionsPayload({ proxyUrl: " http://proxy:8080 ", registryIds: ["one"], platform: " linux/arm64 " })).toEqual({
      registry_ids: ["one"], platform: "linux/arm64",
    });
    expect(pullOptionsPayload({ useProxy: true, proxyUrl: " http://proxy:8080 " })).toEqual({ proxy_url: "http://proxy:8080" });
  });

  it("remembers a valid proxy endpoint without persisting credentials", () => {
    rememberPullProxyUrl(" http://proxy.example:8080 ");
    expect(readPullProxyUrl()).toBe("http://proxy.example:8080");

    rememberPullProxyUrl("http://user:secret@proxy.example:8080");
    expect(readPullProxyUrl()).toBe("http://proxy.example:8080");
    expect(localStorage.getItem("phyless_pull_proxy_url")).not.toContain("secret");

    rememberPullProxyUrl("socks5://proxy.example");
    expect(readPullProxyUrl()).toBe("http://proxy.example:8080");
  });

  it("clears the remembered proxy when the field is emptied", () => {
    rememberPullProxyUrl("http://proxy.example:8080");
    rememberPullProxyUrl(" ");
    expect(readPullProxyUrl()).toBe("");
  });

  it("manages multiple saved proxy urls", () => {
    expect(savePullProxyUrl("http://one.example:8080")).toEqual(["http://one.example:8080"]);
    expect(savePullProxyUrl("socks5://two.example:1080")).toEqual(["socks5://two.example:1080", "http://one.example:8080"]);
    expect(removePullProxyUrl("socks5://two.example:1080")).toEqual(["http://one.example:8080"]);
    expect(readPullProxyUrls()).toEqual(["http://one.example:8080"]);
  });

  it("saves on blur, deduplicates, and deletes from the dropdown", () => {
    const pull = createPullOptions();
    render(() => <PullOptions options={pull} />);
    fireEvent.click(screen.getByLabelText("服务端代理"));
    const input = screen.getByPlaceholderText("http://host.docker.internal:7890") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "http://proxy.example:8080" } });
    fireEvent.blur(input);
    fireEvent.input(input, { target: { value: "http://proxy.example:8080" } });
    fireEvent.blur(input);
    expect(readPullProxyUrls()).toEqual(["http://proxy.example:8080"]);

    fireEvent.focus(input);
    const remove = screen.getByRole("button", { name: "删除地址 http://proxy.example:8080" });
    fireEvent.click(remove);
    expect(readPullProxyUrls()).toEqual([]);
  });

  it("offers the three pull modes when browser import is available", () => {
    const pull = createPullOptions();
    render(() => <PullOptions options={pull} allowBrowser />);
    expect(screen.getByLabelText("不使用代理")).toBeTruthy();
    expect(screen.getByLabelText("服务端代理")).toBeTruthy();
    expect(screen.getByLabelText("浏览器代理导入")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("服务端代理"));
    expect(pull.value.useProxy).toBe(true);
    fireEvent.click(screen.getByLabelText("不使用代理"));
    expect(pull.value.useProxy).toBe(false);
    fireEvent.click(screen.getByLabelText("浏览器代理导入"));
    expect(pull.value.downloadMode).toBe("browser");
  });

  it("adds, verifies, edits and deletes per-registry accounts, persisting them once remembered", async () => {
    saveWorkerUrl("https://worker.example");
    verify.mockReset().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("镜像仓库认证失败（401）"));
    const pull = createPullOptions();
    render(() => <PullOptions options={pull} allowBrowser />);
    fireEvent.click(screen.getByLabelText("浏览器代理导入"));
    fireEvent.click(screen.getByLabelText(/记住凭据/));
    expect(screen.getByText(/未添加账号/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+ 添加 Docker Hub 账号" }));
    expect((screen.getByLabelText("Registry 地址") as HTMLInputElement).value).toBe("docker.io");
    const username = screen.getByLabelText("私有镜像用户名") as HTMLInputElement;
    username.focus();
    fireEvent.input(username, { target: { value: "a" } });
    fireEvent.input(username, { target: { value: "al" } });
    // Typing never re-renders the form, so focus stays put.
    expect(document.activeElement).toBe(username);
    expect(screen.getByLabelText("私有镜像用户名")).toBe(username);
    fireEvent.input(username, { target: { value: "alice" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("请填写用户名和密码 / Token")).toBeTruthy();
    fireEvent.input(screen.getByLabelText("密码 / Token"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("Docker Hub")).toBeTruthy();
    expect(screen.getByText("alice · docker.io")).toBeTruthy();
    expect(verify).toHaveBeenCalledWith("https://worker.example", "docker.io", { username: "alice", secret: "secret" }, expect.any(AbortSignal));
    expect(await screen.findByText("✓ 可用")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "+ 添加" }));
    fireEvent.input(screen.getByLabelText("Registry 地址"), { target: { value: "https://GHCR.io/" } });
    fireEvent.input(screen.getByLabelText("私有镜像用户名"), { target: { value: "bob" } });
    fireEvent.input(screen.getByLabelText("密码 / Token"), { target: { value: "token" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("✗ 失败")).toBeTruthy();
    expect(screen.getByText("镜像仓库认证失败（401）")).toBeTruthy();

    const want = { "docker.io": { username: "alice", secret: "secret" }, "ghcr.io": { username: "bob", secret: "token" } };
    expect(browserCreds(pull.value)).toEqual(want);
    expect(browserSecret(pull.value)).toEqual({ creds: want });
    expect(JSON.parse(localStorage.getItem("phyless_pull_registry_creds")!)).toEqual({ "https://worker.example": want });

    fireEvent.click(screen.getByRole("button", { name: "+ 添加" }));
    fireEvent.input(screen.getByLabelText("Registry 地址"), { target: { value: "ghcr.io" } });
    fireEvent.input(screen.getByLabelText("私有镜像用户名"), { target: { value: "x" } });
    fireEvent.input(screen.getByLabelText("密码 / Token"), { target: { value: "y" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/已存在 ghcr.io 的账号/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    fireEvent.click(screen.getByRole("button", { name: "编辑账号 docker.io" }));
    fireEvent.input(screen.getByLabelText("私有镜像用户名"), { target: { value: "alice2" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("alice2 · docker.io");
    expect(browserCreds(pull.value)!["docker.io"].username).toBe("alice2");
    fireEvent.click(screen.getByRole("button", { name: "删除账号 docker.io" }));
    expect(browserCreds(pull.value)).toEqual({ "ghcr.io": want["ghcr.io"] });
    pull.reset();
    expect(browserCreds(pull.value)).toEqual({ "ghcr.io": want["ghcr.io"] });
    expect(pull.value.rememberCreds).toBe(true);
  });

  it("opens the account form on request from the search panel", () => {
    const pull = createPullOptions();
    render(() => <PullOptions options={pull} allowBrowser />);
    fireEvent.click(screen.getByLabelText("浏览器代理导入"));
    pull.set("addAccount", "docker.io");
    expect((screen.getByLabelText("Registry 地址") as HTMLInputElement).value).toBe("docker.io");
    expect(pull.value.addAccount).toBe("");
  });

  it("loads accounts for a selected worker and clears them for a new one", () => {
    saveWorkerUrl("https://one.example");
    saveWorkerUrl("https://two.example");
    rememberCreds("https://one.example", { "docker.io": { username: "one-user", secret: "one-secret" } });
    rememberCreds("https://two.example", { "ghcr.io": { username: "two-user", secret: "two-secret" } });
    const pull = createPullOptions();
    render(() => <PullOptions options={pull} allowBrowser />);
    fireEvent.click(screen.getByLabelText("浏览器代理导入"));
    const worker = screen.getByPlaceholderText("https://your-worker.workers.dev") as HTMLInputElement;
    const remember = screen.getByLabelText(/记住凭据/) as HTMLInputElement;
    expect(screen.getByText("two-user · ghcr.io")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();

    fireEvent.focus(worker);
    fireEvent.click(screen.getByText("https://one.example"));
    expect(screen.getByText("one-user · docker.io")).toBeTruthy();

    fireEvent.input(worker, { target: { value: "https://new.example" } });
    expect(screen.getByText(/未添加账号/)).toBeTruthy();
    expect(browserCreds(pull.value)).toBeUndefined();
    expect(remember.checked).toBe(false);
  });

  it("remembers the proxy url but only sends it in server proxy mode", () => {
    rememberPullProxyUrl("http://proxy.example:8080");
    const pull = createPullOptions();
    render(() => <PullOptions options={pull} />);
    expect(pull.payload()).toEqual({});

    fireEvent.click(screen.getByLabelText("服务端代理"));
    const url = screen.getByPlaceholderText("http://host.docker.internal:7890") as HTMLInputElement;
    expect(url.value).toBe("http://proxy.example:8080");
    expect(pull.payload()).toEqual({ proxy_url: "http://proxy.example:8080" });

    pull.reset();
    expect(pull.value.useProxy).toBe(false);
    expect(pull.value.proxyUrl).toBe("http://proxy.example:8080");
  });
});
