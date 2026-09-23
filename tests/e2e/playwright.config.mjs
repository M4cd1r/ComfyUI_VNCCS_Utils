import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.COMFYUI_URL || "http://localhost:8188";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.mjs/,
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 120_000,
  use: {
    baseURL,
    viewport: { width: 1600, height: 1000 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
