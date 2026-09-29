import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AuditUnavailableError, createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { createAuditHealth } from '../common/services/audit/audit-health.js'
import { summarizeEffect } from '../common/domain/effect.js'
import { collectPrefixed } from '../common/domain/environment.js'
import { redactArguments } from '../common/domain/redact.js'
import type { ActionLogEntry } from '../common/types/ports/action-log.js'

function logPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'buckle-log-')), 'actions.jsonl')
}

function entry(overrides: Partial<ActionLogEntry> = {}): ActionLogEntry {
  return {
    event: 'result',
    at: '2026-09-02T00:00:00.000Z',
    requestId: 'r1',
    sessionId: 's1',
    tool: 'fs_read',
    outcome: 'ok',
    durationMs: 3,
    effects: ['read /work/app.ts'],
    args: { path: 'app.ts' },
    ...overrides,
  }
}

describe('the file action log', () => {
  it('creates the directory it needs and appends one line per action', async () => {
    const path = logPath()
    const log = createFileActionLog(path)
    await log.record(entry({ requestId: 'r1' }))
    await log.record(entry({ requestId: 'r2' }))

    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2)
    expect(log.read(10).map(item => item.requestId)).toEqual(['r1', 'r2'])
  })

  it('returns the most recent entries when asked for fewer than it holds', async () => {
    const log = createFileActionLog(logPath())
    for (const requestId of ['r1', 'r2', 'r3']) await log.record(entry({ requestId }))
    expect(log.read(2).map(item => item.requestId)).toEqual(['r2', 'r3'])
  })

  it('reads as empty rather than throwing when nothing has been recorded', () => {
    expect(createFileActionLog(logPath()).read(10)).toEqual([])
  })

  it('keeps the readable entries when a line was torn by a killed process', async () => {
    const path = logPath()
    const log = createFileActionLog(path)
    await log.record(entry({ requestId: 'r1' }))
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"requestId":"r2","tru`)

    expect(log.read(10).map(item => item.requestId)).toEqual(['r1'])
    await log.record(entry({ requestId: 'r3' }))
    expect(log.read(10).map(item => item.requestId)).toEqual(['r1', 'r3'])
  })

  it('records a refusal as fully as a success, so a denial leaves evidence', async () => {
    const log = createFileActionLog(logPath())
    await log.record(entry({
      outcome: 'denied',
      tool: 'fs_read',
      effects: ['read /home/user/.ssh/id_rsa'],
      asked: ['sensitive_path:/home/user/.ssh/id_rsa'],
      detail: 'PERMISSION_DENIED: reading a credential file needs approval',
    }))

    const [recorded] = log.read(1)
    expect(recorded?.outcome).toBe('denied')
    expect(recorded?.asked).toEqual(['sensitive_path:/home/user/.ssh/id_rsa'])
    expect(recorded?.detail).toContain('credential file')
  })
})

describe('redactArguments', () => {
  it('leaves paths and commands readable, which is the point of the log', () => {
    expect(redactArguments({ path: 'src/app.ts', args: ['build', '--watch'] }))
      .toEqual({ path: 'src/app.ts', args: ['build', '--watch'] })
  })

  it('replaces a value whose key is named like a credential', () => {
    expect(redactArguments({ url: 'https://api.example.com', apiKey: 'sk-live-1234' }))
      .toEqual({ url: 'https://api.example.com', apiKey: '[redacted]' })
  })

  it('replaces file contents with a length, so a write does not copy the file into the log', () => {
    const content = 'x'.repeat(5000)
    expect(redactArguments({ path: 'secrets.txt', content })).toEqual({
      path: 'secrets.txt',
      content: '[5000 characters]',
    })
  })

  it('redacts inside nested structures', () => {
    expect(redactArguments({ files: [{ path: 'a.ts', token: 'abc' }] }))
      .toEqual({ files: [{ path: 'a.ts', token: '[redacted]' }] })
  })

  it('caps a long array instead of recording every element', () => {
    const result = redactArguments({ paths: Array.from({ length: 30 }, (_, index) => `f${index}.ts`) })
    const paths = (result as { paths: string[] }).paths
    expect(paths).toHaveLength(21)
    expect(paths.at(-1)).toBe('[10 more]')
  })

  it('stops descending before a deeply nested object can bloat the entry', () => {
    let nested: Record<string, unknown> = { value: 'deep' }
    for (let depth = 0; depth < 10; depth += 1) nested = { nested }
    expect(JSON.stringify(redactArguments(nested as never))).toContain('[nested]')
  })
})

