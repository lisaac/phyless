import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { ComposeActionModal } from "./ComposeActionModal";

vi.mock("../../api/client", () => ({ getToken: () => "token", get: vi.fn().mockResolvedValue([]) }));
vi.mock("../../stores/taskQueue", () => ({
  enqueue: vi.fn(() => ({ done: Promise.resolve() })),
  isPending: () => false,
}));

afterEach(() => cleanup());

describe("ComposeActionModal", () => {
  it("sends pull_policy for up only", async () => {
    const { enqueue } = await import("../../stores/taskQueue");
    render(() => <ComposeActionModal target={{ id: "p1", name: "app", verb: "up" }} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("镜像拉取策略"), { target: { value: "never" } });
    fireEvent.click(screen.getByRole("button", { name: "Up" }));
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ body: { pull_policy: "never" } }));
    cleanup();

    render(() => <ComposeActionModal target={{ id: "p1", name: "app", verb: "pull" }} onClose={() => {}} />);
    expect(screen.queryByLabelText("镜像拉取策略")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pull" }));
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ body: undefined }));
  });

  it("update (server proxy) enqueues a compose-update task and hides pull_policy", async () => {
    const { enqueue } = await import("../../stores/taskQueue");
    render(() => <ComposeActionModal target={{ id: "p1", name: "app", verb: "update", canBuild: true }} onClose={() => {}} />);
    expect(screen.queryByLabelText("镜像拉取策略")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ type: "compose-update", composeId: "p1", mode: "server", canBuild: true }),
    }));
  });

  it("build supports browser preload mode", async () => {
    const { enqueue } = await import("../../stores/taskQueue");
    render(() => <ComposeActionModal target={{ id: "p1", name: "app", verb: "build" }} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("浏览器下载"));
    fireEvent.input(screen.getByPlaceholderText("https://your-worker.workers.dev"), { target: { value: "https://worker" } });
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ type: "browser-pull-compose", mode: "build" }),
    }));
  });
});
