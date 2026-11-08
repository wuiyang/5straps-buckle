import { fsyncSync } from 'node:fs'
import { workerData } from 'node:worker_threads'
import { startWriterWorker } from '../../common/adapters/action-log/writer-files.js'

/**
 * The action log's writer worker on a disk a test steers through shared memory: `gate` 0 holds every sync until it is
 * 1 again, `exits` 1 ends the worker at its next sync, and `syncs` counts the syncs it made.
 */
export interface WriterFaults { gate: Int32Array; exits: Int32Array; syncs: Int32Array }

const faults = workerData as WriterFaults

startWriterWorker({
  fsync(descriptor) {
    Atomics.add(faults.syncs, 0, 1)
    if (Atomics.load(faults.exits, 0) === 1) process.exit(1)
    // Short waits, so terminate() ends a held worker.
    while (Atomics.load(faults.gate, 0) === 0) Atomics.wait(faults.gate, 0, 0, 20)
    fsyncSync(descriptor)
  },
})
