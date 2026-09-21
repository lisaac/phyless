import { describe, expect, it } from "vitest";
import { buildDockerLoadTar, fullImageName, tarHeader, type BuildInput } from "./dockerTar";

const enc = new TextEncoder();
const dec = new TextDecoder();

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

interface ParsedEntry {
  name: string;
  size: number;
  content: Uint8Array;
  checksumOk: boolean;
}

// Minimal USTAR reader for assertions only.
function parseTar(buf: Uint8Array): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  let off = 0;
  while (off + 512 <= buf.byteLength) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = readStr(header, 0, 100);
    const size = parseInt(readStr(header, 124, 12).trim() || "0", 8);
    const storedChecksum = parseInt(readStr(header, 148, 8).replace(/\0.*$/, "").trim() || "0", 8);
    const recompute = header.slice();
    recompute.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of recompute) sum += b;
    off += 512;
    const content = buf.subarray(off, off + size);
    entries.push({ name, size, content, checksumOk: sum === storedChecksum });
    off += Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readStr(b: Uint8Array, start: number, len: number): string {
  const slice = b.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return dec.decode(nul >= 0 ? slice.subarray(0, nul) : slice);
}

function baseInput(overrides: Partial<BuildInput> = {}): BuildInput {
  const configBytes = enc.encode('{"architecture":"amd64","os":"linux"}');
  const manifestBytes = enc.encode('{"schemaVersion":2}');
  const layerA = enc.encode("layer-A-bytes");
  const layerB = enc.encode("layer-BB-bytes!!");
  return {
    configHex: "c".repeat(64),
    configBytes,
    layers: [
      { hex: "a".repeat(64), size: layerA.byteLength },
      { hex: "b".repeat(64), size: layerB.byteLength },
    ],
    repoTag: "nginx:1.27",
    manifest: { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: "sha256:" + "d".repeat(64), size: manifestBytes.byteLength, bytes: manifestBytes },
    platform: { os: "linux", architecture: "amd64" },
    openLayer: async (i) => streamOf(i === 0 ? layerA : layerB),
    ...overrides,
  };
}

describe("tarHeader", () => {
  it("encodes size and a valid checksum", () => {
    const h = tarHeader("blobs/sha256/abc", 1234);
    expect(readStr(h, 0, 100)).toBe("blobs/sha256/abc");
    expect(parseInt(readStr(h, 124, 12).trim(), 8)).toBe(1234);
    const [entry] = parseTar(new Uint8Array([...h, ...new Uint8Array(512), ...new Uint8Array(1024)]));
    expect(entry.checksumOk).toBe(true);
  });
});

describe("buildDockerLoadTar", () => {
  it("emits blobs then metadata in order with correct sizes", async () => {
    const buf = await collect(buildDockerLoadTar(baseInput()));
    const entries = parseTar(buf);
    expect(entries.map((e) => e.name)).toEqual([
      `blobs/sha256/${"c".repeat(64)}`,
      `blobs/sha256/${"d".repeat(64)}`,
      `blobs/sha256/${"a".repeat(64)}`,
      `blobs/sha256/${"b".repeat(64)}`,
      "oci-layout",
      "index.json",
      "manifest.json",
      "repositories",
    ]);
    for (const e of entries) {
      expect(e.checksumOk).toBe(true);
      expect(e.content.byteLength).toBe(e.size);
    }
    expect(dec.decode(entries[2].content)).toBe("layer-A-bytes");

    const manifest = JSON.parse(dec.decode(entries[6].content));
    expect(manifest[0].Config).toBe(`blobs/sha256/${"c".repeat(64)}`);
    expect(manifest[0].RepoTags).toEqual(["nginx:1.27"]);
    expect(manifest[0].Layers).toEqual([`blobs/sha256/${"a".repeat(64)}`, `blobs/sha256/${"b".repeat(64)}`]);

    const repositories = JSON.parse(dec.decode(entries[7].content));
    expect(repositories).toEqual({ nginx: { "1.27": "c".repeat(64) } });
  });

  it("names the image for containerd with the normalized reference", async () => {
    const entries = parseTar(await collect(buildDockerLoadTar(baseInput())));
    const index = JSON.parse(dec.decode(entries[5].content));
    expect(index.manifests[0].annotations).toEqual({
      "io.containerd.image.name": "docker.io/library/nginx:1.27",
      "org.opencontainers.image.ref.name": "1.27",
    });
    expect(fullImageName("ghcr.io/me/app:1")).toBe("ghcr.io/me/app:1");
    expect(fullImageName("me/app:2")).toBe("docker.io/me/app:2");
    expect(fullImageName("localhost:5000/app:3")).toBe("localhost:5000/app:3");
  });

  it("terminates with two zero blocks", async () => {
    const buf = await collect(buildDockerLoadTar(baseInput()));
    expect(buf.subarray(buf.byteLength - 1024).every((b) => b === 0)).toBe(true);
  });

  it("aborts when a layer is shorter than its declared size", async () => {
    const input = baseInput({
      layers: [{ hex: "a".repeat(64), size: 999 }],
      openLayer: async () => streamOf(enc.encode("short")),
    });
    await expect(collect(buildDockerLoadTar(input))).rejects.toThrow(/declared 999/);
  });

  it("aborts when a layer is longer than its declared size", async () => {
    const input = baseInput({
      layers: [{ hex: "a".repeat(64), size: 2 }],
      openLayer: async () => streamOf(enc.encode("toolong")),
    });
    await expect(collect(buildDockerLoadTar(input))).rejects.toThrow(/longer than declared/);
  });
});
