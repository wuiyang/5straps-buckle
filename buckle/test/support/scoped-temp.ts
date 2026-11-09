import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { closeLogService } from '../../common/adapters/action-log/log-service.js'
import { LOG_CLOSE_DEADLINE_MS } from '../../common/runtime/log-budget.js'
import { plainTempRoot } from './plain-temp.js'

/**
 * Points tmpdir() at a directory owned by this test file and removes it afterwards, so a fixture
 * made with mkdtemp(tmpdir()) no longer outlives the run. The system temp directory is remembered
 * once per worker, because a worker runs several files and each one moves TMPDIR. The directory is made
 * under a root with plain lowercase names, so log redaction keeps its paths readable. Cleanup waits for the log service's held
 * writes first, so none lands in the folder while it is removed.
 */
const systemTemp = process.env.BUCKLE_TEST_SYSTEM_TMPDIR ??= tmpdir()
const scope = mkdtempSync(join(plainTempRoot(systemTemp), 'buckle-test-'))
process.env.TMPDIR = scope
// Tests read stderr's log format by the TTY rule alone, whatever a developer's shell exports (fix brief 1, H8).
delete process.env.BUCKLE_LOG_FORMAT

afterAll(async () => {
  await closeLogService({ deadlineMs: LOG_CLOSE_DEADLINE_MS })
  process.env.TMPDIR = systemTemp
  rmSync(scope, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
