import { Suspense, createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";

const mock = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../api/client", () => ({ get: mock.get }));

import { PathPicker } from "./PathPicker";

afterEach(() => { cleanup(); mock.get.mockReset(); });

it("navigates folders without suspending the page and selects a YAML file", async () => {
  let release!: (entries: unknown[]) => void;
  mock.get.mockImplementation((path: string) => path.includes("%2Fsrv%2F")
    ? new Promise((resolve) => { release = resolve; })
    : Promise.resolve([{ name: "srv", is_dir: true }]));
  const [value, setValue] = createSignal("/");
  render(() => (
    <Suspense fallback={<p>整页刷新</p>}>
      <PathPicker value={value()} onChange={setValue} files />
    </Suspense>
  ));

  fireEvent.focus(screen.getByRole("textbox"));
  fireEvent.click(await screen.findByRole("button", { name: /srv/ }));
  expect(value()).toBe("/srv/");
  expect(screen.queryByText("整页刷新")).toBeNull();
  release([{ name: "compose.yaml", is_dir: false }, { name: "notes.txt", is_dir: false }]);
  fireEvent.click(await screen.findByRole("button", { name: /compose.yaml/ }));
  expect(value()).toBe("/srv/compose.yaml");
  expect(screen.queryByRole("button", { name: /notes.txt/ })).toBeNull();
});
