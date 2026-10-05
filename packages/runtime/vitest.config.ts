import { defineConfig } from "vitest/config";
export default defineConfig({ resolve: { conditions: ["source"] }, test: { include: ["test/**/*.test.ts"], testTimeout: process.env["FORGE_FOUNDATION_PG_URL"] ? 30000 : 5000 } });
