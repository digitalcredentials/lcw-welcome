import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PORT) || 4317;

export default defineConfig({
  testDir: './tests',
  use: { baseURL: `http://localhost:${port}` },
  projects: [
    { name: 'Chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'Firefox', use: { ...devices['Desktop Firefox'] } },
  ],
  // Serves dist/ (build it first: `npm test` does)
  webServer: { command: 'node scripts/serve.mjs', url: `http://localhost:${port}`, reuseExistingServer: false },
});
