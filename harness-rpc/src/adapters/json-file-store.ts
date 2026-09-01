import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { z } from 'zod'
import { logger } from '../logger.js'

export interface JsonFileStore<T> {
  read(): T
  write(value: T): void
}

/** Shared read/persist for Buckle's small state files: grants, plugins, pending approvals. */
export function createJsonFileStore<T>(input: {
  filePath: string
  schema: z.ZodType<T>
  fallback: T
}): JsonFileStore<T> {
  return {
    read() {
      try {
        const parsed = input.schema.safeParse(JSON.parse(readFileSync(input.filePath, 'utf8')))
        if (parsed.success) return parsed.data
        logger.warn('Ignoring malformed state file', { filePath: input.filePath })
        return input.fallback
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return input.fallback
        logger.warn('Could not read state file', {
          filePath: input.filePath,
          message: error instanceof Error ? error.message : 'Unknown error',
        })
        return input.fallback
      }
    },

    write(value) {
      mkdirSync(dirname(input.filePath), { recursive: true })
      writeFileSync(input.filePath, `${JSON.stringify(value, null, 2)}\n`)
    },
  }
}
