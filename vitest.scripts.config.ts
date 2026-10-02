import { defineConfig } from 'vitest/config'

// The tests of the release scripts under scripts/. This file is not named vitest.config.ts, so a bare
// `vitest` run inside a package never finds it by walking up; the root test:scripts script loads it.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
