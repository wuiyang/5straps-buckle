import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serviceLogPath } from '../common/domain/node-service-paths.js'
import { runServiceCommand } from '../cli/service.js'

// Fix brief 1, H6: `buckle service logs` renders for a person only where stdout is a terminal (the CLI display slice,
// C6), so the entry hands the command whether it is one.

describe('the entry of buckle service', () => {
  const before = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const stored = '{"timestamp":"2026-11-10T12:34:56.000Z","level":"info","component":"buckle","message":"fixture service log"}\n'
  let state: string | undefined
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), 'buckle-service-entry-'))
    mkdirSync(join(state, 'logs'))
    writeFileSync(serviceLogPath(state), stored)
    vi.stubEnv('BUCKLE_STATE_DIR', state)
    vi.stubEnv('BUCKLE_ENV_FILE', '')
    vi.stubEnv('BUCKLE_LOG_FORMAT', undefined)
    vi.stubEnv('TZ', 'UTC')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    if (before) Object.defineProperty(process.stdout, 'isTTY', before)
    else Reflect.deleteProperty(process.stdout, 'isTTY')
    if (state !== undefined) rmSync(state, { recursive: true, force: true })
    state = undefined
  })

  it.each([true, false])('hands the command whether stdout is a terminal: %s', async (isTTY) => {
    Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true, writable: true })
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await runServiceCommand(['logs'])).toEqual({ exitCode: 0 })
    expect(output.mock.calls.map(([text]) => String(text)).join('')).toBe(isTTY
      ? '--- 2026-11-10 ---\n12:34:56 [info] fixture service log\n'
      : stored)
  })
})
