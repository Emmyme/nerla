import { defineConfig, devices } from "@playwright/test"
import { API_URL, readRun, VITE_BIN, WEB_PORT, WEB_URL, WEBSITE_DIR, WEBSITE_OUT } from "./stack"

const ci = !!process.env.CI

export default defineConfig({
  testDir: ".",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  // Locally the dev stack shares the machine, and eight browsers at once stall its Docker Postgres past the website's timeouts
  workers: ci ? undefined : 4,
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: "auth.setup.ts" },
    { name: "chromium", testMatch: "journeys/**/*.spec.ts", dependencies: ["setup"], use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: [
    {
      name: "server",
      // From e2e/, which has no .env, and with every variable set, so nothing comes from the dev stack's .env
      command: "node --no-experimental-webstorage ../server/dist/index.js",
      env: readRun().server,
      url: `${API_URL}/health/ready`,
      reuseExistingServer: false,
      timeout: 60_000,
      stderr: "pipe",
    },
    {
      name: "website",
      command: `node --disable-warning=DEP0205 "${VITE_BIN}" preview --outDir ${WEBSITE_OUT} --port ${WEB_PORT} --strictPort`,
      cwd: WEBSITE_DIR,
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
