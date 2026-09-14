import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import { Button } from "./Button";

describe("Button", () => {
  it("renders children and variant class", () => {
    const { getByText } = render(() => <Button variant="danger">Delete</Button>);
    const btn = getByText("Delete");
    expect(btn.className).toContain("bg-red-500/10");
  });
});
