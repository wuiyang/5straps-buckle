import { existsSync } from 'node:fs'
import { join } from 'pathe'
import { withReadOnlyDatabase } from '@5straps/runtime/sqlite'
import { checkpointSchema, type Checkpoint } from './records.js'

export function readLegacyHistory(directory: string): Checkpoint[] {
  const file = join(directory, 'history.sqlite')
  if (!existsSync(file)) return []
  return withReadOnlyDatabase({ path: file, read: connection => connection.prepare('SELECT data FROM checkpoints ORDER BY rowid').all().map(row => ({ ...checkpointSchema.parse(JSON.parse(String(row.data))), legacy: true, restorable: false, reason: 'Legacy SQLite history is readable; content restoration requires a new host git checkpoint' })) })
}
