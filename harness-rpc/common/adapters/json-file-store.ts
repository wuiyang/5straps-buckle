import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ZodError, type z } from 'zod'
import { logger } from '../runtime/logger.js'

/** A state file that exists but cannot be used; the message names the file and the invalid fields, never a value. */
export class StateFileError extends Error {}

export interface JsonFileStore<T> {
  read(): T
  write(value: T): void
  update<R>(change: (state: T) => R): R
}

export function createJsonFileStore<T>(input: { filePath: string; schema: z.ZodType<T>; fallback: T }): JsonFileStore<T> {
  function read(): T {
    try {
      return input.schema.parse(JSON.parse(readFileSync(input.filePath, 'utf8')))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return structuredClone(input.fallback)
      const fields = invalidFields(error)
      logger.error('State file cannot be read safely', { filePath: input.filePath, ...(fields ? { fields } : {}) })
      throw new StateFileError(`State file is unreadable or invalid: ${input.filePath}${fields ? ` at ${fields}` : ''}; owner repair is required`, { cause: error })
    }
  }

  function locked<R>(operation: () => R): R {
    mkdirSync(dirname(input.filePath), { recursive: true, mode: 0o700 })
    // SQLite supplies an OS-released cross-process lock; JSON remains the data format.
    const lock = new DatabaseSync(`${input.filePath}.lock.sqlite`, { timeout: 5_000 })
    try {
      lock.exec('BEGIN IMMEDIATE')
      const result = operation()
      lock.exec('COMMIT')
      return result
    } finally {
      lock.close()
    }
  }

  function persist(value: T): void {
    const validated = input.schema.parse(value)
    const temporary = `${input.filePath}.${randomUUID()}.tmp`
    try {
      const descriptor = openSync(temporary, 'wx', 0o600)
      try {
        writeFileSync(descriptor, `${JSON.stringify(validated, null, 2)}\n`)
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      renameSync(temporary, input.filePath)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  return {
    read,
    write: value => locked(() => persist(value)),
    update: change => locked(() => {
      const state = read()
      const result = change(state)
      persist(state)
      return result
    }),
  }
}

// Field paths only: a value in a state file can be a credential.
function invalidFields(error: unknown): string | undefined {
  if (!(error instanceof ZodError)) return undefined
  return [...new Set(error.issues.map(issue => issue.path.join('.') || '(root)'))].join(', ')
}
