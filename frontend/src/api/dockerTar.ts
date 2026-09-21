// Streaming builder for a `docker load` compatible tar archive.
//
// Emits the OCI-layout + docker manifest.json layout (same shape the
// docker-save-browser project uses, which `docker load` accepts): oci-layout,
// index.json, manifest.json, repositories, and blobs/sha256/<hex> for the
// manifest, config and every layer. Layers stream straight from the registry
// into the tar with no buffering — the header size comes from the manifest
// descriptor, so a layer never has to be read to learn its length.

const enc = new TextEncoder();

export interface BuildInput {
  configHex: string;
  configBytes: Uint8Array;
  layers: { hex: string; size: number }[];
  repoTag: string | null;
  manifest: { mediaType: string; digest: string; size: number; bytes: Uint8Array };
  platform: { os: string; architecture: string; variant?: string };
  // Lazily opens layer `index`'s compressed blob stream (via the CF worker).
  openLayer: (index: number) => Promise<ReadableStream<Uint8Array>>;
}

export function hexOf(digest: string): string {
  const i = digest.indexOf(":");
  return i >= 0 ? digest.slice(i + 1) : digest;
}

// USTAR 512-byte header. Handles the name/prefix split for long paths.
export function tarHeader(name: string, size: number, typeflag = "0"): Uint8Array {
  const { name: entryName, prefix } = splitNamePrefix(name);
  const h = new Uint8Array(512);
  writeStr(h, 0, 100, entryName);
  writeOctal(h, 100, 8, 0o644);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, 0);
  h.fill(0x20, 148, 156); // checksum field is spaces while summing
  writeStr(h, 156, 1, typeflag);
  writeStr(h, 257, 6, "ustar");
  writeStr(h, 263, 2, "00");
  writeStr(h, 265, 32, "root");
  writeStr(h, 297, 32, "root");
  writeStr(h, 345, 155, prefix);
  let checksum = 0;
  for (const b of h) checksum += b;
  writeOctal(h, 148, 8, checksum);
  return h;
}

export function buildDockerLoadTar(input: BuildInput): ReadableStream<Uint8Array> {
  return streamFromAsyncGen(tarEntries(input));
}

async function* tarEntries(input: BuildInput): AsyncGenerator<Uint8Array> {
  const configPath = `blobs/sha256/${input.configHex}`;
  const manifestHex = hexOf(input.manifest.digest);

  // In-memory blobs (config + raw manifest) and each streamed layer.
  yield* bytesEntry(configPath, input.configBytes);
  yield* bytesEntry(`blobs/sha256/${manifestHex}`, input.manifest.bytes);
  const written = new Set<string>();
  for (let i = 0; i < input.layers.length; i++) {
    const layer = input.layers[i];
    // A manifest may list one blob several times; download and store it once.
    if (written.has(layer.hex)) continue;
    written.add(layer.hex);
    const src = await input.openLayer(i);
    yield* streamEntry(`blobs/sha256/${layer.hex}`, layer.size, src);
  }

  const repoTags = input.repoTag ? [input.repoTag] : [];
  const manifestJson = JSON.stringify([
    {
      Config: configPath,
      RepoTags: repoTags,
      Layers: input.layers.map((l) => `blobs/sha256/${l.hex}`),
    },
  ]);
  const indexJson = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: input.manifest.mediaType,
        digest: input.manifest.digest,
        size: input.manifest.size,
        // containerd names the image from io.containerd.image.name; ref.name alone is only the tag.
        ...(input.repoTag ? { annotations: {
          "io.containerd.image.name": fullImageName(input.repoTag),
          "org.opencontainers.image.ref.name": tagOf(input.repoTag),
        } } : {}),
        platform: {
          os: input.platform.os,
          architecture: input.platform.architecture,
          ...(input.platform.variant ? { variant: input.platform.variant } : {}),
        },
      },
    ],
  });
  const repositories = JSON.stringify(
    input.repoTag ? { [repoOf(input.repoTag)]: { [tagOf(input.repoTag)]: input.configHex } } : {},
  );

  yield* bytesEntry("oci-layout", enc.encode(JSON.stringify({ imageLayoutVersion: "1.0.0" })));
  yield* bytesEntry("index.json", enc.encode(indexJson));
  yield* bytesEntry("manifest.json", enc.encode(manifestJson));
  yield* bytesEntry("repositories", enc.encode(repositories));

  yield new Uint8Array(1024); // two zero blocks terminate the archive
}

async function* bytesEntry(name: string, bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield tarHeader(name, bytes.byteLength);
  yield bytes;
  yield* padding(bytes.byteLength);
}

async function* streamEntry(name: string, size: number, src: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  yield tarHeader(name, size);
  const reader = src.getReader();
  let written = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      written += value.byteLength;
      if (written > size) {
        throw new Error(`layer ${name} longer than declared size ${size}`);
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
  if (written !== size) {
    throw new Error(`layer ${name} was ${written} bytes, declared ${size}`);
  }
  yield* padding(size);
}

function* padding(size: number): Generator<Uint8Array> {
  const pad = (512 - (size % 512)) % 512;
  if (pad > 0) yield new Uint8Array(pad);
}

function streamFromAsyncGen(gen: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await gen.next();
        if (done) controller.close();
        else if (value.byteLength > 0) controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await gen.return?.(undefined as never);
    },
  });
}

// repoTag like "nginx:1.27" or "ghcr.io:443/o/r:tag" — split at the LAST colon,
// but only when that colon is in the final path segment (a tag, not a port).
function tagOf(repoTag: string): string {
  const slash = repoTag.lastIndexOf("/");
  const colon = repoTag.lastIndexOf(":");
  return colon > slash ? repoTag.slice(colon + 1) : "latest";
}

// "nginx:1.27" → "docker.io/library/nginx:1.27" (Docker's normalized form).
export function fullImageName(repoTag: string): string {
  const repo = repoOf(repoTag);
  const first = repo.split("/")[0];
  const hasHost = repo.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  if (hasHost) return `${repo}:${tagOf(repoTag)}`;
  return `docker.io/${repo.includes("/") ? repo : `library/${repo}`}:${tagOf(repoTag)}`;
}

function repoOf(repoTag: string): string {
  const slash = repoTag.lastIndexOf("/");
  const colon = repoTag.lastIndexOf(":");
  return colon > slash ? repoTag.slice(0, colon) : repoTag;
}

function splitNamePrefix(name: string): { name: string; prefix: string } {
  if (enc.encode(name).byteLength <= 100) return { name, prefix: "" };
  const parts = name.split("/");
  while (parts.length > 1) {
    const entryName = parts.pop() as string;
    const prefix = parts.join("/");
    if (enc.encode(entryName).byteLength <= 100 && enc.encode(prefix).byteLength <= 155) {
      return { name: entryName, prefix };
    }
  }
  throw new Error(`tar path too long: ${name}`);
}

function writeStr(target: Uint8Array, offset: number, length: number, value: string): void {
  target.set(enc.encode(value).subarray(0, length), offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const raw = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, "0");
  writeStr(target, offset, length - 1, raw);
  target[offset + length - 1] = 0;
}
