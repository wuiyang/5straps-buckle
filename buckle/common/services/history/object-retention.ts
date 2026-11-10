import type { Checkpoint } from './records.js'

/** The objects a restore of a retained checkpoint reads: each file's content where its checkpoint is restorable. */
export function checkpointObjectIds(records: Checkpoint[]): Set<string> {
  const named = new Set<string>()
  for (const record of records) {
    if (record.content !== 'blobs' || record.status !== 'pending' && record.restorable === false) continue
    for (const entry of [...Object.values(record.before), ...Object.values(record.after ?? {})]) if (entry.kind === 'file' && entry.hash) named.add(entry.hash)
  }
  return named
}

export function unreferencedObjectFilter(input: { records: Checkpoint[]; indexed: ReadonlySet<string> }): (id: string) => boolean {
  const named = checkpointObjectIds(input.records)
  return id => !named.has(id) && !input.indexed.has(id)
}
