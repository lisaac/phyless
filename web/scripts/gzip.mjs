// Replace dist/assets/*.{js,css} with .gz so only the compressed bytes are
// embedded; the Go server serves them as-is or inflates for clients without
// gzip support (internal/api/server.go spaHandler). Node stdlib only.
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const dir = new URL("../dist/assets/", import.meta.url).pathname;
for (const f of readdirSync(dir)) {
  if (!/\.(js|css)$/.test(f)) continue;
  const p = join(dir, f);
  writeFileSync(p + ".gz", gzipSync(readFileSync(p), { level: 9 }));
  unlinkSync(p);
}
