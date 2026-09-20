import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Scenarios share one remote database; run files and tests sequentially.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
