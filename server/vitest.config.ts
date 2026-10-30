import { defineConfig } from 'vitest/config';

/**
 * Standalone config so vitest does not walk up into the frontend's Vite
 * config (which pulls in the React plugin and its deprecation warnings).
 * Unit tests must stay DB-free — anything needing MySQL belongs in `npm run e2e`.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    clearMocks: true,
    reporters: ['default'],
  },
});
