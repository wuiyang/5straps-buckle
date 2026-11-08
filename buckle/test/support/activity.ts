import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { workspaceStateKey } from '../../common/domain/workspace-key.js'
import type { BuckleConfig } from '../../common/runtime/config.js'
import { openHistoryActivity } from '../../common/services/history/activity.js'

/**
 * Records activity in the workspace now, as the runtime's ledger does at each ask it records, for a test that writes asks
 * straight into the ledger: otherwise the idle check before a decision reads the workspace as never active, and ends them.
 */
export async function recordActivity(config: Pick<BuckleConfig, 'stateDirectory' | 'cwd'>): Promise<void> {
  const directory = join(config.stateDirectory, 'history', workspaceStateKey(config.cwd))
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const activity = await openHistoryActivity(directory)
  try { activity.touch(Date.now()) } finally { await activity.close() }
}
