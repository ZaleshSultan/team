import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/auth.integration.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
