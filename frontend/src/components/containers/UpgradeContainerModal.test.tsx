import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { UpgradeContainerModal, composeUpgradeWarning } from "./UpgradeContainerModal";
import { staleEnvCandidates } from "../../stores/updateCheck";

vi.mock("../../api/client", () => ({ getToken: () => "token", get: vi.fn().mockResolvedValue([]), request: vi.fn(), imageInspectUrl: (id: string) => id }));
vi.mock("../../stores/taskQueue", () => ({ enqueue: vi.fn(() => ({ done: Promise.resolve() })) }));
const confirm = vi.hoisted(() => vi.fn());
vi.mock("../shared/ConfirmModal", () => ({ confirmAction: confirm }));

const compose = { "com.docker.compose.project": "myapp", "com.docker.compose.service": "web" };

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("UpgradeContainerModal", () => {
  it("enqueues an upgrade task for the target container", async () => {
    const { enqueue } = await import("../../stores/taskQueue");
    const onClose = vi.fn();
    render(() => <UpgradeContainerModal targets={[{ id: "abc", name: "web" }]} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "升级" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(confirm).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      url: "/api/containers/abc/upgrade",
      key: "abc",
      meta: expect.objectContaining({ type: "upgrade", containerId: "abc" }),
    }));
  });

  it("enqueues one task per container in a batch", async () => {
    const { enqueue } = await import("../../stores/taskQueue");
    const onClose = vi.fn();
    render(() => <UpgradeContainerModal targets={[{ id: "a", name: "a" }, { id: "b", name: "b" }]} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "升级 2 个" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("asks before upgrading a compose-managed container and aborts on cancel", async () => {
    const { enqueue } = await import("../../stores/taskQueue");
    confirm.mockResolvedValueOnce(false);
    const onClose = vi.fn();
    render(() => <UpgradeContainerModal targets={[{ id: "abc", name: "web-1", labels: compose }]} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "升级" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0]).toContain("myapp");
    expect(enqueue).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("proceeds after the compose confirmation", async () => {
    const { enqueue } = await import("../../stores/taskQueue");
    confirm.mockResolvedValueOnce(true);
    const onClose = vi.fn();
    render(() => <UpgradeContainerModal targets={[{ id: "abc", name: "web-1", labels: compose }]} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "升级" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("rebuilds a local-newer container from the local image without pulling", async () => {
    const { enqueue } = await import("../../stores/taskQueue");
    const { recordChecks } = await import("../../stores/updateCheck");
    recordChecks([{ id: "loc", ref: "app:dev", status: "local-newer", local_id: "sha256:a" }]);
    const onClose = vi.fn();
    render(() => <UpgradeContainerModal targets={[{ id: "loc", name: "dev", imageId: "sha256:a" }]} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "升级" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ body: { pull_policy: "never" } }));
  });

  it("renders nothing when targets is null", () => {
    render(() => <UpgradeContainerModal targets={null} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "升级" })).toBeNull();
  });
});

describe("composeUpgradeWarning", () => {
  it("lists only compose-managed containers", () => {
    const w = composeUpgradeWarning([{ id: "a", name: "plain" }, { id: "b", name: "web-1", labels: compose }]);
    expect(w).toContain("web-1（myapp）");
    expect(w).not.toContain("plain");
    expect(composeUpgradeWarning([{ id: "a", name: "plain" }])).toBeNull();
  });
});

const legacyInspect = (path: string) => Promise.resolve(path.includes("/inspect")
  ? { Image: "sha256:b", Config: { Env: ["PATH=/bin", "NGINX_VERSION=1.25", "TZ=UTC", "EXTRA=1"] } }
  : { Config: { Env: ["PATH=/bin", "NGINX_VERSION=1.26", "TZ=Asia/Shanghai"] } });

describe("staleEnvCandidates", () => {
  it("lists variables the image defines with a different value", async () => {
    const got = await staleEnvCandidates("c1", legacyInspect as never);
    expect(got).toEqual([
      { key: "NGINX_VERSION", current: "1.25", image: "1.26" },
      { key: "TZ", current: "UTC", image: "Asia/Shanghai" },
    ]);
  });
});

describe("UpgradeContainerModal stale env", () => {
  it("sends reviewed variables as env_from_image, minus the ones kept", async () => {
    const { enqueue } = await import("../../stores/taskQueue");
    const { get } = await import("../../api/client");
    vi.mocked(get).mockImplementation(legacyInspect as never);
    const onClose = vi.fn();
    render(() => <UpgradeContainerModal
      targets={[{ id: "old1", name: "web", labels: { "io.phyless.upgrade-image-ref": "nginx:latest" } }]}
      onClose={onClose} />);
    const tz = await screen.findByText("TZ");
    fireEvent.click(tz); // keep TZ: it was set on purpose
    fireEvent.click(screen.getByRole("button", { name: "升级" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ body: { env_from_image: ["NGINX_VERSION"] } }));
    vi.mocked(get).mockResolvedValue([]);
  });
});
