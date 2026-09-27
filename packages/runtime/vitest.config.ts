import { configDefaults, defineConfig } from 'vitest/config'

// SQLite and lock tests run against src/ in child processes and need no fixture build.
const FIXTURE_FREE = ['test/integration/sqlite.test.ts', 'test/integration/locks.test.ts']

export default defineConfig({
  test: {
    setupFiles: ['./test/support/scoped-temp.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      { extends: true, test: { name: 'sqlite', include: FIXTURE_FREE } },
      {
        extends: true,
        test: {
          name: 'fixture',
          include: ['test/integration/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...FIXTURE_FREE],
          // Vitest runs a project's global setup only when that project has selected files.
          globalSetup: ['./test/integration/global-setup.ts'],
        },
      },
    ],
  },
})
