import { configDefaults, defineConfig } from 'vitest/config'

/**
 * The HTTP tests run against the built package (test/support/global-build.ts). @5straps/runtime is
 * loaded natively, as the built app loads it, so both share one copy: its ALS stores and host slot.
 */
const HTTP = ['test/http/**/*.test.ts']

export default defineConfig({
  test: {
    setupFiles: ['./test/support/scoped-temp.ts'],
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/**/*.test.ts'], exclude: [...configDefaults.exclude, ...HTTP] } },
      {
        extends: true,
        test: {
          name: 'http',
          include: HTTP,
          // Vitest runs a project's global setup only when that project has selected files.
          globalSetup: ['./test/support/global-build.ts'],
          server: { deps: { external: [/\/packages\/runtime\//, /\/\.output(-2|-headless)?\//] } },
        },
      },
    ],
  },
})
