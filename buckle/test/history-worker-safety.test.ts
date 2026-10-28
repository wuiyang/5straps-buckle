import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { captureHashes, HistoryCaptureSafetyError } from '../common/services/history/capture-hashes.js'
const failure = vi.hoisted(() => ({ kind: 'start' }))
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
  constructor() {
    super()
    if (failure.kind === 'start') throw new Error('worker failed to start')
    queueMicrotask(() => this.emit(failure.kind, failure.kind === 'error' ? new Error('worker failed') : 1))
  }
} }))
afterEach(() => { failure.kind = 'start' })
for (const kind of ['start', 'error', 'exit']) it(`refuses an incomplete safety scan when the worker fails at ${kind}`, async () => {
  failure.kind = kind
  await expect(captureHashes({ roots: [], excluded: [], maxFileBytes: 32, hashFiles: false, platform: process.platform })).rejects.toBeInstanceOf(HistoryCaptureSafetyError)
})
