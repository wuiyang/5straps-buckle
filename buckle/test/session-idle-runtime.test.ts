import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { grantsPath, type BuckleConfig } from '../common/runtime/config.js'
import { logger } from '../common/runtime/log.js'
import { SESSION_SWEEP_MS } from '../common/services/approvals/session-idle-check.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { openSettingsFile, settingsPath } from '../common/services/workspaces/workspace-settings.js'
import { SOURCES } from '../common/types/ports/approval-source.js'
import { auditEntries, settleAuditLogs } from './support/action-log-writer.js'
import { fixedInteraction } from './support/interaction.js'
import { configFromEnvironment } from './support/workspace-config.js'

// Session end at idle through a workspace runtime. The Date clock is faked before a runtime
// opens, so the history's activity store, the grants, and the idle check read one clock, which runs on with real time
// and which a test steps past the window; timers stay real.

const roots: string[] = []
const runtimes: CoreRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { runtime.closeWatchers(); await runtime.approvalService.close(); await runtime.history.close() }
  vi.useRealTimers()
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const MINUTE = 60_000

function clock(): void {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
}

function folders(): { folder: string; state: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-session-idle-runtime-')))
  roots.push(root)
  const folder = join(root, 'workspace')
  mkdirSync(join(folder, 'one'), { recursive: true })
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  writeFileSync(join(folder, 'notes.md'), 'hello')
  writeFileSync(join(folder, '.env'), 'TOKEN=hidden')
  return { folder, state: join(root, 'state') }
}

function configOf(environment: NodeJS.ProcessEnv = {}): BuckleConfig {
  const { folder, state } = folders()
  return configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: folder, BUCKLE_STATE_DIR: state, BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '0', ...environment })
}

async function open(config: BuckleConfig, serving?: () => boolean): Promise<CoreRuntime> {
  const runtime = await createRuntime({ config, interaction: fixedInteraction(), ...(serving ? { serving } : {}) })
  runtimes.push(runtime)
  return runtime
}

let sequence = 0
function write(runtime: CoreRuntime, sessionId: string, path: string, wait: 'none' | 'held' = 'none'): Promise<InvokeResponse> {
  return runtime.invoke({ sessionId, ...(wait === 'none' ? { approvalWait: { mode: 'none' as const } } : {}), request: { requestId: `write-${++sequence}`, tool: 'fs_write', args: { path, content: 'x' }, approvalTokens: [] } })
}

function read(runtime: CoreRuntime, sessionId: string, path: string): Promise<InvokeResponse> {
  return runtime.invoke({ sessionId, approvalWait: { mode: 'none' }, request: { requestId: `read-${++sequence}`, tool: 'fs_read', args: { path }, approvalTokens: [] } })
}

/** A write to `path` that asks, approved for its session, so later writes there run without asking. */
async function approvedForSession(runtime: CoreRuntime, sessionId: string, path: string): Promise<void> {
  const asking = await write(runtime, sessionId, path)
  expect(asking).toMatchObject({ outcome: 'approval_required' })
  const token = asking.outcome === 'approval_required' ? asking.approvals[0]!.token : ''
  expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'session' }, source: SOURCES.cli })).toMatchObject({ ok: true })
  expect(await write(runtime, sessionId, path)).toMatchObject({ outcome: 'ok' })
}

function past(window: number = 15 * MINUTE): void {
  vi.setSystemTime(Date.now() + window + 1)
}

const sessionEnds = async (runtime: CoreRuntime) => (await auditEntries(runtime.actions, 200)).filter(entry => entry.tool === 'approval_session_ended')

