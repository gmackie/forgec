import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  timeout: 60000,
  use: {
    baseURL: process.env.CONSOLE_TEST_URL || "http://127.0.0.1:8787",
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
  },
});
