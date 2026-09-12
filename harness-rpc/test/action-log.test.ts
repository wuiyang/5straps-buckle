import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFileActionLog } from '../src/adapters/action-log/file-action-log.js'
import { summarizeEffect } from '../src/domain/effect.js'
import { collectPrefixed } from '../src/domain/environment.js'
import { redactArguments } from '../src/domain/redact.js'
import type { ActionLogEntry } from '../src/ports/action-log.js'

function logPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'buckle-log-')), 'actions.jsonl')
}

function entry(overrides: Partial<ActionLogEntry> = {}): ActionLogEntry {
  return {
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
  it('creates the directory it needs and appends one line per action', () => {
    const path = logPath()
    const log = createFileActionLog(path)
    log.record(entry({ requestId: 'r1' }))
    log.record(entry({ requestId: 'r2' }))

    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2)
    expect(log.read(10).map(item => item.requestId)).toEqual(['r1', 'r2'])
  })

  it('returns the most recent entries when asked for fewer than it holds', () => {
    const log = createFileActionLog(logPath())
    for (const requestId of ['r1', 'r2', 'r3']) log.record(entry({ requestId }))
    expect(log.read(2).map(item => item.requestId)).toEqual(['r2', 'r3'])
  })

  it('reads as empty rather than throwing when nothing has been recorded', () => {
    expect(createFileActionLog(logPath()).read(10)).toEqual([])
  })

  it('keeps the readable entries when a line was torn by a killed process', () => {
    const path = logPath()
    const log = createFileActionLog(path)
    log.record(entry({ requestId: 'r1' }))
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"requestId":"r2","tru`)

    expect(log.read(10).map(item => item.requestId)).toEqual(['r1'])
    log.record(entry({ requestId: 'r3' }))
    expect(log.read(10).map(item => item.requestId)).toEqual(['r1', 'r3'])
  })

  it('records a refusal as fully as a success, so a denial leaves evidence', () => {
    const log = createFileActionLog(logPath())
    log.record(entry({
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
  it('pages newest first without skipping records across cursors', () => {
    const log = createFileActionLog(logPath())
    for (const requestId of ['r1', 'r2', 'r3', 'r4', 'r5']) log.record(entry({ requestId }))
    const first = log.page({ limit: 2 })
    const second = log.page({ limit: 2, before: Number(first.nextCursor) })
    const third = log.page({ limit: 2, before: Number(second.nextCursor) })
    expect([...first.entries, ...second.entries, ...third.entries].map(item => item.requestId)).toEqual(['r5', 'r4', 'r3', 'r2', 'r1'])
    expect(third.nextCursor).toBeNull()
  })

  it('refuses recording when durable storage is unavailable', () => {
    const file = logPath()
    writeFileSync(file, 'not a directory')
    expect(() => createFileActionLog(join(file, 'actions.jsonl')).record(entry())).toThrow('Audit storage unavailable')
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
    log.record(entry({ auditId: 'stopped-call', event: 'attempt', outcome: 'started' }))
    orphan(path)
    expect(await createFileActionLog(path).recoverInterrupted()).toBe(1)
    expect(await log.recoverInterrupted()).toBe(0)
    expect(log.read(1)[0]).toMatchObject({ auditId: 'stopped-call', event: 'result', outcome: 'interrupted' })
    expect(log.read(1)[0]?.detail).toContain('effects are unknown')
  })

  it('does not mark attempts from a live process interrupted', async () => {
    const path = logPath()
    const log = createFileActionLog(path)
    log.record(entry({ auditId: 'live-call', event: 'attempt', outcome: 'started' }))
    expect(await createFileActionLog(path).recoverInterrupted()).toBe(0)
    expect(log.read(1)[0]?.outcome).toBe('started')
  })

  it('reconciles a durable terminal record if interruption preceded pending-index cleanup', async () => {
    const path = logPath()
    const log = createFileActionLog(path)
    log.record(entry({ auditId: 'completed-call', event: 'attempt', outcome: 'started' }))
    const pending = orphan(path)
    log.record(entry({ auditId: 'completed-call', event: 'result', outcome: 'ok' }))
    writeFileSync(`${path}.pending.json`, JSON.stringify(pending))
    expect(await log.recoverInterrupted()).toBe(0)
    expect(log.read(10).map(item => item.outcome)).toEqual(['started', 'ok'])
    expect(JSON.parse(readFileSync(`${path}.pending.json`, 'utf8')).pending).toEqual({})
  })
})
