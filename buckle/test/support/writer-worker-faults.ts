import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs'
import { workerData } from 'node:worker_threads'
import { startWriterWorker } from '../../common/adapters/action-log/writer-files.js'
import { FAULT, type FaultData } from './writer-faults.js'

/** The action log's writer worker on a disk a test steers through shared memory (`FAULT`). */
const { cells, fifo } = workerData as FaultData
Atomics.add(cells, FAULT.starts, 1)

// Short waits, so terminate() ends a held worker.
function waitOpen(gate: number): void {
  while (Atomics.load(cells, gate) === 0) Atomics.wait(cells, gate, 0, 20)
}

startWriterWorker({
  write(descriptor, bytes) {
    const nth = Atomics.add(cells, FAULT.writes, 1) + 1
    waitOpen(FAULT.writeGate)
    return writeSync(descriptor, nth === Atomics.load(cells, FAULT.shortAtWrite) ? bytes.subarray(0, Math.floor(bytes.length / 2)) : bytes)
  },
  fsync(descriptor) {
    const nth = Atomics.add(cells, FAULT.syncs, 1) + 1
    if (nth === Atomics.load(cells, FAULT.exitAtSync)) process.exit(1)
    if (nth === Atomics.load(cells, FAULT.failAtSync)) throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' })
    // Held in the kernel, as a disk that stopped answering holds a sync: terminate() cannot end the thread here.
    if (nth === Atomics.load(cells, FAULT.blockAtSync) && fifo) closeSync(openSync(fifo, 'r'))
    waitOpen(FAULT.syncGate)
    fsyncSync(descriptor)
  },
})
