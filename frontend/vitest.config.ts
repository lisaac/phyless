import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: [],
  },
  resolve: { conditions: ["development", "browser"] },
});
