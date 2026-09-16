import { defineConfig } from "vite";
import baseConfig from "./vite.config";

const appImport = 'import { Router, Route, Navigate } from "@solidjs/router";';
const taskStart = `  persist();
  if (t.meta?.type === "browser-pull")`;

const demoPlugin = {
  name: "phyless-static-demo",
  enforce: "pre" as const,
  transformIndexHtml() {
    return [{ tag: "script", attrs: { src: "./phyless-demo.js" }, injectTo: "head-prepend" as const }];
  },
  transform(code: string, id: string) {
    const path = id.replaceAll("\\", "/");
    if (path.endsWith("/src/App.tsx")) {
      if (!code.includes(appImport) || !code.includes("<Router>") || !code.includes("</Router>")) {
        throw new Error("Demo router overlay must run before Solid compiles App.tsx");
      }
      return code
        .replace(appImport, 'import { HashRouter, Route, Navigate } from "@solidjs/router";')
        .replaceAll("<Router>", "<HashRouter>")
        .replaceAll("</Router>", "</HashRouter>");
    }
    if (path.endsWith("/src/stores/taskQueue.ts")) {
      if (!code.includes(taskStart)) throw new Error("Task queue start changed; update the demo mock overlay");
      return code.replace(taskStart, `  persist();
  const demo = (window as any).__phylessDemo;
  if (demo) {
    Promise.resolve(demo.runTask(t)).then(
      () => settle(id, "done"),
      (error) => settle(id, "error", error instanceof Error ? error.message : String(error)),
    );
    return;
  }
  if (t.meta?.type === "browser-pull")`);
    }
  },
};

export default defineConfig({
  ...baseConfig,
  base: "./",
  plugins: [demoPlugin, ...(baseConfig.plugins ?? [])],
  build: { ...(baseConfig.build ?? {}), outDir: "demo-dist", emptyOutDir: true },
});
