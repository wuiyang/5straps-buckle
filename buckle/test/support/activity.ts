import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { workspaceStateKey } from '../../common/domain/workspace-key.js'
import type { GrantHolder } from '../../common/domain/permission/grant-holder.js'
import type { BuckleConfig } from '../../common/runtime/config.js'
import { openHistoryActivity } from '../../common/services/history/activity.js'

/**
 * Records the session's activity now, as the runtime's ledger does at each ask it records, for a test that writes asks
 * straight into the ledger: otherwise the idle check before a decision reads the session as never active, and ends it.
 */
export async function recordActivity(config: Pick<BuckleConfig, 'stateDirectory' | 'cwd'>, session: GrantHolder): Promise<void> {
  const directory = join(config.stateDirectory, 'history', workspaceStateKey(config.cwd))
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const activity = await openHistoryActivity(directory)
  try { activity.touch(session, Date.now()) } finally { await activity.close() }
}
