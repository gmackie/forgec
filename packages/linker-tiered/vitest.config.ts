import { defineConfig } from "vitest/config";
// One file at a time: each links acme (87 scripts) and the workerd test starts Miniflare.
export default defineConfig({ resolve: { conditions: ["source"] }, test: { include: ["test/**/*.test.ts"], testTimeout: 180_000, hookTimeout: 600_000, fileParallelism: false } });
