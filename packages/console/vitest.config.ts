import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    conditions: ["source"],
    alias: {
      // Exact match so subpath exports such as /compose keep resolving.
      "@forgegraph/runtime$": fileURLToPath(
        new URL("../runtime/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    maxWorkers: process.env.CI ? 2 : undefined,
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
