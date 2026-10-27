import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    globalSetup: ['test/global-setup.ts'],
    // slow and busy runners
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
