// Child process for the multi-process SQLite tests. Reports progress as JSON lines on stdout.
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { acquireFileLock, createConnectionOwner, openDatabase } from '../../../src/sqlite/index.js'

const [mode, path, ...rest] = process.argv.slice(2)
if (!mode || !path) throw new Error('usage: sqlite-worker <mode> <path> [...]')

function report(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function allocateSequence(count: number, worker: string): Promise<void> {
  const owner = createConnectionOwner(await openDatabase({ path: path! }), { owned: true })
  for (let index = 0; index < count; index += 1) {
    await owner.transaction(async (tx) => {
      const { rows } = await tx.sql`SELECT COALESCE(MAX(value), 0) AS value FROM sequence`
      const next = Number((rows?.[0] as { value: number }).value) + 1
      await tx.sql`INSERT INTO sequence (value, worker) VALUES (${next}, ${worker})`
    })
  }
  await owner.close()
  report({ done: count })
}

// Holds for <ms>, or with 'stdin' until the parent writes a line.
async function holdLock(release: string): Promise<void> {
  const lock = await acquireFileLock({ path: path!, wait: 'none' })
  report({ locked: true })
  if (release === 'stdin') await releaseRequested()
  else await delay(Number(release))
  await lock.release()
  report({ released: true })
}

async function releaseRequested(): Promise<void> {
  const lines = createInterface({ input: process.stdin })
  await once(lines, 'line')
  lines.close()
  process.stdin.destroy()
}

// Reports whether another owner holds the lock right now; used to prove the parent's lock survived.
async function tryLock(): Promise<void> {
  try {
    const lock = await acquireFileLock({ path: path!, wait: 'none' })
    await lock.release()
    report({ busy: false })
  } catch (error) {
    report({ busy: (error as { code?: string }).code === 'LockBusyError' })
  }
}

if (mode === 'sequence') await allocateSequence(Number(rest[0]), rest[1] ?? String(process.pid))
else if (mode === 'hold-lock') await holdLock(rest[0] ?? '0')
else if (mode === 'try-lock') await tryLock()
else throw new Error(`unknown mode ${mode}`)
