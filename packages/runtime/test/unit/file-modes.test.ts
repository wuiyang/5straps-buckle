import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLogger, createRotatingFileSink, isRuntimeError, type LogEvent } from '../../src/index.js'
import { hasFileModes, looseMode, setMode } from '../../src/internal/file-modes.js'
import { assertOwnerOnlyDirectory, openDatabase, SqliteErrorCode } from '../../src/sqlite/index.js'

// Windows keeps no POSIX modes: Node reports 0o666 there and chmod sets only the read-only flag. These tests
// imitate it on Linux through the platform each helper takes, process.platform by default.

const modeOf = (path: string) => statSync(path).mode & 0o777

function pathWithMode(kind: 'file' | 'directory', mode: number): string {
  const path = join(mkdtempSync(join(tmpdir(), 'modes-')), kind === 'file' ? 'file' : 'directory')
  if (kind === 'file') writeFileSync(path, '')
  else mkdirSync(path)
  chmodSync(path, mode)
  return path
}

/** process.platform, which every helper reads by default, reads `platform` while `run` runs. */
async function onPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...original, value: platform })
  try {
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

describe('file modes on Windows, imitated', () => {
  it('neither reads nor changes a mode on win32, and does both elsewhere', () => {
    expect(hasFileModes('win32')).toBe(false)
    const file = pathWithMode('file', 0o644)
    setMode(file, 0o600, 'win32')
    expect(modeOf(file)).toBe(0o644)
    expect(looseMode(file, 'win32')).toBeUndefined()
    for (const platform of ['linux', 'darwin'] as const) {
      expect(hasFileModes(platform)).toBe(true)
      chmodSync(file, 0o644)
      expect(looseMode(file, platform)).toBe(0o644)
      setMode(file, 0o600, platform)
      expect(modeOf(file)).toBe(0o600)
    }
  })

  it('passes an open state directory on win32 whatever its mode, and still refuses it on Linux and macOS', () => {
    for (const mode of [0o777, 0o755, 0o700]) expect(() => assertOwnerOnlyDirectory(pathWithMode('directory', mode), 'win32')).not.toThrow()
    const open = pathWithMode('directory', 0o755)
    for (const platform of ['linux', 'darwin'] as const) {
      let refused: unknown
      try { assertOwnerOnlyDirectory(open, platform) } catch (error) { refused = error }
      expect(isRuntimeError(refused, SqliteErrorCode.directoryNotOwnerOnly)).toBe(true)
      expect((refused as Error).message).toContain(`chmod 700 ${open}`)
    }
  })

  it('opens a database on win32 in an open directory, required owner-only or not, with no chmod and no warning', async () => {
    const events: LogEvent[] = []
    const logs = createLogger({ component: 'sqlite', sinks: [{ name: 'memory', write: (event) => { events.push(event) } }] })
    const directory = pathWithMode('directory', 0o755)
    const path = join(directory, 'credentials.sqlite')
    writeFileSync(path, '', { mode: 0o644 })
    chmodSync(path, 0o644)
    for (const requireOwnerOnlyDirectory of [true, false]) {
      const db = await onPlatform('win32', () => openDatabase({ path, requireOwnerOnlyDirectory, logger: logs.logger }))
      await db.dispose()
    }
    await logs.flush()
    expect(events).toEqual([])
    expect(modeOf(directory)).toBe(0o755)
    expect(modeOf(path)).toBe(0o644)
    const refused = await openDatabase({ path, requireOwnerOnlyDirectory: true }).catch((error: unknown) => error)
    expect(isRuntimeError(refused, SqliteErrorCode.directoryNotOwnerOnly)).toBe(true)
  })

  it('leaves a new log file as Windows made it on win32, and narrows it elsewhere', async () => {
    const event: LogEvent = { timestamp: new Date(0).toISOString(), level: 'info', component: 'test', message: 'line' }
    for (const [platform, mode] of [['win32', 0o644], ['linux', 0o600]] as const) {
      const path = pathWithMode('file', 0o644)
      await onPlatform(platform, async () => { await createRotatingFileSink({ path, maxBytes: 1_000, maxFiles: 2 }).write(event) })
      expect(modeOf(path)).toBe(mode)
    }
  })
})
