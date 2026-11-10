import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, expect, it } from 'vitest'
import { serviceDirectory } from '../common/domain/node-service-paths.js'
import { runningNode, waitForStop } from '../common/services/node-service/serve-record.js'
import { SPAWN_TEST_TIMEOUT_MS } from './spawn-timeout.js'
import { hasExecutable } from './support/executable.js'

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

it.skipIf(process.platform !== 'linux' || !hasExecutable('python3'))('recognises an unreaped Linux zombie as an exited service process', async () => {
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-stop-zombie-')))
  states.push(state)
  const script = [
    'import os, sys',
    'pid = os.fork()',
    'if pid == 0:',
    '    try:',
    "        with open('/proc/self/comm', 'w') as name:",
    "            name.write('buckle) (test')",
    '    finally:',
    '        os._exit(0)',
    'try:',
    '    os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)',
    '    print(pid, flush=True)',
    '    sys.stdin.readline()',
    'finally:',
    '    _, status = os.waitpid(pid, 0)',
    "    print('reaped:' + str(status), flush=True)",
  ].join('\n')
  const parent = spawn('python3', ['-u', '-c', script], { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = createInterface({ input: parent.stdout })
  const exited = once(parent, 'exit')
  const nextLine = () => Promise.race([
    once(lines, 'line').then(([line]) => String(line)),
    exited.then(() => { throw new Error('Zombie fixture exited before its gate') }),
  ])
  try {
    const pid = Number(await nextLine())
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
    expect(readFileSync(`/proc/${pid}/stat`, 'utf8')).toContain(`(buckle) (test) Z ${parent.pid} `)
    expect(process.kill(pid, 0)).toBe(true)
    expect(await runningNode(state)).toBeNull()
    expect(await waitForStop(state, 0, pid)).toBe(true)
  } finally {
    try {
      const reaped = nextLine()
      parent.stdin.end('reap\n')
      expect(await reaped).toBe('reaped:0')
      expect(await exited).toEqual([0, null])
    } finally { lines.close() }
  }
}, SPAWN_TEST_TIMEOUT_MS)
