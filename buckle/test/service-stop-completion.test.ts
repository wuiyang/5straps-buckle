import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, expect, it } from 'vitest'
import { serviceDirectory } from '../common/domain/node-service-paths.js'
import { runningNode, waitForStop } from '../common/services/node-service/serve-record.js'
import { SPAWN_TEST_TIMEOUT_MS } from './spawn-timeout.js'

const states: string[] = []
afterEach(() => { for (const state of states.splice(0)) rmSync(state, { recursive: true, force: true }) })

it('waits for the original service process to exit after it releases ownership', async () => {
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-stop-completion-')))
  states.push(state)
  mkdirSync(serviceDirectory(state), { mode: 0o700 })
  const script = [
    `import { acquireFileLock } from ${JSON.stringify(import.meta.resolve('@5straps/runtime/sqlite'))}`,
    `const lock = await acquireFileLock({ path: process.argv[1], wait: 'none' })`,
    `process.stdin.once('data', async () => { await lock.release(); process.stdout.write('released\\n') })`,
    `process.stdin.once('end', () => process.exit(0))`,
    `process.stdin.resume()`,
    `process.stdout.write('held\\n')`,
  ].join('\n')
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, join(serviceDirectory(state), 'serve.lock.sqlite')], { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = createInterface({ input: child.stdout })
  const exited = once(child, 'exit')
  const nextLine = () => Promise.race([
    once(lines, 'line').then(([line]) => String(line)),
    exited.then(() => { throw new Error('Stop fixture exited before its gate') }),
  ])
  try {
    expect(await nextLine()).toBe('held')
    const pid = child.pid!
    expect(await runningNode(state)).toEqual({ record: null })
    const released = nextLine()
    child.stdin.write('release\n')
    expect(await released).toBe('released')
    expect(await runningNode(state)).toBeNull()
    expect(child.exitCode).toBeNull()
    expect(process.kill(pid, 0)).toBe(true)
    expect(await waitForStop(state, 0)).toBe(true)
    expect(await waitForStop(state, 0, pid)).toBe(false)

    child.stdin.end()
    expect(await exited).toEqual([0, null])
    expect(await waitForStop(state, 0, pid)).toBe(true)
  } finally {
    try {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    } finally { lines.close() }
  }
}, SPAWN_TEST_TIMEOUT_MS)
