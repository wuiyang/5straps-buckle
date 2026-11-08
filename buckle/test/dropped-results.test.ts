import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogBudget } from '@5straps/runtime'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { actionLogWriter } from '../common/adapters/action-log/action-log-writer.js'
import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { createLogService } from '../common/adapters/action-log/log-service.js'
import { createPendingAudit } from '../common/adapters/action-log/pending-audit.js'
import { LOG_DROPPED_TOOL } from '../common/domain/record-tools.js'
import { actionsPath } from '../common/runtime/config.js'
import { LOG_HOLD_LIMIT, PROCESS_LOG_QUEUE } from '../common/runtime/log-budget.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { ActionLogEntry } from '../common/types/ports/action-log.js'
import type { LogService } from '../common/types/ports/log-service.js'
import { auditWritten, startActionLogWriter } from './support/action-log-writer.js'
import { configFromEnvironment } from './support/workspace-config.js'

const services: LogService[] = []
const runtimes: CoreRuntime[] = []

beforeAll(startActionLogWriter)

afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { runtime.closeWatchers(); await runtime.approvalService.close(); await runtime.history.close() }
  await Promise.all(services.splice(0).map(service => service.close({ deadlineMs: 1 })))
})

/** A service on a budget of its own, so no other log of the test process holds any of it. */
function service(settings: Partial<typeof PROCESS_LOG_QUEUE> = {}): LogService {
  const created = createLogService({ ...PROCESS_LOG_QUEUE, budget: createLogBudget({ limit: LOG_HOLD_LIMIT, overflow: 'drop-oldest' }), ...settings })
  services.push(created)
  return created
}

function call(auditId: string, event: 'attempt' | 'result'): ActionLogEntry {
  return { auditId, event, at: new Date().toISOString(), requestId: auditId, sessionId: 's1', tool: 'fs_read', outcome: event === 'attempt' ? 'started' : 'ok', durationMs: 0, effects: [], args: { path: 'notes.md' } }
}

function logPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'buckle-dropped-results-')), 'actions.jsonl')
}

function written(path: string): ActionLogEntry[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as ActionLogEntry)
}

/** The attempts the log's pending store still holds until their results. */
function pendingIds(path: string): string[] {
  const store = `${path}.pending.json`
  return existsSync(store) ? Object.keys((JSON.parse(readFileSync(store, 'utf8')) as { pending: object }).pending).sort() : []
}

/** The pending store as the next Buckle process to open the log reads it. */
function laterProcess(path: string) {
  return createPendingAudit({ filePath: path, processInstanceId: randomUUID() })
}

function quiet(): void {
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
}

describe('a result the log service drops', () => {
  it('leaves no attempt pending for a later process to mark interrupted, when a burst of 60 results passes the budget', async () => {
    const path = logPath()
    const logs = service()
    const log = createFileActionLog(path, { service: logs })
    const ids = Array.from({ length: 60 }, () => randomUUID())
    await log.recordMany(ids.map(auditId => call(auditId, 'attempt')))
    quiet()
    for (const auditId of ids) log.append(call(auditId, 'result'))
    await logs.flush()

    const lines = written(path)
    expect(lines.filter(line => line.tool === 'fs_read' && line.event === 'result')).toHaveLength(30)
    expect(lines.find(line => line.tool === LOG_DROPPED_TOOL)?.args).toMatchObject({ dropped: 30 })
    expect(pendingIds(path)).toEqual([])
    expect(laterProcess(path).leftBehind()).toBe(false)
  })

  it('stops tracking the attempt of a result that failed its retries with the next write to the log that lands', async () => {
    const path = logPath()
    const logs = service({ retryDelaysMs: [10, 10, 10] })
    const log = createFileActionLog(path, { service: logs })
    await log.record(call('a1', 'attempt'))
    const failing = vi.spyOn(actionLogWriter(), 'append')
    for (const _attempt of [1, 2, 3, 4]) failing.mockRejectedValueOnce(new Error('disk full'))
    quiet()
    log.append(call('a1', 'result'))
    await logs.flush()
    expect(logs.stats().logs[path]).toMatchObject({ dropped: 1, failures: 4 })
    expect(pendingIds(path)).toEqual(['a1'])

    await log.record(call('a2', 'attempt'))
    expect(pendingIds(path)).toEqual(['a2'])
  })

  it('answers 80 parallel calls, and a later process marks none of them interrupted though the budget dropped results', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'buckle-dropped-calls-'))
    const root = join(directory, 'workspace')
    mkdirSync(root)
    writeFileSync(join(root, 'notes.md'), 'hello')
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: join(directory, 'state'), BUCKLE_PACKS: 'fs', BUCKLE_ALLOW_SHELL: 'false' })
    const runtime = await createRuntime({ config })
    runtimes.push(runtime)
    const writer = actionLogWriter()
    const append = writer.append.bind(writer)
    let release = () => {}
    const disk = new Promise<void>((resolve) => { release = resolve })
    // A slow disk under the queued results alone: each call's attempt still lands before the call runs.
    vi.spyOn(writer, 'append').mockImplementation(async (input) => {
      if (input.entries.some(entry => entry.event === 'result')) await disk
      return append(input)
    })
    quiet()
    const responses = await Promise.all(Array.from({ length: 80 }, (_, index) => runtime.invoke({ sessionId: 's1', approvalWait: { mode: 'none' }, request: { requestId: `r-${index}`, tool: 'fs_read', args: { path: 'notes.md' }, approvalTokens: [] } })))
    release()
    await auditWritten()

    const path = actionsPath(config)
    expect(responses.filter(response => response.outcome === 'ok')).toHaveLength(80)
    expect(written(path).filter(line => line.tool === 'fs_read' && line.event === 'result').length).toBeLessThan(80)
    expect(pendingIds(path)).toEqual([])
    const recovered: ActionLogEntry[] = []
    await laterProcess(path).recover(async (entry) => { recovered.push(entry) })
    expect(recovered).toEqual([])
  })
})
