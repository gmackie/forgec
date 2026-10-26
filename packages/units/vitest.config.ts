import { defineConfig } from "vitest/config";
// In CI every test is printed with its duration, so a slow run shows which tests slowed (FORG-51).
export default defineConfig({ test: { include: ["test/**/*.test.ts"], reporters: process.env.CI ? ["verbose"] : ["default"], testTimeout: 60_000 } });
