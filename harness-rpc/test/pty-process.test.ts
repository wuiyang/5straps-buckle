import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { spawnPtyProcess } from '../common/adapters/pty-process.js'
import { nativeTerminal, runsNativeTerminal } from './support/native-terminal.js'

it.runIf(process.platform === 'linux' && process.env.CI === 'true')('loads the node-pty addon on Linux CI, where it must have built (review M8 of B20-B22)', () => {
  expect(nativeTerminal).toBe(true)
})

it.runIf(runsNativeTerminal)('preserves interactive shell state, streams output and exits through the native PTY adapter', async () => {
  const root = mkdtempSync('/tmp/buckle-pty-adapter-')
  mkdirSync(join(root, 'child'))
  const terminal = await spawnPtyProcess({ command: '/bin/bash', args: ['--noprofile', '--norc', '-i'], cwd: root,
    environment: { PATH: '/usr/bin:/bin', HOME: root, TERM: 'xterm-256color' }, cols: 80, rows: 24 })
  let output = '', exited = false
  terminal.onData(data => { output += data })
  terminal.onExit(() => { exited = true })
  try {
    terminal.write('cd child\rpwd\r')
    await expect.poll(() => output, { timeout: 5000 }).toContain(join(root, 'child'))
    terminal.resize(100, 40)
    terminal.write('printf "PTY_READY\\n"\r')
    await expect.poll(() => output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n').map(line => line.trim()), { timeout: 5000 }).toContain('PTY_READY')
    await terminal.stop()
    expect(exited).toBe(true)
  } finally { await terminal.stop(); rmSync(root, { recursive: true, force: true }) }
}, 15_000)
