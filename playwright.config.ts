import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests in a real browser against an isolated copy of the app
 * (see apps/api/e2e/server.ts). Runs beside the dev servers on other ports.
 *   npm run test:e2e
 */
const API_PORT = 4100;
const WEB_PORT = 5273;
const WEB = `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Tests share one seeded database and build on each other's data.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/, dependencies: ['auth'] },
    { name: 'auth', testMatch: /01-auth\.spec/ },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: /mobile\.spec|01-auth\.spec|auth\.setup/, dependencies: ['setup'] },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec|zz-screens/, dependencies: ['desktop'] },
  ],
  webServer: [
    {
      command: 'npx tsx e2e/server.ts',
      cwd: 'apps/api',
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      env: { E2E_API_PORT: String(API_PORT), E2E_WEB_ORIGIN: WEB },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
    },
    {
      command: 'npx vite',
      cwd: 'apps/web',
      url: WEB,
      env: { WEB_PORT: String(WEB_PORT), API_TARGET: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
