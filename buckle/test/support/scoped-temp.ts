import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

/**
 * Points tmpdir() at a directory owned by this test file and removes it afterwards, so a fixture
 * made with mkdtemp(tmpdir()) no longer outlives the run. The system temp directory is remembered
 * once per worker, because a worker runs several files and each one moves TMPDIR.
 */
const systemTemp = process.env.BUCKLE_TEST_SYSTEM_TMPDIR ??= tmpdir()
const scope = mkdtempSync(join(systemTemp, 'buckle-test-'))
process.env.TMPDIR = scope

afterAll(() => {
  process.env.TMPDIR = systemTemp
  rmSync(scope, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
