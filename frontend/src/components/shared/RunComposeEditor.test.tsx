import { describe, it, expect, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import { RunComposeEditor } from "./RunComposeEditor";

// CodeMirror needs layout APIs jsdom lacks; stub CodeEditor to a textarea.
vi.mock("./CodeEditor", () => ({
  CodeEditor: (props: { value: string; onChange?: (v: string) => void }) => (
    <textarea value={props.value} onInput={(e) => props.onChange?.(e.currentTarget.value)} />
  ),
}));

describe("RunComposeEditor", () => {
  it("renders both panes and an action slot", () => {
    const { getByText, container } = render(() => (
      <RunComposeEditor
        initialRun="docker run nginx"
        actions={() => <button>复制</button>}
      />
    ));
    expect(getByText("docker run")).toBeTruthy();
    expect(getByText("compose.yaml")).toBeTruthy();
    expect(getByText("复制")).toBeTruthy();
    expect(container.querySelectorAll("textarea").length).toBe(2);
  });
});
