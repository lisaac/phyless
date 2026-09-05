import { describe, expect, it } from "vitest";
import { inspectToRunCmd } from "./inspect";
import { shellQuote } from "./shell";
import { emptyForm, formToPayload, parseRunIntoForm } from "../components/containers/containerForm";

describe("inspect command fidelity", () => {
  it("preserves byte memory limits when reopening the generated command", () => {
    const command = inspectToRunCmd({ Config: { Image: "alpine" }, HostConfig: { Memory: 256 * 1024 * 1024 } }, {});
    const payload = formToPayload({ ...emptyForm(), ...parseRunIntoForm(command) });
    expect(payload.memory).toBe(256 * 1024 * 1024);
  });

  it("keeps UDP and named volumes and places entrypoint before the image", () => {
    const command = inspectToRunCmd({
      Config: { Image: "alpine", Entrypoint: ["/custom", "fixed"], Cmd: ["hello world"] },
      HostConfig: { PortBindings: { "53/udp": [{ HostPort: "8053" }] } },
      Mounts: [{ Type: "volume", Name: "data", Source: "/var/lib/docker/volumes/data/_data", Destination: "/data" }],
    }, { Config: { Entrypoint: ["/original"], Cmd: ["hello world"] } });
    expect(command).toContain("-p 8053:53/udp");
    expect(command).toContain("-v data:/data");
    expect(formToPayload({ ...emptyForm(), ...parseRunIntoForm(command) }).entrypoint).toEqual(["/custom"]);
    expect(command.indexOf("--entrypoint /custom")).toBeLessThan(command.indexOf("alpine"));
    expect(command.split("\n").slice(-3).map((line) => line.trim().replace(/ \\$/, ""))).toEqual(["alpine", "fixed", "'hello world'"]);
  });

  it("quotes shell expansion, empty arguments and apostrophes literally", () => {
    expect(shellQuote("$(id);$HOME")).toBe("'$(id);$HOME'");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("it's")).toBe("'it'\"'\"'s'");
    const command = inspectToRunCmd({ Config: { Image: "alpine", Env: ["A=$(id)"] } }, {});
    expect(command).toContain("-e 'A=$(id)'");
    expect(formToPayload({ ...emptyForm(), ...parseRunIntoForm("docker run --entrypoint '' alpine") }).entrypoint).toEqual([]);
  });
});
