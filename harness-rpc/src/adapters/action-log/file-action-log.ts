import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { logger } from '../../logger.js'
import type { ActionLog, ActionLogEntry } from '../../ports/action-log.js'

/**
 * Append-only JSONL. Writes are synchronous and one line at a time, because every CLI
 * invocation is its own process: a line torn by a killed process costs one entry, not the file.
 *
 * The file grows without bound on purpose. Rotating an audit log means deciding which evidence
 * to destroy, which is the operator's call rather than Buckle's.
 */
export function createFileActionLog(filePath: string): ActionLog {
  return {
    record(entry) {
      try {
        mkdirSync(dirname(filePath), { recursive: true })
        appendFileSync(filePath, `${JSON.stringify(entry)}\n`)
      } catch (error) {
        // Losing the record must not also lose the call it describes, so this reports and returns.
        logger.error('Could not write the action log', {
          filePath,
          message: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    },

    read(limit) {
      const lines = readLines(filePath)
      const entries: ActionLogEntry[] = []
      let unreadable = 0

      for (const line of lines.slice(-limit)) {
        const entry = parseEntry(line)
        if (entry) entries.push(entry)
        else unreadable += 1
      }
      if (unreadable > 0) logger.warn('Skipped unreadable action log lines', { filePath, unreadable })
      return entries
    },
  }
}

function readLines(filePath: string): string[] {
  try {
    return readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function parseEntry(line: string): ActionLogEntry | null {
  try {
    return JSON.parse(line) as ActionLogEntry
  } catch {
    return null
  }
}
