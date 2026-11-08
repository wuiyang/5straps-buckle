import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createLogBudget } from '@5straps/runtime'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { actionLogWriter } from '../common/adapters/action-log/action-log-writer.js'
import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { createLogService, logService } from '../common/adapters/action-log/log-service.js'
import { createLoggedDecisionAudit } from '../common/adapters/approval/logged-decision-audit.js'
import { DECISION_TOOL, LOG_DROPPED_TOOL } from '../common/domain/record-tools.js'
import { MAX_ENTRY_BYTES } from '../common/adapters/action-log/writer-protocol.js'
import { LOG_HOLD_LIMIT, PROCESS_LOG_QUEUE, processLogBudget } from '../common/runtime/log-budget.js'
import { configureRootLogger, flushLogs, logger } from '../common/runtime/log.js'
import { createMasker, holdMasker } from '../common/services/secrets/mask.js'
import type { ActionLogEntry } from '../common/types/ports/action-log.js'
import { SOURCES } from '../common/types/ports/approval-source.js'
import type { LogDestination, LogService } from '../common/types/ports/log-service.js'
import { recordRefusal } from '../layers/common/server/utils/audit.js'
import { startActionLogWriter } from './support/action-log-writer.js'
import { closeFaultyWriters, faultyWriter } from './support/writer-faults.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { byName, registerWorkspace, workspacesOf } from './support/workspaces.js'

const services: LogService[] = []

beforeAll(startActionLogWriter)

afterEach(async () => {
  vi.restoreAllMocks()
  configureRootLogger({})
  await Promise.all(services.splice(0).map(service => service.close({ deadlineMs: 1 })))
  await closeFaultyWriters()
})

/** A service on a budget of its own, so no other log of the test process holds any of it. */
function service(settings: Partial<typeof PROCESS_LOG_QUEUE> = {}): LogService {
  const created = createLogService({ ...PROCESS_LOG_QUEUE, budget: createLogBudget({ limit: LOG_HOLD_LIMIT, overflow: 'drop-oldest' }), ...settings })
  services.push(created)
  return created
}

function entry(requestId: string, overrides: Partial<ActionLogEntry> = {}): ActionLogEntry {
  return { event: 'result', at: new Date().toISOString(), requestId, sessionId: 'local-owner', tool: 'cli_policy', outcome: 'ok', durationMs: 0, effects: [], args: {}, ...overrides }
}

function range(from: number, to: number): string[] {
  return Array.from({ length: to - from }, (_, index) => `e${from + index}`)
}

/** A log whose writer never answers: what it is handed stays with it. */
function stuck(name: string): { destination: LogDestination; batches: string[][] } {
  const batches: string[][] = []
  const destination: LogDestination = {
    name,
    write: (batch) => { batches.push(batch.map(item => item.requestId)); return new Promise<void>(() => {}) },
    dropped: drops => entry('dropped', { tool: LOG_DROPPED_TOOL, args: { dropped: drops.count } }),
  }
  return { destination, batches }
}

/** The JSON lines written to stderr while it is captured. */
function captureStderr(): () => Array<Record<string, unknown>> {
  let text = ''
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { text += String(chunk); return true })
  return () => text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
}

function logPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'buckle-log-service-')), 'actions.jsonl')
}

function written(path: string): ActionLogEntry[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as ActionLogEntry)
}

const tick = () => new Promise(resolve => setImmediate(resolve))

