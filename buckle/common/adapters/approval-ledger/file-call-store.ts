import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { askedCallSchema, type AskedCall } from '../../domain/approval/asked-call.js'
import { isPlainName } from '../../domain/paths.js'

const CALL_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/

/**
 * The whole calls of waiting asks, one 0600 file per request group in a 0700 directory beside approvals.json,
 * written before the index names it and removed once no waiting ask names it (review M5).
 */
interface CallFiles {
  write(id: string, text: string): void
  /** The group's whole call, or why its file could not be read; logs nothing, so a pass says it once (callsRead). */
  read(id: string): { call: AskedCall } | { failure: string }
  /** The file's size in bytes, or undefined when it is missing: one stat, no read. */
  size(id: string): number | undefined
  remove(ids: Iterable<string>): void
  /** Removes every call file no waiting ask names; run under the queue's lock. */
  prune(named: ReadonlySet<string>): void
  /** Whether any call file, or a temporary one, is left that no waiting ask names. */
  unnamed(named: ReadonlySet<string>): boolean
}

export function createCallFiles(directory: string): CallFiles {
  const pathOf = (id: string) => join(directory, `${id}.json`)
  return {
    write(id, text) {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const temporary = join(directory, `${id}.${randomUUID()}.tmp`)
      try {
        const descriptor = openSync(temporary, 'wx', 0o600)
        try {
          writeFileSync(descriptor, text)
          fsyncSync(descriptor)
        } finally {
          closeSync(descriptor)
        }
        renameSync(temporary, pathOf(id))
      } finally {
        rmSync(temporary, { force: true })
      }
    },
    read(id) {
      try {
        return { call: askedCallSchema.parse(JSON.parse(readFileSync(pathOf(id), 'utf8'))) }
      } catch (error) {
        // Shown as recorded before this build: denied or re-sent, never approved from a part.
        return { failure: error instanceof Error ? error.name : 'Unknown error' }
      }
    },
    size: id => statSync(pathOf(id), { throwIfNoEntry: false })?.size,
    remove(ids) {
      for (const id of ids) rmSync(pathOf(id), { force: true })
    },
    prune(named) {
      for (const name of leftOver(named)) rmSync(join(directory, name), { force: true })
    },
    unnamed: named => leftOver(named).length > 0,
  }

  function leftOver(named: ReadonlySet<string>): string[] {
    let names: string[]
    try {
      names = readdirSync(directory)
    } catch {
      return []
    }
    return names.filter((name) => {
      if (!isPlainName(name)) return false
      const id = CALL_FILE.exec(name)?.[1]
      return (id !== undefined && !named.has(id)) || name.endsWith('.tmp')
    })
  }
}
