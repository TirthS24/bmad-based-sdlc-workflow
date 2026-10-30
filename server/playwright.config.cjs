const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.cjs',
  globalSetup: './e2e/global-setup.cjs',
  workers: 1,
  retries: 0,
});