describe('a workspace runtime', () => {
  it('ends a session idle past the window before a CLI call, which asks again, and records the end', async () => {
    clock()
    const config = configOf()
    const serving = await open(config)
    await approvedForSession(serving, 'cli', 'one/a.md')
    past()

    const cli = await open(config)
    expect(await write(cli, 'cli', 'one/a.md')).toMatchObject({ outcome: 'approval_required' })
    expect(cli.grants.list()).toEqual([])
    expect((await sessionEnds(cli)).map(entry => [entry.sessionId, entry.args])).toEqual([['cli', expect.objectContaining({ cause: 'idle', grants: 1 })]])
  }, 30_000)

  it('ends the session of a call held waiting for an answer past the window, as no tool runs while it waits', async () => {
    clock()
    const runtime = await open(configOf())
    await approvedForSession(runtime, 'chat-1', 'one/a.md')
    const held = write(runtime, 'chat-1', 'held.md', 'held')
    await vi.waitFor(() => expect(runtime.approvalService.waiting()).toHaveLength(1))
    past()

    await runtime.sessionIdle.check()
    expect(runtime.approvalService.waiting()).toEqual([])
    expect(await held).toMatchObject({ outcome: 'error', error: { code: 'APPROVAL_UNANSWERED' } })
    expect(runtime.grants.list()).toEqual([])
  }, 30_000)

  it('ends the session at idle though the log service dropped the result entry of its last call', async () => {
    clock()
    const runtime = await open(configOf())
    await approvedForSession(runtime, 'chat-1', 'one/a.md')
    const append = runtime.actions.append.bind(runtime.actions)
    vi.spyOn(runtime.actions, 'append').mockImplementation((entry) => { if (entry.event !== 'result' || entry.tool !== 'fs_write') append(entry) })
    expect(await write(runtime, 'chat-1', 'one/a.md')).toMatchObject({ outcome: 'ok' })
    past()

    await runtime.sessionIdle.check()
    expect(runtime.grants.list()).toEqual([])
  }, 30_000)

  it('ends a session idle past the window before a late decision from another process applies, so it grants nothing and the next call asks', async () => {
    clock()
    const config = configOf({ BUCKLE_APPROVAL_SESSION_IDLE_MS: String(MINUTE) })
    const serving = await open(config)
    await approvedForSession(serving, 'cli', 'one/a.md')
    const asking = await write(serving, 'cli', 'two.md')
    const token = asking.outcome === 'approval_required' ? asking.approvals[0]!.token : ''
    past(MINUTE)

    const approving = await open(config)
    expect(await approving.approvalApi.decide({ source: 'cli', decision: { token, outcome: 'approve', scope: 'session' } })).toMatchObject({ status: 'refused' })
    expect(approving.grants.list()).toEqual([])
    expect(await write(serving, 'cli', 'one/a.md')).toMatchObject({ outcome: 'approval_required' })
  }, 30_000)

  it('ends the sessions of a workspace idle past the window at its once-a-minute sweep, with no call to check first', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], shouldAdvanceTime: true })
    const runtime = await open(configOf())
    await approvedForSession(runtime, 'chat-1', 'one/a.md')
    past()

    await vi.advanceTimersByTimeAsync(SESSION_SWEEP_MS)
    await vi.waitFor(() => expect(runtime.grants.list()).toEqual([]))
    expect((await sessionEnds(runtime)).map(entry => entry.sessionId)).toEqual(['chat-1'])
  }, 30_000)

  it('counts a decision as activity, which another process reads', async () => {
    clock()
    const config = configOf()
    const serving = await open(config)
    await approvedForSession(serving, 'chat-1', 'one/a.md')
    const asking = await write(serving, 'chat-1', 'two.md')
    const token = asking.outcome === 'approval_required' ? asking.approvals[0]!.token : ''
    past(9 * MINUTE)
    expect(await serving.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, source: SOURCES.cli })).toMatchObject({ ok: true })
    past(9 * MINUTE)

    const cli = await open(config)
    expect(await write(cli, 'chat-1', 'one/a.md')).toMatchObject({ outcome: 'ok' })
  }, 30_000)

  it('counts no setup read and no refused call as activity', async () => {
    clock()
    let online = true
    const runtime = await open(configOf(), () => online)
    await approvedForSession(runtime, 'chat-1', 'one/a.md')
    past(10 * MINUTE)
    runtime.manifest()
    runtime.approvalApi.listing()
    runtime.grants.list()
    online = false
    await expect(write(runtime, 'chat-1', 'one/a.md')).rejects.toThrow('Workspace is offline')
    online = true
    past(5 * MINUTE)

    expect(await write(runtime, 'chat-1', 'one/a.md')).toMatchObject({ outcome: 'approval_required' })
  }, 30_000)

  it('counts a session grant\'s making as activity where the store holds none, so a fresh one clears a call and an old one ends', async () => {
    clock()
    const runtime = await open(configOf())
    const grant = { sessionId: 'chat-1', rule: 'write_scope' as const, subject: join(runtime.paths().root, 'one'), scope: 'session' as const }
    await runtime.grants.grant(grant)
    expect(await write(runtime, 'chat-1', 'one/a.md')).toMatchObject({ outcome: 'ok' })

    const lost = await open(configOf())
    await lost.grants.grant({ ...grant, subject: join(lost.paths().root, 'one') })
    past()
    expect(await write(lost, 'chat-1', 'one/a.md')).toMatchObject({ outcome: 'approval_required' })
  }, 30_000)

  it('names grants.json, not the activity store, where the store holds nothing and the grants it falls back to cannot be read', async () => {
    const config = configOf()
    const runtime = await open(config)
    vi.spyOn(runtime.history, 'lastActivity').mockReturnValue(undefined)
    writeFileSync(grantsPath(config), 'not json')
    const warned = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    await runtime.sessionIdle.check()
    expect(runtime.sessionIdle.sessionApprovalsSuspended()).toBe(true)
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('as grants.json cannot be read'), expect.objectContaining({ store: 'grants.json' }))
  }, 30_000)

  it('ends no session where the window is 0, set for the node or for the workspace', async () => {
    clock()
    const node = await open(configOf({ BUCKLE_APPROVAL_SESSION_IDLE_MS: '0' }))
    await approvedForSession(node, 'chat-1', 'one/a.md')
    const config = configOf()
    const own = await open(config)
    await approvedForSession(own, 'chat-1', 'one/a.md')
    await openSettingsFile({ filePath: settingsPath(config.nodeStateDirectory!, own.workspaceId) }).update(current => ({ ...current, approval: { ...current.approval, sessionIdleMs: 0 } }))
    past(60 * MINUTE)

    expect(await write(node, 'chat-1', 'one/a.md')).toMatchObject({ outcome: 'ok' })
    expect(await write(own, 'chat-1', 'one/a.md')).toMatchObject({ outcome: 'ok' })
  }, 30_000)

  it('ends no session where activity cannot be read: every session approval then asks, one given meanwhile too, and a lasting denial binds', async () => {
    clock()
    const runtime = await open(configOf())
    await approvedForSession(runtime, 'chat-1', 'one/a.md')
    const denying = await read(runtime, 'chat-1', '.env')
    const denied = denying.outcome === 'approval_required' ? denying.approvals[0]!.token : ''
    expect(await runtime.approvalService.answer({ decision: { token: denied, approved: false, scope: 'session' }, source: SOURCES.cli })).toMatchObject({ ok: true })
    past()
    vi.spyOn(runtime.history, 'lastActivity').mockImplementation(() => { throw new Error('SQLITE_IOERR: disk I/O error') })
    const warned = vi.spyOn(logger, 'warn')

    const stale = await write(runtime, 'chat-1', 'one/a.md')
    expect(stale).toMatchObject({ outcome: 'approval_required' })
    expect(await read(runtime, 'chat-1', '.env')).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
    expect(runtime.grants.list()).toHaveLength(2)
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('activity.sqlite'), expect.anything())

    const token = stale.outcome === 'approval_required' ? stale.approvals[0]!.token : ''
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'session' }, source: SOURCES.cli })).toMatchObject({ ok: true })
    expect(await write(runtime, 'chat-1', 'one/a.md')).toMatchObject({ outcome: 'approval_required' })
    expect(await sessionEnds(runtime)).toEqual([])
  }, 30_000)

  it('ends no session where a second process cannot read activity, while its calls ask where session approvals cleared them and a lasting denial binds', async () => {
    clock()
    const config = configOf()
    const first = await open(config)
    await approvedForSession(first, 'chat-1', 'one/a.md')
    const denying = await read(first, 'chat-1', '.env')
    const denied = denying.outcome === 'approval_required' ? denying.approvals[0]!.token : ''
    expect(await first.approvalService.answer({ decision: { token: denied, approved: false, scope: 'session' }, source: SOURCES.cli })).toMatchObject({ ok: true })
    past()

    const second = await open(config)
    vi.spyOn(second.history, 'lastActivity').mockImplementation(() => { throw new Error('SQLITE_IOERR: disk I/O error') })
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    expect(await write(second, 'chat-1', 'one/a.md')).toMatchObject({ outcome: 'approval_required' })
    expect(await read(second, 'chat-1', '.env')).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
    expect(second.grants.list()).toHaveLength(2)
    expect(await sessionEnds(second)).toEqual([])
  }, 30_000)
})
