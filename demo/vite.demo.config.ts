import { defineConfig, mergeConfig } from "vite";
import baseConfig from "./vite.config";

const appImport = 'import { Router, Route, Navigate } from "@solidjs/router";';
const taskStart = `  persist();
  if (t.meta?.type === "browser-pull")`;

export default mergeConfig(baseConfig, defineConfig({
  base: "./",
  plugins: [{
    name: "phyless-static-demo",
    enforce: "pre",
    transformIndexHtml() {
      return [{ tag: "script", attrs: { src: "./phyless-demo.js" }, injectTo: "head-prepend" }];
    },
    transform(code, id) {
      const path = id.replaceAll("\\", "/");
      if (path.endsWith("/src/App.tsx")) {
        if (!code.includes(appImport)) throw new Error("Router import changed; update the demo HashRouter overlay");
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
  }],
  build: { outDir: "demo-dist", emptyOutDir: true },
}));
