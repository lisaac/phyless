import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { UpgradeContainerModal } from "./UpgradeContainerModal";

vi.mock("../../api/client", () => ({ getToken: () => "token", get: vi.fn().mockResolvedValue([]) }));
vi.mock("../../stores/taskQueue", () => ({ enqueue: vi.fn(() => ({ done: Promise.resolve() })) }));

afterEach(() => cleanup());

describe("UpgradeContainerModal", () => {
  it("enqueues an upgrade task for the target container", async () => {
    const { enqueue } = await import("../../stores/taskQueue");
    const onClose = vi.fn();
    render(() => <UpgradeContainerModal target={{ id: "abc", name: "web" }} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "升级" }));
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      url: "/api/containers/abc/upgrade",
      key: "abc",
      meta: expect.objectContaining({ type: "upgrade", containerId: "abc" }),
    }));
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing when target is null", () => {
    render(() => <UpgradeContainerModal target={null} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "升级" })).toBeNull();
  });
});
