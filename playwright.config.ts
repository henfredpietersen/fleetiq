import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
// Optional local override when the pre-installed browser build differs from this
// Playwright version. CI installs its own browser and leaves this unset.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"]] : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "off",
    screenshot: "only-on-failure",
    // Without a bound, a click on a missing or disabled element waits for the whole test timeout and the log only says
    // "Test timeout exceeded". Bounded actions fail in seconds and name the locator.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    // Mobile-first: driver portal targets mid-range phones.
    // The in-app camera (4B) needs frames: Chromium's fake capture device produces a test pattern and the fake UI flag
    // auto-accepts the permission prompt. A "permission denied" run overrides getUserMedia in the page itself.
    {
      name: "mobile",
      use: {
        ...devices["Pixel 5"],
        permissions: ["camera", "geolocation"],
        geolocation: { latitude: -26.2041, longitude: 28.0473 },
        launchOptions: {
          executablePath,
          args: [
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
          ],
        },
      },
    },
  ],
  webServer: {
    // Server output (build + next start) goes to .check/webserver.log, not into the test log: a failing assertion must never
    // be buried under server warnings. CI uploads the file with the Playwright report when the e2e step fails.
    command: `mkdir -p .check && (npm run build && npx next start -p ${PORT}) > .check/webserver.log 2>&1`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    env: {
      FLEETIQ_COMPANY_ID: "00000000-0000-4000-8000-0000000000e2",
      AUTH_SERVER_SECRET: "integration-test-secret-".padEnd(40, "x"),
    },
    timeout: 180_000,
  },
});