describe('summarizeEffect', () => {
  it('names every effect kind in a form a person can check', () => {
    expect(summarizeEffect({ kind: 'read_path', path: '/w/a.ts', directory: '/w' })).toBe('read /w/a.ts')
    expect(summarizeEffect({ kind: 'write_path', path: '/w/b.ts', directory: '/w' })).toBe('write /w/b.ts')
    expect(summarizeEffect({ kind: 'network', url: new URL('https://example.com/x') }))
      .toBe('network https://example.com/x')
    expect(summarizeEffect({ kind: 'exec', command: 'rm', args: ['-rf', 'build'] })).toBe('exec rm -rf build')
    expect(summarizeEffect({ kind: 'process_probe' })).toBe('process probe')
  })
})

describe('collectPrefixed', () => {
  it('takes every variable under the prefix and nothing else', () => {
    expect(collectPrefixed({ AGENT_BROWSER_HEADED: 'true', AGENT_BROWSER_PROXY: 'p', OTHER: 'x' }, 'AGENT_BROWSER_'))
      .toEqual({ AGENT_BROWSER_HEADED: 'true', AGENT_BROWSER_PROXY: 'p' })
  })

  it('anchors at the start, so a variable merely containing the prefix is left out', () => {
    expect(collectPrefixed({ MY_AGENT_BROWSER_X: 'x' }, 'AGENT_BROWSER_')).toEqual({})
  })

  it('skips variables with no value rather than forwarding undefined', () => {
    expect(collectPrefixed({ AGENT_BROWSER_A: undefined, AGENT_BROWSER_B: 'b' }, 'AGENT_BROWSER_'))
      .toEqual({ AGENT_BROWSER_B: 'b' })
  })
})

