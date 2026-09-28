import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRuntimeError, RuntimeErrorCode } from '@5straps/runtime'
import { acquireFileLock, type FileLock } from '@5straps/runtime/sqlite'
import { z } from 'zod'
import { WorkbenchIdSchema, WorkbenchRecordSchema, type WorkbenchRecord } from '@5straps/protocol'
import type { ServiceFailure } from '../../types/service-failure.js'

export class WorkbenchError extends Error implements ServiceFailure {
  readonly code = 'WORKBENCH_REFUSED'
  constructor(message: string, readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 503 = 409) { super(message) }
}
export const StoredWorkbenchSchema = WorkbenchRecordSchema.extend({ tokenHash: z.string(), policyHash: z.string() })
export type StoredWorkbench = z.infer<typeof StoredWorkbenchSchema>
export function workbenchHash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
export function publicWorkbench(record: StoredWorkbench): WorkbenchRecord {
  const { tokenHash: _token, policyHash: _policy, ...value } = record
  return structuredClone(value)
}
export function writeWorkbenchJson(path: string, value: unknown): void {
  const temporary = path + '.' + randomUUID() + '.tmp'
  const descriptor = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(descriptor, JSON.stringify(value)); fsyncSync(descriptor) } finally { closeSync(descriptor) }
  renameSync(temporary, path)
}
export function createWorkbenchStorage(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700)
  let lock: Promise<FileLock> | undefined
  // True for the call that took ownership; the lock is held until close().
  async function own(): Promise<boolean> {
    if (lock) {
      await lock
      return false
    }
    lock = acquireOwnership()
    await lock
    return true
  }
  async function acquireOwnership(): Promise<FileLock> {
    try {
      return await acquireFileLock({ path: join(directory, 'manager.lock.sqlite'), wait: 'none' })
    } catch (error) {
      lock = undefined
      if (isRuntimeError(error, RuntimeErrorCode.lockBusy)) throw new WorkbenchError('Workbench execution is owned by another Buckle process')
      throw error
    }
  }
  function location(id: string): string { WorkbenchIdSchema.parse(id); return join(directory, id) }
  function read(id: string): StoredWorkbench {
    const file = join(location(id), 'state.json')
    if (!existsSync(file)) throw new WorkbenchError('Workbench not found', 404)
    return StoredWorkbenchSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  }
  function list(): StoredWorkbench[] {
    return readdirSync(directory).filter(id => WorkbenchIdSchema.safeParse(id).success && existsSync(join(directory, id, 'state.json'))).map(read)
  }
  return { own, location, read, list,
    save(record: StoredWorkbench) {
      mkdirSync(location(record.id), { recursive: true, mode: 0o700 })
      writeWorkbenchJson(join(location(record.id), 'state.json'), record)
    },
    async close() {
      const held = lock
      lock = undefined
      await held?.then(owned => owned.release(), () => undefined)
    },
  }
}
