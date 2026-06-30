import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import { Sparkline } from "./Sparkline";

describe("Sparkline", () => {
  it("renders a canvas", () => {
    const { container } = render(() => <Sparkline data={[1, 2, 3]} />);
    expect(container.querySelector("canvas")).toBeTruthy();
  });
});