describe('durable audit pages', () => {
  it('pages newest first without skipping records across cursors', async () => {
    const log = createFileActionLog(logPath())
    for (const requestId of ['r1', 'r2', 'r3', 'r4', 'r5']) await log.record(entry({ requestId }))
    const first = log.page({ limit: 2 })
    const second = log.page({ limit: 2, before: Number(first.nextCursor) })
    const third = log.page({ limit: 2, before: Number(second.nextCursor) })
    expect([...first.entries, ...second.entries, ...third.entries].map(item => item.requestId)).toEqual(['r5', 'r4', 'r3', 'r2', 'r1'])
    expect(third.nextCursor).toBeNull()
  })

  it('leaves out a line from before attempt and result entries, rather than returning it as stored', async () => {
    const path = logPath()
    const log = createFileActionLog(path)
    await log.record(entry({ requestId: 'r1' }))
    const { event: _dropped, ...legacy } = entry({ requestId: 'r2', args: { token: 'stored-before-redaction' } })
    writeFileSync(path, `${readFileSync(path, 'utf8')}${JSON.stringify(legacy)}\n`)
    await log.record(entry({ requestId: 'r3' }))

    expect(log.page({ limit: 10 }).entries.map(item => item.requestId)).toEqual(['r3', 'r1'])
  })

  it('refuses recording when durable storage is unavailable, as a 503 failure that names no path, and reports it until a write succeeds again', async () => {
    const file = logPath()
    writeFileSync(file, 'not a directory')
    const health = createAuditHealth()
    const broken = join(file, 'actions.jsonl')
    const refused = createFileActionLog(broken, { health }).record(entry())
    await expect(refused).rejects.toBeInstanceOf(AuditUnavailableError)
    await expect(refused).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE', status: 503 })
    await expect(refused).rejects.not.toThrow(file)
    expect(health.available).toBe(false)
    expect(health.failing(broken)).toBe(true)
    // Health is kept per log (review M2 of B18-B19): another log writing does not clear this one.
    await createFileActionLog(logPath(), { health }).record(entry())
    expect(health.available).toBe(false)
    rmSync(file)
    await createFileActionLog(broken, { health }).record(entry())
    expect(health.available).toBe(true)
  })

  it('probes a failing log again at most once per interval, and clears it once the probe opens the log (review M2 of B18-B19)', async () => {
    const file = logPath()
    writeFileSync(file, 'not a directory')
    let now = 0
    const health = createAuditHealth({ now: () => now, probeIntervalMs: 2_000 })
    const broken = join(file, 'actions.jsonl')
    await expect(createFileActionLog(broken, { health }).record(entry())).rejects.toBeInstanceOf(AuditUnavailableError)
    await health.recheck()
    expect(health.available).toBe(false)
    rmSync(file)
    now = 1_999
    await health.recheck()
    expect(health.available).toBe(false)
    now = 2_000
    await health.recheck()
    expect(health.available).toBe(true)
    // The probe opens the log for append and writes no entry, and leaves no sidecar behind.
    expect(readFileSync(broken, 'utf8')).toBe('')
    expect(existsSync(`${broken}.probe`)).toBe(false)
    // The last failure stays for the owner's status after the repair (review M4 of B20-B22).
    expect(health.lastFailureAt(broken)).toBe(new Date(0).toISOString())
  })

  it('keeps a log failing while its pending store is corrupt, though the log itself opens, until the store is repaired (review M4 of B20-B22)', async () => {
    const path = logPath()
    let now = 0
    const health = createAuditHealth({ now: () => now, probeIntervalMs: 1 })
    const log = createFileActionLog(path, { health, workspaceId: 'child' })
    // An attempt is tracked in the pending store until its result lands.
    await log.record(entry({ requestId: 'fine', auditId: 'a1', event: 'attempt' }))
    writeFileSync(`${path}.pending.json`, '{ corrupt')
    await expect(log.record(entry({ requestId: 'refused', auditId: 'a2', event: 'attempt' }))).rejects.toBeInstanceOf(AuditUnavailableError)
    expect(health.failingWorkspaces()).toEqual(['child'])
    for (const at of [5, 10]) {
      now = at
      await health.recheck()
      expect(health.failing(path)).toBe(true)
    }
    expect(health.lastFailureAt(path)).toBe(new Date(10).toISOString())
    rmSync(`${path}.pending.json`)
    now = 20
    await health.recheck()
    expect(health.available).toBe(true)
    expect(health.failingWorkspaces()).toEqual([])
    await log.record(entry({ requestId: 'again', auditId: 'a3', event: 'attempt' }))
  })

  it('probes the way it records: a write-only log, or a directory it cannot read, keeps failing on every recheck (review L13 of B23-B25)', async () => {
    // Root reads anything, so the modes below would not refuse it.
    if (process.getuid?.() === 0) return
    for (const breakIt of [(path: string) => chmodSync(path, 0o200), (path: string) => chmodSync(dirname(path), 0o300)]) {
      const path = logPath()
      let now = 0
      const health = createAuditHealth({ now: () => now, probeIntervalMs: 1 })
      const log = createFileActionLog(path, { health, workspaceId: 'default' })
      await log.record(entry({ requestId: 'fine', auditId: 'l13-a', event: 'attempt' }))
      breakIt(path)
      try {
        await expect(log.record(entry({ requestId: 'refused', auditId: 'l13-b', event: 'attempt' }))).rejects.toBeInstanceOf(AuditUnavailableError)
        for (const at of [5, 10]) {
          now = at
          await health.recheck()
          expect(health.failing(path)).toBe(true)
        }
      } finally {
        chmodSync(dirname(path), 0o700)
        chmodSync(path, 0o600)
      }
      now = 20
      await health.recheck()
      expect(health.available).toBe(true)
    }
  })

  it('never lets a workspace that serves no call mark the node unready, even when its log is written to (review L12 of B23-B25)', async () => {
    const file = logPath()
    writeFileSync(file, 'not a directory')
    const health = createAuditHealth()
    const broken = join(file, 'actions.jsonl')
    let serving = true
    const log = createFileActionLog(broken, { health, workspaceId: 'child', serving: () => serving })
    await expect(log.record(entry())).rejects.toBeInstanceOf(AuditUnavailableError)
    expect(health.failingWorkspaces()).toEqual(['child'])
    serving = false
    health.forget(broken)
    // An owner's read of the retired workspace writes to its log; that failure does not count.
    await expect(log.record(entry())).rejects.toBeInstanceOf(AuditUnavailableError)
    expect(health.available).toBe(true)
  })

  it('forgets a log whose workspace no longer serves calls (review L5 of B20-B22)', async () => {
    const file = logPath()
    writeFileSync(file, 'not a directory')
    const health = createAuditHealth()
    const broken = join(file, 'actions.jsonl')
    await expect(createFileActionLog(broken, { health, workspaceId: 'retired' }).record(entry())).rejects.toBeInstanceOf(AuditUnavailableError)
    expect(health.failingWorkspaces()).toEqual(['retired'])
    health.forget(broken)
    expect(health.available).toBe(true)
    expect(health.lastFailureAt(broken)).not.toBeNull()
  })
})

