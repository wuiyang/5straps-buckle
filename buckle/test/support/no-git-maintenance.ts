import { afterAll } from 'vitest'

/**
 * Keeps git from starting maintenance in any repository a test file makes. A commit, a merge, or a push into a local
 * repository ends by running `git maintenance run --auto`. From git 2.47 that run detaches (`maintenance.autoDetach`
 * falls back to `gc.autoDetach`, and both default to true), so it can still hold `objects/maintenance.lock` and write in
 * the repository while the test goes on. A test that snapshots a .git folder, acts, and snapshots again then sees the
 * lock and the folder's time in one snapshot and not the other (CI on git 2.56, forge-pack.test.ts, the reftable push).
 *
 * Imported first, for its effect: git reads these pairs from GIT_CONFIG_COUNT ahead of every config file, in every git
 * the file's fixtures start. Buckle's own git children get their environment from `buildChildEnvironment`, which drops
 * every GIT_ variable, so none of this reaches the git a test runs through Buckle; those carry the same keys themselves
 * (`isolationConfig`).
 */
const KEYS: Array<[string, string]> = [
  ['maintenance.auto', 'false'],
  ['gc.auto', '0'],
  ['gc.autoDetach', 'false'],
  ['maintenance.autoDetach', 'false'],
]

const earlier = process.env.GIT_CONFIG_COUNT
const first = Number(earlier ?? '0') || 0
KEYS.forEach(([key, value], index) => {
  process.env[`GIT_CONFIG_KEY_${first + index}`] = key
  process.env[`GIT_CONFIG_VALUE_${first + index}`] = value
})
process.env.GIT_CONFIG_COUNT = String(first + KEYS.length)

afterAll(() => {
  KEYS.forEach((_, index) => {
    delete process.env[`GIT_CONFIG_KEY_${first + index}`]
    delete process.env[`GIT_CONFIG_VALUE_${first + index}`]
  })
  if (earlier === undefined) delete process.env.GIT_CONFIG_COUNT
  else process.env.GIT_CONFIG_COUNT = earlier
})
