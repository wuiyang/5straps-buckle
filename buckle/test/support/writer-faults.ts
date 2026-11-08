import { closeSync, constants, openSync } from 'node:fs'
import { createActionLogWriter, type ActionLogWriter } from '../../common/adapters/action-log/action-log-writer.js'

/**
 * The cells of the shared memory a test steers the fault worker by: a gate at 0 holds every sync or write until it is 1
 * again, the counters count the worker starts and the syncs and writes begun, and a fault cell names the sync or write
 * it strikes (0 none).
 */
export const FAULT = { syncGate: 0, writeGate: 1, syncs: 2, writes: 3, exitAtSync: 4, failAtSync: 5, shortAtWrite: 6, blockAtSync: 7, starts: 8 } as const
const CELLS = Object.keys(FAULT).length

/** `fifo`: a named pipe a blocked sync opens to read, so it waits in the kernel until the test opens it to write. */
export interface FaultData { cells: Int32Array; fifo?: string }

export interface FaultyWriter {
  writer: ActionLogWriter
  stall(): void
  release(): void
  holdWrites(): void
  releaseWrites(): void
  syncs(): number
  writes(): number
  /** How many worker threads this writer started. */
  starts(): number
  /** Ends the worker at the nth sync from now. */
  endAtSync(nth: number): void
  /** The nth sync from now fails as a disk error would. */
  failAtSync(nth: number): void
  /** The nth write from now stops halfway, as a full disk or a killed process leaves it. */
  shortAtWrite(nth: number): void
  /** The nth sync from now waits in the kernel, opening the writer's `fifo`, until `unblock`. */
  blockAtSync(nth: number): void
  unblock(): void
}

const WORKER = new URL('./writer-worker-faults.ts', import.meta.url)
const opened: ActionLogWriter[] = []

/** A writer on its own fault worker, so two of them stand for two processes, each with its own lock and turn. */
export function faultyWriter(options: { fifo?: string } = {}): FaultyWriter {
  const cells = new Int32Array(new SharedArrayBuffer(CELLS * Int32Array.BYTES_PER_ELEMENT))
  cells[FAULT.syncGate] = 1
  cells[FAULT.writeGate] = 1
  const writer = createActionLogWriter({ entry: { url: WORKER, workerData: { cells, ...options } satisfies FaultData } })
  opened.push(writer)
  const open = (gate: number) => {
    Atomics.store(cells, gate, 1)
    Atomics.notify(cells, gate)
  }
  const strike = (cell: number, counter: number, nth: number) => Atomics.store(cells, cell, Atomics.load(cells, counter) + nth)
  return {
    writer,
    stall: () => Atomics.store(cells, FAULT.syncGate, 0),
    release: () => open(FAULT.syncGate),
    holdWrites: () => Atomics.store(cells, FAULT.writeGate, 0),
    releaseWrites: () => open(FAULT.writeGate),
    syncs: () => Atomics.load(cells, FAULT.syncs),
    writes: () => Atomics.load(cells, FAULT.writes),
    starts: () => Atomics.load(cells, FAULT.starts),
    endAtSync: nth => strike(FAULT.exitAtSync, FAULT.syncs, nth),
    failAtSync: nth => strike(FAULT.failAtSync, FAULT.syncs, nth),
    shortAtWrite: nth => strike(FAULT.shortAtWrite, FAULT.writes, nth),
    blockAtSync: nth => strike(FAULT.blockAtSync, FAULT.syncs, nth),
    unblock: () => { if (options.fifo) openToWrite(options.fifo) },
  }
}

// Non-blocking, so it never waits itself: with no reader held in the pipe it fails, and there is nothing to end.
function openToWrite(fifo: string): void {
  try {
    closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK))
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENXIO')) throw error
  }
}

/** Stops every fault worker the test started; held ones too, as their waits are short. */
export async function closeFaultyWriters(): Promise<void> {
  await Promise.all(opened.splice(0).map(writer => writer.close({ deadlineMs: 0 })))
}
