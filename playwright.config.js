import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const chromiumExecutable = [
  process.env.CHROMIUM_PATH,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].find((p) => p && existsSync(p));

export default defineConfig({
  testDir: './tests/e2e',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      maxDiffPixels: 0,
      scale: 'device',
      animations: 'allow',
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        ...(chromiumExecutable
          ? {
              launchOptions: {
                executablePath: chromiumExecutable,
                args: ['--no-sandbox'],
              },
            }
          : {}),
      },
    },
    {
      name: 'firefox',
      use: { browserName: 'firefox' },
    },
    {
      name: 'webkit',
      use: { browserName: 'webkit' },
    },
  ],
  webServer: {
    command: './node_modules/.bin/vite build && ./node_modules/.bin/vite preview --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});
