import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { toast, ToastHost } from "./Toast";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("toast error throttling", () => {
  it("keeps an outage burst from blocking the UI with repeated errors", () => {
    const view = render(() => <ToastHost />);
    toast.error("first error");
    toast.error("second error");
    expect(view.getByText("first error")).toBeTruthy();
    expect(view.queryByText("second error")).toBeNull();

    vi.advanceTimersByTime(4000);
    toast.error("second error");
    expect(view.getByText("second error")).toBeTruthy();
  });
});
