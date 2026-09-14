import { expect, it } from "vitest";
import { dirBasename } from "./RegisterComposeModal";

it("dirBasename uses the last path segment, ignoring trailing slashes", () => {
  expect(dirBasename("/opt/stacks/app")).toBe("app");
  expect(dirBasename("/opt/stacks/app//")).toBe("app");
  expect(dirBasename("app")).toBe("app");
});
