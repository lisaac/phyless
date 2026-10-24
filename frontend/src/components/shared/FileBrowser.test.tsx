import { describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@solidjs/testing-library";
import { FileBrowser } from "./FileBrowser";
import { modeToOctal } from "./PermissionModal";

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

  it("offers writes only where the backend allows them", async () => {
    const vol = { type: "volume", source: "v", destination: "/data" };
    const listPath = vi.fn().mockResolvedValue([
      { name: "data", is_dir: true, size: 0, mount: vol },
      { name: "etc", is_dir: true, size: 0 },
      { name: "link", is_dir: false, size: 0, mode: "lrwxrwxrwx", mount: vol },
    ]);
    const op = vi.fn();
    const { findByText, container } = render(() => (
      <FileBrowser listPath={listPath} onRename={op} onDelete={op} onChmod={op} mountsOnly />
    ));
    await findByText(/etc/);
    const actions = [...container.querySelectorAll("tbody tr")].map((tr) =>
      [...tr.querySelectorAll("td:last-child button")].map((b) => b.textContent).join(","));
    // mount point: chmod only; rootfs of a stopped container: nothing; symlink: no chmod.
    expect(actions).toEqual(["权限", "", "重命名,删除"]);
  });
});

describe("modeToOctal", () => {
  it("reads ls modes including special bits", () => {
    expect(modeToOctal("-rw-r--r--")).toBe("644");
    expect(modeToOctal("drwxr-xr-x")).toBe("755");
    expect(modeToOctal("-rwsr-sr-t")).toBe("7755");
    expect(modeToOctal("-rwSr--r-T")).toBe("5644");
    expect(modeToOctal("")).toBe("");
  });
});

describe("FileBrowser rename", () => {
  it("refuses a name that already exists and commits once", async () => {
    const listPath = vi.fn().mockResolvedValue([
      { name: "a", is_dir: false, size: 0 },
      { name: "b", is_dir: false, size: 0 },
    ]);
    const onRename = vi.fn().mockResolvedValue(undefined);
    const { findAllByText, container } = render(() => <FileBrowser listPath={listPath} onRename={onRename} />);
    const rename = async (to: string) => {
      (await findAllByText("重命名"))[0].click();
      const input = container.querySelector("tbody input") as HTMLInputElement;
      fireEvent.input(input, { target: { value: to } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.blur(input);
    };
    await rename("b");
    expect(onRename).not.toHaveBeenCalled();
    await rename("c");
    expect(onRename.mock.calls).toEqual([["/a", "/c"]]);
  });
});
