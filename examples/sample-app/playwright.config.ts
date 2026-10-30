import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './E2E/tests',
  retries: 1,
  use: { baseURL: 'http://localhost:3100' },
  webServer: { command: 'node server.js', url: 'http://localhost:3100', reuseExistingServer: true },
});
