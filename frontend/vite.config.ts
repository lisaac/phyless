import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { execSync } from "node:child_process";

function gitHash(): string {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", { cwd: __dirname }).toString().trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  plugins: [solid()],
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ")),
    __GIT_HASH__: JSON.stringify(gitHash()),
  },
  build: { outDir: "dist" },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
