import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    globalSetup: ['test/global-setup.ts'],
    // slow Windows runners
    testTimeout: process.platform === 'win32' ? 20000 : process.env.CI ? 15000 : 5000,
  },
});
