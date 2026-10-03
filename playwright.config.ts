import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: 'test-results',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    actionTimeout: 15_000,
    browserName: 'chromium',
    channel: 'chromium',
    viewport: { width: 1120, height: 800 },
    deviceScaleFactor: 1,
    storageState: { cookies: [], origins: [] },
    trace: { mode: 'retain-on-failure', screenshots: false, snapshots: true, sources: true },
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader'] },
  },
});
