import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { FileBrowser } from "./FileBrowser";

describe("FileBrowser", () => {
  it("lists entries from listPath", async () => {
    const listPath = vi.fn().mockResolvedValue([
      { name: "etc", is_dir: true, size: 0 },
      { name: "file.txt", is_dir: false, size: 12 },
    ]);
    const { findByText } = render(() => <FileBrowser listPath={listPath} />);
    expect(await findByText(/file.txt/)).toBeTruthy();
    expect(listPath).toHaveBeenCalledWith("/");
  });
});
