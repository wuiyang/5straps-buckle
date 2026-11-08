import { mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'pathe'
import { z } from 'zod'
import { isRuntimeError, RuntimeErrorCode } from '@5straps/runtime'
import { withFileLock } from '@5straps/runtime/sqlite'
import { writeEnvironmentFile } from '../adapters/environment-file.js'
import { isInside } from '../domain/paths.js'
import { realPathOf } from './real-path.js'

/**
 * The environment files a node was set up, installed, or started with outside its state directory. Only the process
 * whose own environment names one knows it otherwise, so each process reads this record and protects every file in it,
 * a `buckle mcp` too, whose environment names none.
 */
const RECORD_NAME = 'environment-files.json'
const RecordSchema = z.object({ version: z.literal(1), files: z.array(z.string().refine(path => isAbsolute(path))) }).strict()

const LOCK_WAIT_MS = 5_000
const LOCK_POLL_MS = 25

export function environmentFilesPath(stateDirectory: string): string {
  return join(stateDirectory, RECORD_NAME)
}

/** The files the state directory records; none where it records none. A record that will not read refuses, as no file in it could be protected. */
export function recordedEnvironmentFiles(stateDirectory: string): string[] {
  const path = environmentFilesPath(stateDirectory)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return []
    throw new Error(`${path} cannot be read, so Buckle cannot tell which environment files to keep from tools`, { cause: error })
  }
  const parsed = RecordSchema.safeParse(parseJson(text))
  if (!parsed.success) throw new Error(`${path} is not a record of environment files Buckle reads: repair it, or remove it and start the node again, which records its file anew`)
  return parsed.data.files
}

/**
 * Adds a node's environment file to its state directory's record, under a lock. One inside the state directory where
 * each really is needs none, as it is protected with it; one named there through a link to a file outside is recorded.
 */
export async function recordEnvironmentFile(input: { stateDirectory: string; file: string }): Promise<void> {
  if (isInside(realPathOf(input.stateDirectory), realPathOf(input.file))) return
  mkdirSync(input.stateDirectory, { recursive: true, mode: 0o700 })
  const path = environmentFilesPath(input.stateDirectory)
  try {
    await withFileLock({ path: `${path}.lock.sqlite`, wait: { deadlineMs: LOCK_WAIT_MS, pollMs: LOCK_POLL_MS } }, async () => {
      const files = recordedEnvironmentFiles(input.stateDirectory)
      if (files.includes(input.file)) return
      writeEnvironmentFile(path, `${JSON.stringify({ version: 1, files: [...files, input.file] }, null, 2)}\n`)
    })
  } catch (error) {
    if (isRuntimeError(error, RuntimeErrorCode.lockBusy)) throw new Error(`Another buckle command is writing ${path}; try again once it finishes`, { cause: error })
    throw error
  }
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}
