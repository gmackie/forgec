import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
  root: "web",
  plugins: [react()],
  resolve: {
    alias: {
      // Bundle the runtime from TypeScript. The package export points at dist,
      // which a console-only dev server has not built.
      "@forgegraph/runtime": fileURLToPath(
        new URL("../runtime/src/index.ts", import.meta.url),
      ),
    },
  },
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
});
