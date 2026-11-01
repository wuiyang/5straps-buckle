import { existsSync } from 'node:fs'
import { join } from 'pathe'
import { withReadOnlyDatabase } from '@5straps/runtime/sqlite'
import { checkpointSchema, type Checkpoint } from './records.js'

/** Why a checkpoint of the SQLite history, kept before the shadow-git engine, is listed and never restored (Slice F2, item 7). */
export const LEGACY_REASON = 'This checkpoint is from the SQLite history of an earlier Buckle, which history lists but cannot restore'

export function readLegacyHistory(directory: string): Checkpoint[] {
  const file = join(directory, 'history.sqlite')
  if (!existsSync(file)) return []
  return withReadOnlyDatabase({ path: file, read: connection => connection.prepare('SELECT data FROM checkpoints ORDER BY rowid').all().map(row => ({ ...checkpointSchema.parse(JSON.parse(String(row.data))), legacy: true, restorable: false, reason: LEGACY_REASON })) })
}
