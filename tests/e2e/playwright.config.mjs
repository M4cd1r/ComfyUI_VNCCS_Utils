import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.COMFYUI_URL || "http://localhost:8188";
// Optional: reuse a preinstalled Chromium instead of the version pinned by @playwright/test.
const launchOptions = process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {};

const SHARED_SETTINGS_SPECS = [/standalone-setting\.spec\.mjs/, /feature-toggles\.spec\.mjs/];

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
  // Specs that switch shared, server-side ComfyUI settings (the standalone tab, feature toggles)
  // would hide UI from specs running in another worker: they run one at a time, after the rest.
  projects: [
    { name: "chromium", testIgnore: SHARED_SETTINGS_SPECS, use: { ...devices["Desktop Chrome"], launchOptions } },
    { name: "shared-settings", testMatch: SHARED_SETTINGS_SPECS, dependencies: ["chromium"], fullyParallel: false, workers: 1,
      use: { ...devices["Desktop Chrome"], launchOptions } },
  ],
});
