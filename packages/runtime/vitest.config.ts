import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./test/support/scoped-temp.ts'],
    // Builds dist and the Nitro fixture once; integration tests run against that built output.
    globalSetup: ['./test/integration/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