describe('the log service', () => {
  it('drops the oldest of 31 entries held against a stuck writer, counts the one, and returns from every append at once', async () => {
    const logs = service()
    const log = stuck('actions.jsonl')
    const stderr = captureStderr()
    const started = performance.now()
    for (const id of range(0, 31)) expect(logs.append(log.destination, entry(id))).toBeUndefined()
    expect(performance.now() - started).toBeLessThan(100)
    await tick()

    expect(logs.stats()).toMatchObject({ held: 30, logs: { 'actions.jsonl': { held: 30, dropped: 1 } } })
    // The count goes ahead of the first batch the writer is handed after the drop.
    expect(log.batches).toEqual([['dropped', ...range(1, 11)]])
    expect(stderr()).toEqual([expect.objectContaining({ level: 'warn', message: 'Audit log entries dropped', fields: { destination: 'actions.jsonl', reason: 'full', limit: 30 } })])
  })

  it('holds 30 in all across four workspaces\' logs and the node\'s, drops the oldest whichever log holds it, and counts each log\'s drops on its own', async () => {
    const logs = service()
    const names = ['ws-1', 'ws-2', 'ws-3', 'ws-4', 'node']
    const destinations = names.map(name => stuck(name))
    captureStderr()
    for (const log of destinations) for (const id of range(0, 10)) logs.append(log.destination, entry(id))
    await tick()

    const stats = logs.stats()
    expect(stats.held).toBe(30)
    expect(names.map(name => stats.logs[name]?.dropped)).toEqual([10, 10, 0, 0, 0])
    expect(destinations.map(log => log.batches.length)).toEqual([0, 0, 1, 1, 1])
  })

  it('shares the process\'s one budget with the node log, so the two together hold at most 30', async () => {
    configureRootLogger({}, { format: 'json' })
    const logs = createLogService()
    services.push(logs)
    const log = stuck('actions.jsonl')
    const stderr = captureStderr()
    for (const id of range(0, 20)) logs.append(log.destination, entry(id))
    for (const id of range(100, 120)) logger.info(id)
    expect(processLogBudget.held()).toBe(30)
    await flushLogs()

    expect(stderr().filter(line => line.component === 'buckle' && String(line.message).startsWith('e')).map(line => line.message)).toEqual(range(100, 120))
    expect(logs.stats().logs['actions.jsonl']).toMatchObject({ dropped: 10 })
  })

  it('keeps a decision record queued behind 100 refusals on a stalled disk, since a refusal gives way to every other entry', async () => {
    const path = logPath()
    const faulty = faultyWriter()
    const logs = service()
    const log = createFileActionLog(path, { writer: faulty.writer, service: logs })
    await log.record(entry('first'))
    captureStderr()
    faulty.stall()
    const refuse = (count: number) => {
      for (const index of range(0, count)) recordRefusal(log, { tool: 'rpc_invoke_rejected', workspaceId: 'w-1', sessionId: 'rpc-untrusted', status: 400, detail: `refusal ${index}` })
    }
    createLoggedDecisionAudit({ actions: log, workspaceId: 'w-1' }).received({ token: 't-1', approved: true, scope: 'session', source: SOURCES.cli, proof: 'none' }).applied({ assurance: 'local', repeated: false, grantOwed: false })
    refuse(100)
    // Past the write deadline, the stalled batch may give up entries too.
    await delay(1_200)
    refuse(100)
    faulty.release()
    await logs.flush()

    const lines = written(path)
    expect(lines.filter(line => line.tool === DECISION_TOOL).map(line => line.event)).toEqual(['attempt', 'result'])
    expect(lines.some(line => line.tool === LOG_DROPPED_TOOL)).toBe(true)
  })

  it('drops a batch its writer failed 4 times, and writes the count first once the log takes writes again', async () => {
    const blocker = logPath()
    writeFileSync(blocker, 'not a directory')
    const path = join(blocker, 'actions.jsonl')
    const logs = service({ retryDelaysMs: [10, 10, 10] })
    const log = createFileActionLog(path, { service: logs, workspaceId: 'ws-1', workspaceName: () => 'Site' })
    captureStderr()
    log.append(entry('lost', { workspaceId: 'ws-1' }))
    await logs.flush()
    expect(logs.stats().logs[path]).toMatchObject({ dropped: 1, failures: 4, written: 0 })

    rmSync(blocker)
    mkdirSync(blocker)
    log.append(entry('kept', { workspaceId: 'ws-1' }))
    await logs.flush()

    const lines = written(path)
    expect(lines.map(line => line.tool)).toEqual([LOG_DROPPED_TOOL, 'cli_policy'])
    expect(lines[0]).toMatchObject({ event: 'result', outcome: 'error', workspaceId: 'ws-1', workspaceName: 'Site', entryId: expect.any(String), args: { dropped: 1, firstAt: expect.any(String), lastAt: expect.any(String) } })
    expect(lines[1]).toMatchObject({ requestId: 'kept', workspaceName: 'Site' })
  })

  it('returns from an append at once while the disk stalls a sync, as a required attempt waits for its own', async () => {
    const path = logPath()
    const faulty = faultyWriter()
    const logs = service()
    const log = createFileActionLog(path, { writer: faulty.writer, service: logs })
    await log.record(entry('first'))
    faulty.stall()
    const started = performance.now()
    log.append(entry('queued'))
    const attempt = log.record(entry('required', { auditId: 'a1', event: 'attempt', outcome: 'started' }))
    expect(performance.now() - started).toBeLessThan(100)
    const state = await Promise.race([attempt.then(() => 'written'), delay(200).then(() => 'waiting')])
    expect(state).toBe('waiting')

    faulty.release()
    await attempt
    await logs.flush()
    expect(written(path).map(line => line.requestId).sort()).toEqual(['first', 'queued', 'required'])
  })

  it('gives each entry its id as it is appended, so a write tried again after a failed sync leaves no line twice', async () => {
    const path = logPath()
    const faulty = faultyWriter()
    const logs = service({ retryDelaysMs: [10, 10, 10] })
    const log = createFileActionLog(path, { writer: faulty.writer, service: logs })
    await log.record(entry('first'))
    captureStderr()
    faulty.failAtSync(1)
    log.append(entry('r1'))
    log.append(entry('r2'))
    await logs.flush()

    expect(written(path).map(line => line.requestId)).toEqual(['first', 'r1', 'r2'])
    expect(logs.stats().logs[path]).toMatchObject({ written: 2, dropped: 0, failures: 1 })
  })

  it('writes what it holds at close, and stops at the deadline, counting what was left on stderr', async () => {
    const path = logPath()
    const logs = service()
    const log = createFileActionLog(path, { service: logs })
    for (const id of range(0, 5)) log.append(entry(id))
    expect(await logs.close({ deadlineMs: 2_000 })).toEqual({ left: 0 })
    expect(written(path).map(line => line.requestId)).toEqual(range(0, 5))

    const faulty = faultyWriter()
    const stalled = createFileActionLog(logPath(), { writer: faulty.writer, service: logs })
    await stalled.record(entry('first'))
    faulty.stall()
    const stderr = captureStderr()
    for (const id of range(0, 3)) stalled.append(entry(id))
    await tick()
    const started = performance.now()
    expect(await logs.close({ deadlineMs: 100 })).toEqual({ left: 3 })
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(stderr()).toContainEqual(expect.objectContaining({ level: 'warn', message: 'Audit log entries left unwritten at close', fields: { left: 3 } }))
    faulty.release()

    log.append(entry('after close'))
    await logs.flush()
    expect(written(path).map(line => line.requestId)).toEqual([...range(0, 5), 'after close'])
  })

  it('masks a value a call held when its entry was appended, though the entry is written after the call ended', async () => {
    const path = logPath()
    const logs = service()
    const log = createFileActionLog(path, { service: logs })
    const value = 'decoy+value/0123=:'
    const release = holdMasker(createMasker([{ name: 'API_TOKEN', value }]))
    log.append(entry('masked', { detail: `refused ${value}` }))
    release()
    await logs.flush()

    const text = readFileSync(path, 'utf8')
    expect(text).not.toContain(value)
    expect(written(path)[0]).toMatchObject({ detail: 'refused [secret:API_TOKEN]' })
  })

  it('names an entry\'s workspace as it was called when the entry was appended', async () => {
    const path = logPath()
    const logs = service()
    let name = 'Before'
    const log = createFileActionLog(path, { service: logs, workspaceId: 'ws-1', workspaceName: () => name })
    log.append(entry('named', { workspaceId: 'ws-1' }))
    name = 'After'
    await logs.flush()

    expect(written(path)[0]).toMatchObject({ workspaceName: 'Before' })
  })

  it('writes an entry past the size limit without its arguments, effects, and detail, and its batch-mates whole', async () => {
    const path = logPath()
    const logs = service()
    const log = createFileActionLog(path, { service: logs })
    log.append(entry('large', { detail: 'x'.repeat(MAX_ENTRY_BYTES), effects: ['write_path'], args: { path: 'notes.md' } }))
    log.append(entry('small'))
    await logs.flush()

    const lines = written(path)
    expect(lines.map(line => line.requestId)).toEqual(['large', 'small'])
    expect(lines[0]).toMatchObject({ tool: 'cli_policy', outcome: 'ok', args: {}, effects: [], detail: expect.stringContaining('size limit') })
    expect(logs.stats().logs[path]).toMatchObject({ failures: 0, dropped: 0 })
  })

  it('drops what a workspace\'s log holds when its records are purged, so a write held past the close deadline does not make the folder again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-log-service-purge-'))
    for (const folder of ['node', 'site']) mkdirSync(join(root, folder))
    mkdirSync(join(root, 'state'), { mode: 0o700 })
    const manager = await workspacesOf(configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'node'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' }))
    try {
      await registerWorkspace(manager, { id: 'site', dir: join(root, 'site') })
      const { runtime } = await byName(manager, 'site')
      const records = join(root, 'state', 'workspaces', runtime.workspaceId)
      const writer = actionLogWriter()
      const append = writer.append.bind(writer)
      let release = () => {}
      const held = new Promise<void>((resolve) => { release = resolve })
      vi.spyOn(writer, 'append').mockImplementation(async (input) => { await held; return append(input) })
      captureStderr()
      runtime.actions.append(entry('queued', { workspaceId: runtime.workspaceId }))
      runtime.actions.append(entry('waiting', { workspaceId: runtime.workspaceId }))
      await tick()

      const removing = manager.remove(runtime.workspaceId, { purge: true })
      await delay(2_500)
      release()
      await removing
      await logService().flush()
      await delay(100)
      expect(existsSync(records)).toBe(false)
    } finally {
      await manager.close()
    }
  })

  it('writes what a removed workspace\'s log holds, then forgets its queue', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-log-service-release-'))
    for (const folder of ['node', 'site']) mkdirSync(join(root, folder))
    mkdirSync(join(root, 'state'), { mode: 0o700 })
    const manager = await workspacesOf(configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'node'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' }))
    try {
      await registerWorkspace(manager, { id: 'site', dir: join(root, 'site') })
      const { runtime } = await byName(manager, 'site')
      const path = join(root, 'state', 'workspaces', runtime.workspaceId, 'actions.jsonl')
      runtime.actions.append(entry('queued', { workspaceId: runtime.workspaceId }))
      expect(Object.keys(logService().stats().logs)).toContain(path)

      await manager.remove(runtime.workspaceId)
      await logService().flush()
      await tick()
      expect(written(path).map(line => line.requestId)).toContain('queued')
      expect(Object.keys(logService().stats().logs)).not.toContain(path)
    } finally {
      await manager.close()
    }
  })

  it('writes no queued entry of a workspace\'s log once its folder is gone, as when another process purged its records', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'buckle-log-service-gone-'))
    const path = join(folder, 'actions.jsonl')
    const logs = service({ retryDelaysMs: [1] })
    const log = createFileActionLog(path, { service: logs, purgeable: true })
    await log.record(entry('first'))
    rmSync(folder, { recursive: true })
    captureStderr()
    log.append(entry('late'))
    await logs.flush()

    expect(existsSync(folder)).toBe(false)
    expect(logs.stats().logs[path]).toMatchObject({ written: 0, dropped: 1 })
  })
})
