import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { ConfirmModal, confirmAction } from "./ConfirmModal";

afterEach(cleanup);

describe("ConfirmModal", () => {
  it("resolves the requested choice", async () => {
    const view = render(() => <ConfirmModal />);

    const accepted = confirmAction("删除镜像？", { confirmText: "删除", danger: true });
    fireEvent.click(view.getByText("删除"));
    expect(await accepted).toBe(true);

    const cancelled = confirmAction("继续打开？");
    fireEvent.click(view.getByText("取消"));
    expect(await cancelled).toBe(false);
  });
});
