import { defineConfig, devices } from "@playwright/test";
import { BASE } from "./scripts/site.mjs";

// The e2e tests run against the built site (npm run build) under its real base path.
const port = Number(process.env.CV_E2E_PORT ?? 4173);
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "test/e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: origin + BASE,
    trace: "retain-on-failure",
    acceptDownloads: true,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: `npx vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: origin + BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