describe('audit recovery after process interruption', () => {
  function orphan(path: string) {
    const pendingPath = `${path}.pending.json`
    const value = JSON.parse(readFileSync(pendingPath, 'utf8')) as { pending: Record<string, { processId: number; processInstanceId: string }> }
    for (const record of Object.values(value.pending)) {
      record.processId = 2_000_000_000
      record.processInstanceId = 'terminated-fixture-process'
    }
    writeFileSync(pendingPath, JSON.stringify(value))
    return value
  }

  it('records an interrupted outcome once when the attempt owner has stopped', async () => {
    const path = logPath()
    const log = createFileActionLog(path)
    await log.record(entry({ auditId: 'stopped-call', event: 'attempt', outcome: 'started' }))
    orphan(path)
    expect(await createFileActionLog(path).recoverInterrupted()).toBe(1)
    expect(await log.recoverInterrupted()).toBe(0)
    expect(log.read(1)[0]).toMatchObject({ auditId: 'stopped-call', event: 'result', outcome: 'interrupted' })
    expect(log.read(1)[0]?.detail).toContain('effects are unknown')
  })

  it('does not mark attempts from a live process interrupted', async () => {
    const path = logPath()
    const log = createFileActionLog(path)
    await log.record(entry({ auditId: 'live-call', event: 'attempt', outcome: 'started' }))
    expect(await createFileActionLog(path).recoverInterrupted()).toBe(0)
    expect(log.read(1)[0]?.outcome).toBe('started')
  })

  it('reconciles a durable terminal record if interruption preceded pending-index cleanup', async () => {
    const path = logPath()
    const log = createFileActionLog(path)
    await log.record(entry({ auditId: 'completed-call', event: 'attempt', outcome: 'started' }))
    const pending = orphan(path)
    await log.record(entry({ auditId: 'completed-call', event: 'result', outcome: 'ok' }))
    writeFileSync(`${path}.pending.json`, JSON.stringify(pending))
    expect(await log.recoverInterrupted()).toBe(0)
    expect(log.read(10).map(item => item.outcome)).toEqual(['started', 'ok'])
    expect(JSON.parse(readFileSync(`${path}.pending.json`, 'utf8')).pending).toEqual({})
  })
})
