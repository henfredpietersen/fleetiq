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
  use: { baseURL: `http://localhost:${PORT}`, trace: "off" },
  projects: [
    // Mobile-first: driver portal targets mid-range phones.
    {
      name: "mobile",
      use: { ...devices["Pixel 5"], launchOptions: { executablePath } },
    },
  ],
  webServer: {
    command: `npm run build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    env: {
      FLEETIQ_COMPANY_ID: "00000000-0000-4000-8000-0000000000e2",
      AUTH_SERVER_SECRET: "integration-test-secret-".padEnd(40, "x"),
    },
    timeout: 180_000,
  },
});
