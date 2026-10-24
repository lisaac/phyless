import { describe, expect, it } from "vitest";
import { layerCmd } from "./LayerTable";

describe("layerCmd", () => {
  it("strips builder noise", () => {
    expect(layerCmd('/bin/sh -c #(nop)  CMD ["nginx" "-g"]')).toBe('CMD ["nginx" "-g"]');
    expect(layerCmd("/bin/sh -c #(nop) ADD file:abc in / ")).toBe("ADD file:abc in /");
    expect(layerCmd("/bin/sh -c apt-get update")).toBe("RUN apt-get update");
    expect(layerCmd("RUN /bin/sh -c apk add curl # buildkit")).toBe("RUN apk add curl");
    expect(layerCmd("COPY app /app # buildkit")).toBe("COPY app /app");
    expect(layerCmd("RUN |1 V=2 /bin/sh -c make # buildkit")).toBe("RUN |1 V=2 /bin/sh -c make");
  });
});
