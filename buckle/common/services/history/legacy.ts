import { existsSync } from 'node:fs'
import { join } from 'pathe'
import { DatabaseSync } from 'node:sqlite'
import { checkpointSchema, type Checkpoint } from './records.js'

export function readLegacyHistory(directory: string): Checkpoint[] {
  const file = join(directory, 'history.sqlite')
  if (!existsSync(file)) return []
  // The old store is opened read-only: recovery metadata lives in the new journal.
  const connection = new DatabaseSync(file, { readOnly: true })
  try { return connection.prepare('SELECT data FROM checkpoints ORDER BY rowid').all().map(row => ({ ...checkpointSchema.parse(JSON.parse(String(row.data))), legacy: true, restorable: false, reason: 'Legacy SQLite history is readable; content restoration requires a new host git checkpoint' })) }
  finally { connection.close() }
}
