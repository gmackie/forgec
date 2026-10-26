import { defineConfig } from "vitest/config";
// One file at a time: each links acme (87 scripts) and the workerd test starts Miniflare.
// In CI every test is printed with its duration, so a slow run shows which tests slowed (FORG-51).
export default defineConfig({ resolve: { conditions: ["source"] }, test: { include: ["test/**/*.test.ts"], reporters: process.env.CI ? ["verbose"] : ["default"], testTimeout: 180_000, hookTimeout: 600_000, fileParallelism: false } });
