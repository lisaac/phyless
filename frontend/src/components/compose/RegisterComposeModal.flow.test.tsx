import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";

const mock = vi.hoisted(() => ({
  get: vi.fn(), queued: vi.fn(), fetchTextFile: vi.fn(), success: vi.fn(), error: vi.fn(),
}));
vi.mock("../../api/client", () => ({ get: mock.get }));
vi.mock("../../stores/taskQueue", () => ({ queued: mock.queued }));
vi.mock("../../api/textFile", () => ({ fetchTextFile: mock.fetchTextFile }));
vi.mock("../shared/Toast", () => ({ toast: { success: mock.success, error: mock.error } }));
vi.mock("../shared/PathPicker", () => ({
  PathPicker: (props: { value: string; onChange: (value: string) => void }) =>
    <input aria-label="YAML 路径" value={props.value} onInput={(event) => props.onChange(event.currentTarget.value)} />,
}));
vi.mock("../shared/CodeEditor", () => ({
  CodeEditor: (props: { value: string; onChange: (value: string) => void; language: string }) =>
    <textarea aria-label={props.language === "yaml" ? "Compose 内容" : "env 内容"} value={props.value} onInput={(event) => props.onChange(event.currentTarget.value)} />,
}));

import { RegisterComposeModal } from "./RegisterComposeModal";

beforeEach(() => {
  mock.get.mockResolvedValue([{ name: "compose.yaml", is_dir: false }, { name: ".env", is_dir: false }]);
  mock.queued.mockResolvedValue(undefined);
  mock.fetchTextFile.mockImplementation((path: string) => Promise.resolve({
    text: path.includes(".env") ? "A=old\n" : "services: {}\n", truncated: false,
  }));
});
afterEach(() => {
  cleanup();
  for (const fn of Object.values(mock)) fn.mockReset();
});

it("creates a project with both editor contents under server storage", async () => {
  render(() => <RegisterComposeModal open onClose={() => {}} onRegistered={() => {}} initialCompose="services: {}" />);
  expect(screen.queryByLabelText("YAML 路径")).toBeNull();
  fireEvent.input(screen.getByPlaceholderText("例如 my-app"), { target: { value: "demo" } });
  fireEvent.input(screen.getByLabelText("env 内容"), { target: { value: "A=1\n" } });
  fireEvent.click(screen.getByText("新建并注册"));
  await waitFor(() => expect(mock.queued).toHaveBeenCalledWith("新建 Compose demo", "POST", "/api/compose/new", {
    name: "demo", compose_content: "services: {}", env_content: "A=1\n",
  }));
});

it("loads a selected YAML file and saves only the changed .env before registration", async () => {
  render(() => <RegisterComposeModal open onClose={() => {}} onRegistered={() => {}} />);
  fireEvent.click(screen.getByLabelText("注册已有 Compose"));
  fireEvent.input(screen.getByLabelText("YAML 路径"), { target: { value: "/srv/app/compose.yaml" } });
  await waitFor(() => expect(screen.getByLabelText<HTMLTextAreaElement>("Compose 内容").value).toBe("services: {}\n"));
  fireEvent.input(screen.getByLabelText("env 内容"), { target: { value: "A=new\n" } });
  fireEvent.click(screen.getByText("注册已有项目"));
  await waitFor(() => expect(mock.queued).toHaveBeenCalledTimes(2));
  expect(mock.queued).toHaveBeenNthCalledWith(1, "保存 /srv/app/.env", "PUT", "/api/fs/file?path=%2Fsrv%2Fapp%2F.env", "A=new\n");
  expect(mock.queued).toHaveBeenNthCalledWith(2, "注册 Compose app", "POST", "/api/compose", {
    name: "app", base_dir: "/srv/app", compose_file: "/srv/app/compose.yaml", env_file: "/srv/app/.env",
  });
});
