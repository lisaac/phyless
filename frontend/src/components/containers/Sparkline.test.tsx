import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import { Sparkline } from "./Sparkline";

const originalGetContext = HTMLCanvasElement.prototype.getContext;
beforeEach(() => Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => null,
}));
afterEach(() => Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: originalGetContext,
}));

describe("Sparkline", () => {
  it("renders a canvas", () => {
    const { container } = render(() => <Sparkline data={[1, 2, 3]} />);
    expect(container.querySelector("canvas")).toBeTruthy();
  });
});
