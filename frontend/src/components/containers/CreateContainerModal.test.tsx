import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { CreateContainerModal } from "./CreateContainerModal";

const { loaded } = vi.hoisted(() => ({ loaded: vi.fn() }));
vi.mock("./CreateContainerModalContent", () => {
  loaded();
  return { CreateContainerModal: () => <div>Editor loaded</div> };
});
afterEach(cleanup);
it("loads the editor only after opening", async () => {
  const [open, setOpen] = createSignal(false);
  render(() => <CreateContainerModal open={open()} onClose={() => setOpen(false)} />);
  expect(loaded).not.toHaveBeenCalled();
  setOpen(true);
  expect(await screen.findByText("Editor loaded")).toBeTruthy();
  expect(loaded).toHaveBeenCalledTimes(1);
  setOpen(false);
  expect(screen.queryByText("Editor loaded")).toBeNull();
});
