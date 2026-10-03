import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    conditions: ["source"],
    alias: {
      "@forgegraph/runtime": fileURLToPath(
        new URL("../runtime/src/index.ts", import.meta.url),
      ),
    },
  },
  test: { include: ["test/**/*.test.{ts,tsx}"] },
});
