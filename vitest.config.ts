import { defineConfig } from 'vitest/config';

/**
 * Separate from vite.config.ts on purpose.
 *
 * The extension build config carries the SDK's plugin, which asserts that the
 * built bundle matches `manifest.main` and `manifest.styles`. Vitest loads
 * vite.config.ts when no vitest config exists, so the tests inherited that
 * assertion and failed whenever dist/ was absent. Locally dist/ usually exists
 * from an earlier build, so it only ever failed on a clean checkout.
 *
 * The tests do not need the extension bundling at all, so they get their own
 * config rather than a conditional in the build one.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
