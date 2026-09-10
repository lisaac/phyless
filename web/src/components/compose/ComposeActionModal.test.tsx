import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { ComposeActionModal, startComposeAction } from "./ComposeActionModal";

vi.mock("../../api/client", () => ({ getToken: () => "token", get: vi.fn().mockResolvedValue([]) }));
vi.mock("../../stores/taskQueue", () => ({
  enqueue: vi.fn(() => ({ done: Promise.resolve() })),
  isPending: () => false,
}));

afterEach(() => cleanup());

describe("ComposeActionModal", () => {
  it("queues pause directly", async () => {
    const { enqueue } = await import("../../stores/taskQueue");
    void startComposeAction({ id: "p1", name: "app", verb: "pause" });
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      url: "/api/compose/pause?id=p1",
      meta: { composeId: "p1", verb: "pause" },
    }));
  });

  it("sends pull_policy for up only", async () => {
    const { enqueue } = await import("../../stores/taskQueue");
    render(() => <ComposeActionModal target={{ id: "p1", name: "app", verb: "up" }} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("镜像拉取策略"), { target: { value: "never" } });
    fireEvent.click(screen.getByRole("button", { name: "Up" }));
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ body: { pull_policy: "never" } }));
    cleanup();

    render(() => <ComposeActionModal target={{ id: "p1", name: "app", verb: "pull" }} onClose={() => {}} />);
    expect(screen.queryByLabelText("镜像拉取策略")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "pull/build" }));
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      body: undefined,
      meta: expect.objectContaining({ type: "compose-update", composeId: "p1", verb: "pull", mode: "server", canBuild: false }),
    }));
  });

  it("pull with build enqueues the merged compose-update task", async () => {
    const { enqueue } = await import("../../stores/taskQueue");
    render(() => <ComposeActionModal target={{ id: "p1", name: "app", verb: "pull", canBuild: true }} onClose={() => {}} />);
    expect(screen.queryByLabelText("镜像拉取策略")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "pull/build" }));
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ type: "compose-update", composeId: "p1", verb: "pull", mode: "server", canBuild: true }),
    }));
  });

  it("update enqueues the pull/build plus down/up task", async () => {
    const { enqueue } = await import("../../stores/taskQueue");
    render(() => <ComposeActionModal target={{ id: "p1", name: "app", verb: "update", canBuild: true }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "update" }));
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      title: "update — app",
      meta: expect.objectContaining({ type: "compose-update", composeId: "p1", verb: "update", mode: "server", canBuild: true, restart: true }),
    }));
  });

  it("build supports browser preload mode", async () => {
    const { enqueue } = await import("../../stores/taskQueue");
    render(() => <ComposeActionModal target={{ id: "p1", name: "app", verb: "build" }} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("浏览器代理导入"));
    fireEvent.input(screen.getByPlaceholderText("https://your-worker.workers.dev"), { target: { value: "https://worker" } });
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ type: "browser-pull-compose", mode: "build" }),
    }));
  });
});
