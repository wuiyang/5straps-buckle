import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { isRuntimeError, RuntimeErrorCode } from '@5straps/runtime'
import { acquireFileLock } from '@5straps/runtime/sqlite'
import { z } from 'zod'
import { STATE_BUSY } from '../../adapters/json-file-store.js'
import type { ServiceFailure } from '../../types/service-failure.js'

export const OWNER_LOCK_WAIT_MS = 3_000
const holderSchema = z.object({ nonce: z.string(), pid: z.number().int().positive(), startedAt: z.string(), label: z.string() })
type Holder = z.infer<typeof holderSchema>

export class HistoryBusyError extends Error implements ServiceFailure {
  readonly code = STATE_BUSY
  readonly status = 503
}

export function readHistoryHolder(directory: string): Holder | undefined {
  try { return holderSchema.parse(JSON.parse(readFileSync(join(directory, 'execution.holder.json'), 'utf8'))) }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw new HistoryBusyError('The execution lock holder record is unreadable; inspect the node before retrying', { cause: error }) }
}

function processGone(pid: number): boolean {
  try { process.kill(pid, 0); return false }
  catch (error) { return error instanceof Error && 'code' in error && error.code === 'ESRCH' }
}

export async function withHistoryLock<T>(input: { directory: string; label: string; deadlineMs: number; signal?: AbortSignal; force?: boolean }, operation: () => Promise<T>): Promise<T> {
  const file = join(input.directory, 'execution.holder.json')
  if (input.force) {
    const holder = readHistoryHolder(input.directory)
    if (holder && !processGone(holder.pid)) throw new HistoryBusyError(`Cannot force a live lock: pid ${holder.pid}, started ${holder.startedAt}, label ${holder.label}`)
  }
  let lock
  try {
    lock = await acquireFileLock({ path: join(input.directory, 'execution.lock.sqlite'), wait: { deadlineMs: input.deadlineMs, pollMs: 25 }, ...(input.signal ? { signal: input.signal } : {}) })
  } catch (error) {
    if (!isRuntimeError(error, RuntimeErrorCode.lockBusy)) throw error
    const holder = readHistoryHolder(input.directory)
    const held = holder ? `pid ${holder.pid}, started ${holder.startedAt}, label ${holder.label}` : 'an unknown process'
    throw new HistoryBusyError(`History is busy with ${held}; retry shortly. Use --force only if the holder process is gone`, { cause: error })
  }
  const holder: Holder = { nonce: randomUUID(), pid: process.pid, startedAt: new Date().toISOString(), label: input.label }
  try {
    writeFileSync(file, JSON.stringify(holder), { mode: 0o600 })
    return await operation()
  } finally {
    try { if (readHistoryHolder(input.directory)?.nonce === holder.nonce) rmSync(file) }
    finally { await lock.release() }
  }
}
