import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PermissionRuleId } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settingsCommand } from '../cli/settings.js'
import { createMemoryNonceClaims } from '../common/adapters/approval/memory-nonce-claims.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { DEFAULT_SESSION_IDLE_MS, idleVerdict, newestSessionGrant, parseSessionIdle, SESSION_IDLE_BOUNDS, type ActivityReading } from '../common/domain/approval/session-idle.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'
import type { GrantHolder } from '../common/domain/permission/grant-holder.js'
import { loadConfig } from '../common/runtime/config.js'
import { logger } from '../common/runtime/log.js'
import { createApprovalRegistry, type ApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createApprovalService, type ApprovalAskInput, type ApprovalService } from '../common/services/approvals/approval-service.js'
import { createSessionIdleCheck } from '../common/services/approvals/session-idle-check.js'
import { ActivityBusyError, openHistoryActivity } from '../common/services/history/activity.js'
import { ACTIVE_WORK_FRESH_MS, ACTIVE_WORK_REFRESH_MS, createExecutingMark, executingMarks } from '../common/services/workspaces/active-work.js'
import { openSettingsFile, resolveSettings, settingsPath, WorkspaceSettingsSchema } from '../common/services/workspaces/workspace-settings.js'
import type { ApprovalBackend, LifecycleEvent } from '../common/types/ports/approval-backend.js'
import { SOURCES } from '../common/types/ports/approval-source.js'
import type { GrantStore } from '../common/types/ports/grant-store.js'
import { settleAuditLogs } from './support/action-log-writer.js'
import { recordingDecisionAudit } from './support/decision-audit.js'
import { runCli } from './support/cli.js'
import { holdLockInProcess, killHolder } from './support/lock-holder.js'
import { idOf, workspacesOf } from './support/workspaces.js'

// Session end at idle: each session, its id under the actor that asked in it, ends once it has had no activity of its own
// for longer than its window, 15 minutes unless set, while the workspace's other sessions keep theirs. Activity is one of
// its tools running, one of its calls held for a person's answer (APPROVAL-31), one of its calls starting or ending, an
// ask, and a decision. Where a session's activity cannot be read, it does not end, and none of its session approvals
// clears a call.

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-session-idle-')))
  roots.push(root)
  return root
}

const MINUTE = 60_000
const NOW = 1_800_000_000_000
const read = (reading: ActivityReading) => vi.fn(() => reading)

describe('the idle verdict', () => {
  it('is off at 0, reading nothing', () => {
    const reader = read({ lastAt: undefined, executing: 0 })
    expect(idleVerdict({ now: NOW, idleMs: 0, read: reader })).toEqual({ kind: 'off' })
    expect(reader).not.toHaveBeenCalled()
  })

  it('reads nothing while this process saw activity within the window', () => {
    const reader = read({ lastAt: undefined, executing: 0 })
    expect(idleVerdict({ now: NOW, idleMs: DEFAULT_SESSION_IDLE_MS, seenAt: NOW - 14 * MINUTE, read: reader })).toEqual({ kind: 'active', at: NOW - 14 * MINUTE })
    expect(reader).not.toHaveBeenCalled()
    expect(idleVerdict({ now: NOW, idleMs: DEFAULT_SESSION_IDLE_MS, seenAt: NOW - 16 * MINUTE, read: reader })).toEqual({ kind: 'idle' })
    expect(reader).toHaveBeenCalledOnce()
  })

  it('is idle only past the window, and where nothing was ever recorded; active as of the last activity it read', () => {
    const at = (lastAt: number | undefined) => idleVerdict({ now: NOW, idleMs: DEFAULT_SESSION_IDLE_MS, read: read({ lastAt, executing: 0 }) })
    expect(at(NOW - DEFAULT_SESSION_IDLE_MS)).toEqual({ kind: 'active', at: NOW - DEFAULT_SESSION_IDLE_MS })
    expect(at(NOW - DEFAULT_SESSION_IDLE_MS - 1)).toEqual({ kind: 'idle' })
    expect(at(undefined)).toEqual({ kind: 'idle' })
  })

  it('is active while a tool runs anywhere, however long ago the last call started', () => {
    expect(idleVerdict({ now: NOW, idleMs: DEFAULT_SESSION_IDLE_MS, read: read({ lastAt: NOW - 60 * MINUTE, executing: 1 }) })).toEqual({ kind: 'active', at: NOW })
  })

  it('is unknown, naming the store, where the activity or the marks cannot be read', () => {
    expect(idleVerdict({ now: NOW, idleMs: DEFAULT_SESSION_IDLE_MS, read: read({ unreadable: 'activity.sqlite' }) })).toEqual({ kind: 'unknown', store: 'activity.sqlite' })
  })

  it('takes, where the store holds no activity of a session, its own newest session grant\'s making as its last activity', () => {
    const one = { sessionId: 'mcp', actor: 'agent:one' }
    const made = (scope: string, at: number, holder: { sessionId: string | null; actor: string | null } = { sessionId: 'mcp', actor: 'agent:one' }) => ({ scope, ...holder, createdAt: new Date(at).toISOString() })
    expect(newestSessionGrant([], one)).toBeUndefined()
    expect(newestSessionGrant([made('always', NOW, { sessionId: null, actor: null })], one)).toBeUndefined()
    expect(newestSessionGrant([made('session', NOW - MINUTE), made('session', NOW - 5), made('always', NOW, { sessionId: null, actor: null })], one)).toBe(NOW - 5)
    // Another caller's grant under the same id, or another session's, is no activity of this one.
    expect(newestSessionGrant([made('session', NOW - MINUTE), made('session', NOW, { sessionId: 'mcp', actor: 'agent:two' }), made('session', NOW, { sessionId: 'rpc', actor: 'agent:one' })], one)).toBe(NOW - MINUTE)
  })

  it('takes 0, or a minute to a day, in milliseconds, and nothing else', () => {
    expect(DEFAULT_SESSION_IDLE_MS).toBe(15 * MINUTE)
    expect(SESSION_IDLE_BOUNDS).toEqual({ min: MINUTE, max: 24 * 60 * MINUTE })
    expect(['0', '60000', ' 1800000 ', '86400000'].map(parseSessionIdle)).toEqual([0, 60_000, 1_800_000, 86_400_000])
    expect(['59999', '86400001', '15m', '-1', '', '1e6'].map(parseSessionIdle)).toEqual([null, null, null, null, null, null])
  })
})

describe('the idle window setting', () => {
  it('is the workspace\'s own, else the node\'s, else 15 minutes, naming where it came from', () => {
    const unset = WorkspaceSettingsSchema.parse({ version: 1 })
    const builtIn = resolveSettings(unset, loadConfig({}).workspaceDefaults)
    expect(builtIn).toMatchObject({ approval: { sessionIdleMs: DEFAULT_SESSION_IDLE_MS }, sources: { 'approval.sessionIdleMs': 'built-in' } })
    const node = loadConfig({ BUCKLE_APPROVAL_SESSION_IDLE_MS: '0' }).workspaceDefaults
    expect(resolveSettings(unset, node)).toMatchObject({ approval: { sessionIdleMs: 0 }, sources: { 'approval.sessionIdleMs': 'node' } })
    const own = WorkspaceSettingsSchema.parse({ version: 1, approval: { sessionIdleMs: 1_800_000 } })
    expect(resolveSettings(own, node)).toMatchObject({ approval: { sessionIdleMs: 1_800_000 }, sources: { 'approval.sessionIdleMs': 'workspace' } })
    expect(() => WorkspaceSettingsSchema.parse({ version: 1, approval: { sessionIdleMs: 30_000 } })).toThrow()
    expect(() => loadConfig({ BUCKLE_APPROVAL_SESSION_IDLE_MS: '15m' })).toThrow('BUCKLE_APPROVAL_SESSION_IDLE_MS')
  })

  it('is set and unset with buckle workspace, refused out of range, and shown with its source', async () => {
    const root = scratch()
    const folder = join(root, 'site')
    mkdirSync(folder)
    const config = loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ADMIN_TOKEN: 'session-idle-admin-credential', BUCKLE_SANDBOX: 'none' })
    const output = captured()
    const buckle = (argv: string[]) => runCli({ argv: ['workspace', ...argv], config, confirm: null, cwd: folder })
    expect((await buckle(['init'])).exitCode).toBe(0)
    const manager = await workspacesOf(config)
    const stored = () => openSettingsFile({ filePath: settingsPath(config.stateDirectory, idOf(manager, 'site')) }).read().approval
    output.clear()

    await buckle(['show'])
    expect(output.out()).toMatch(/approval\.sessionIdleMs +900000 +built-in/)
    expect((await buckle(['set', 'approval.sessionIdleMs', '0'])).exitCode).toBe(0)
    expect(stored()).toEqual({ sessionIdleMs: 0 })
    expect((await buckle(['set', 'approval.sessionIdleMs', '30000'])).exitCode).toBe(1)
    expect(output.err()).toContain('approval.sessionIdleMs is milliseconds, 60000 (a minute) to 86400000 (a day), or 0')
    expect((await buckle(['unset', 'approval.sessionIdleMs'])).exitCode).toBe(0)
    expect(stored()).toEqual({})
    await manager.close()
  })

  it('is the node\'s default with buckle settings set approval-session-idle', async () => {
    const root = scratch()
    const file = join(root, 'buckle.env')
    writeFileSync(file, `BUCKLE_STATE_DIR=${join(root, 'state')}\n`, { mode: 0o600 })
    const settings = async (argv: string[]) => {
      const output = captured()
      const result = await settingsCommand({ argv, environment: {}, environmentFile: file, cwd: root, home: root })
      vi.restoreAllMocks()
      return { ...result, out: output.out(), printed: output.out() + output.err() }
    }
    const shown = await settings(['show'])
    expect(shown.out.slice(shown.out.indexOf('Workspace defaults'))).toMatch(/approval-session-idle\s+BUCKLE_APPROVAL_SESSION_IDLE_MS\s+900000\s+default/)
    expect((await settings(['set', 'approval-session-idle', '1800000'])).exitCode).toBe(0)
    expect(readFileSync(file, 'utf8')).toContain('BUCKLE_APPROVAL_SESSION_IDLE_MS=1800000\n')
    // Every process ends each session at the window it started with, so a running buckle mcp is named.
    for (const argv of [['set', 'approval-session-idle', '0'], ['unset', 'approval-session-idle']]) {
      expect((await settings(argv)).out).toContain('A buckle mcp an MCP client started keeps the window it started with, and ends each session of its workspace at it, until the client starts it again; buckle workspace set approval.sessionIdleMs changes a workspace\'s window from its next call.\n')
    }
    const refused = await settings(['set', 'approval-session-idle', '10'])
    expect(refused.exitCode).toBe(1)
    expect(refused.printed).toContain('BUCKLE_APPROVAL_SESSION_IDLE_MS is milliseconds')
  })
})

describe('the activity store', () => {
  const one = { sessionId: 'mcp', actor: 'agent:one' }
  const two = { sessionId: 'mcp', actor: 'agent:two' }
  const node = { sessionId: 'mcp' }

  it('reads each session\'s own newest activity, under its actor: its calls\' starts and ends, its asks, and its decisions', async () => {
    const directory = scratch()
    const activity = await openHistoryActivity(directory)
    expect(activity.latest(one)).toBeUndefined()
    const turn = activity.observe({ session: 'mcp', holder: one, at: NOW, idleMs: MINUTE })
    activity.observe({ session: 'mcp', holder: two, at: NOW + 5, idleMs: MINUTE })
    expect([activity.latest(one), activity.latest(two), activity.latest(node)]).toEqual([NOW, NOW + 5, undefined])
    activity.touch(one, NOW + 9)
    activity.touch(one, NOW + 7)
    activity.finish('mcp', undefined, turn, NOW + 8, node)
    expect([activity.latest(one), activity.latest(two), activity.latest(node)]).toEqual([NOW + 9, NOW + 5, NOW + 8])
    // A turn of history alone, as a checkpoint observes it, is no session's activity.
    activity.observe({ session: 'rpc', at: NOW + 20, idleMs: MINUTE })
    expect(activity.latest({ sessionId: 'rpc' })).toBeUndefined()
    await activity.close()
    const reopened = await openHistoryActivity(directory)
    expect([reopened.latest(one), reopened.latest(two)]).toEqual([NOW + 9, NOW + 5])
    await reopened.close()
  })

  it('counts a call\'s end whatever turn its session moved on to while it ran, so another process reads it', async () => {
    const directory = scratch()
    const activity = await openHistoryActivity(directory)
    const long = activity.observe({ session: 'mcp', holder: one, at: NOW, idleMs: MINUTE })
    activity.start('mcp', undefined, long)
    const short = activity.observe({ session: 'mcp', holder: one, at: NOW + 2 * MINUTE, idleMs: MINUTE })
    expect(short).not.toBe(long)
    activity.finish('mcp', undefined, long, NOW + 20 * MINUTE, one)

    const elsewhere = await openHistoryActivity(directory)
    expect(elsewhere.latest(one)).toBe(NOW + 20 * MINUTE)
    await elsewhere.close()
    await activity.close()
  })

  it('keeps another actor\'s session however many new session ids one actor opens, dropping that actor\'s own oldest past its cap', async () => {
    const directory = scratch()
    const activity = await openHistoryActivity(directory, { sessionsKept: 3 })
    activity.observe({ session: 'mcp', holder: two, at: NOW, idleMs: MINUTE })
    for (let index = 0; index < 10; index++) activity.observe({ session: `flood-${index}`, holder: { sessionId: `flood-${index}`, actor: 'agent:one' }, at: NOW + 1 + index, idleMs: MINUTE })
    expect(activity.latest(two)).toBe(NOW)
    const flooded = Array.from({ length: 10 }, (_, index) => activity.latest({ sessionId: `flood-${index}`, actor: 'agent:one' }))
    expect(flooded.filter(at => at !== undefined)).toEqual([NOW + 8, NOW + 9, NOW + 10])
    await activity.close()
  })

  it('drops a session\'s row once it is older than the longest idle window, idle under any', async () => {
    const directory = scratch()
    const activity = await openHistoryActivity(directory)
    activity.observe({ session: 'mcp', holder: two, at: NOW, idleMs: MINUTE })
    activity.observe({ session: 'mcp', holder: one, at: NOW + SESSION_IDLE_BOUNDS.max, idleMs: MINUTE })
    expect(activity.latest(two)).toBe(NOW)
    activity.observe({ session: 'mcp', holder: one, at: NOW + SESSION_IDLE_BOUNDS.max + 1, idleMs: MINUTE })
    expect(activity.latest(two)).toBeUndefined()
    await activity.close()
  })

  it('says it was busy, not unreadable, where another process holds it past the wait', async () => {
    const directory = scratch()
    const activity = await openHistoryActivity(directory)
    activity.touch(one, NOW)
    const holder = new DatabaseSync(join(directory, 'activity.sqlite'))
    holder.exec('BEGIN EXCLUSIVE')
    try { expect(() => activity.latest(one)).toThrow(ActivityBusyError) } finally { holder.exec('ROLLBACK'); holder.close() }
    expect(activity.latest(one)).toBe(NOW)
    await activity.close()
  })

  it('warns once while it cannot record, not at every ask, decision, and call, and again after a write succeeds', async () => {
    const directory = scratch()
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const activity = await openHistoryActivity(directory)
    const holder = new DatabaseSync(join(directory, 'activity.sqlite'))
    holder.exec('PRAGMA busy_timeout = 0')
    holder.exec('BEGIN EXCLUSIVE')
    for (let index = 0; index < 2; index++) activity.touch(one, NOW + index)
    expect(warn.mock.calls.map(([message]) => message)).toEqual(['Session activity could not be recorded; the session may end at idle sooner than its window'])
    holder.exec('ROLLBACK')
    activity.touch(one, NOW + 5)
    holder.exec('BEGIN EXCLUSIVE')
    activity.touch(two, NOW + 6)
    holder.exec('ROLLBACK')
    holder.close()
    expect(warn).toHaveBeenCalledTimes(2)
    await activity.close()
  })

  it('counts its in-memory fallback as unknown: latest throws where the store could not be opened', async () => {
    const directory = scratch()
    mkdirSync(join(directory, 'activity.sqlite'))
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const activity = await openHistoryActivity(directory)
    activity.observe({ session: 'chat-1', holder: { sessionId: 'chat-1' }, at: NOW, idleMs: MINUTE })
    activity.touch({ sessionId: 'chat-1' }, NOW)
    expect(() => activity.latest({ sessionId: 'chat-1' })).toThrow()
    await activity.close()
  })
})

const WORKSPACE = 'w-1'

/** One workspace's ledger and service, as a node composes them, with a terminal that keeps asking until core stops it. */
function setUp(options: { grants?: (store: GrantStore) => GrantStore; lockDeadlineMs?: number; graceMs?: number | null } = {}) {
  const root = scratch()
  const store = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: WORKSPACE })
  const grants = options.grants ? options.grants(store) : store
  const approvals = join(root, 'approvals.json')
  const registry = createApprovalRegistry(grants, approvals, 15_000, options.lockDeadlineMs === undefined ? {} : { lockDeadlineMs: options.lockDeadlineMs })
  const events: LifecycleEvent[] = []
  const terminal: ApprovalBackend = {
    open: async () => ({ contractVersion: 1, decides: true, scopes: ['once'], cancels: true, revokes: false }),
    submit: (_asks, context) => new Promise(resolve => context.signal.addEventListener('abort', () => resolve({ kind: 'accepted', refs: [] }), { once: true })),
    async notify(sent) { events.push(...sent) },
    close: async () => undefined,
  }
  const audit = recordingDecisionAudit()
  const marks = join(root, 'active-work')
  // A call held for a person's answer holds its session in this process's executing mark, as a runtime wires it.
  const executing = createExecutingMark({ directory: marks, workspaceId: WORKSPACE, instance: 'serving' })
  const service = createApprovalService({ registry, workspaceId: WORKSPACE, serverId: 'node-1', graceMs: options.graceMs === undefined ? 200 : options.graceMs, hold: async () => 'grace', terminal, nonces: createMemoryNonceClaims(), decisionAudit: audit.audit, holding: session => executing.begin(session) })
  return { root, store, registry, service, events, audit, approvals, marks }
}

const ask = (subject: string, rule: PermissionRuleId = 'write_scope') => ({ kind: 'ask' as const, ...PLAIN_MARKS, rule, subject, reason: 'outside the workspace', offeredScopes: ['once' as const, 'session' as const, 'always' as const] })
const CALL = { arguments: {}, cwd: '/', description: null, complete: true as const }

let sequence = 0
async function asked(registry: ApprovalRegistry, holder: { sessionId: string; actor?: string }, subject: string, rule: PermissionRuleId = 'write_scope'): Promise<string> {
  const result = await registry.ask({ tool: 'fs_write', ...holder, requestId: `request-${++sequence}`, asks: [ask(subject, rule)], call: CALL })
  return result.requests[0]!.token
}

async function decided(service: ApprovalService, token: string, scope: 'once' | 'session' | 'always', approved = true): Promise<void> {
  expect(await service.answer({ decision: { token, approved, scope }, source: SOURCES.cli })).toMatchObject({ ok: true })
}

/** The idle check over the ledger, with each session's last activity as `lastAt` gives it and the marks in `marks`. */
function idleCheck(input: { registry: ApprovalRegistry; service: ApprovalService; marks: string; lastAt: (session: GrantHolder) => number | undefined; now?: () => number }) {
  const now = input.now ?? Date.now
  const reads = { activity: 0, executing: 0 }
  const check = createSessionIdleCheck({
    workspaceId: WORKSPACE,
    idleMs: () => DEFAULT_SESSION_IDLE_MS,
    lastActivity: (session) => { reads.activity++; return input.lastAt(session) },
    executing: () => { reads.executing++; return executingMarks({ directory: input.marks, now: now() }).flatMap(mark => mark.sessions) },
    runningHere: () => false,
    held: () => input.registry.heldSessions(),
    sessions: input.service,
    now,
  })
  return { check, reads }
}

const sixteenMinutesAgo = () => Date.now() - 16 * MINUTE
const ledgerOf = (approvals: string) => JSON.parse(readFileSync(approvals, 'utf8')) as { pending: Array<{ request: { token: string } }>; once: Array<{ token: string }>; resolved: Array<{ decision: { token: string }; grant?: { save: string } }> }
const holders = (grants: ReadonlyArray<{ sessionId: string | null; actor: string | null }>) => grants.map(grant => [grant.sessionId, grant.actor])
const ONE = { sessionId: 'mcp', actor: 'agent:one' }
const TWO = { sessionId: 'mcp', actor: 'agent:two' }

describe('an idle end', () => {
  it('ends the session approvals and lasting denials of every face, and keeps always grants', async () => {
    const { store, registry, service, marks } = setUp()
    const faces = [{ sessionId: 'cli', actor: 'local-owner' }, { sessionId: 'rpc', actor: 'agent:token-1' }, { sessionId: 'mcp', actor: 'agent:token-2' }, { sessionId: 'mcp', actor: 'mcp-stdio' }]
    for (const [index, face] of faces.entries()) await decided(service, await asked(registry, face, `/outside/${index}`), 'session')
    await decided(service, await asked(registry, faces[0]!, '/outside/.env', 'sensitive_path'), 'session', false)
    await decided(service, await asked(registry, faces[1]!, '/outside/kept'), 'always')
    expect(store.list()).toHaveLength(6)

    await idleCheck({ registry, service, marks, lastAt: sixteenMinutesAgo }).check.check()
    expect(store.list().map(grant => [grant.scope, grant.subject])).toEqual([['always', '/outside/kept']])
    await service.close()
  })

  it('ends each session after its own window: another caller\'s session under the same id, active within its window, keeps its grants, onces, and asks', async () => {
    const { store, registry, service, marks } = setUp()
    for (const caller of [ONE, TWO]) {
      await decided(service, await asked(registry, caller, `/outside/${caller.actor}`), 'session')
      await decided(service, await asked(registry, caller, `/outside/${caller.actor}/once`), 'once')
      await asked(registry, caller, `/outside/${caller.actor}/held`)
    }
    const lastAt = (session: GrantHolder) => session.actor === TWO.actor ? Date.now() - 14 * MINUTE : Date.now() - 16 * MINUTE

    await idleCheck({ registry, service, marks, lastAt }).check.check()
    expect(holders(store.list())).toEqual([['mcp', 'agent:two']])
    expect(registry.unspent('mcp').map(once => once.actor)).toEqual(['agent:two'])
    expect(registry.pending().map(request => request.subject)).toEqual(['/outside/agent:two/held'])
    await service.close()
  })

  it('keeps a session while one of its own tools runs, and ends another whose tools do not', async () => {
    const { store, registry, service, marks } = setUp()
    for (const caller of [ONE, TWO]) await decided(service, await asked(registry, caller, `/outside/${caller.actor}`), 'session')
    const run = createExecutingMark({ directory: marks, workspaceId: WORKSPACE, instance: 'here' }).begin(ONE)

    await idleCheck({ registry, service, marks, lastAt: () => Date.now() - 60 * MINUTE }).check.check()
    expect(holders(store.list())).toEqual([['mcp', 'agent:one']])
    run.end()
    await service.close()
  })

  it('checks one session alone where a call names it, reading no other session\'s activity', async () => {
    const { store, registry, service, marks } = setUp()
    for (const caller of [ONE, TWO]) await decided(service, await asked(registry, caller, `/outside/${caller.actor}`), 'session')
    const read: string[] = []
    const { check } = idleCheck({ registry, service, marks, lastAt: (session) => { read.push(session.actor ?? ''); return sixteenMinutesAgo() } })

    await check.check(TWO)
    // Read once, then again under the approvals lock before it ends.
    expect([...new Set(read)]).toEqual(['agent:two'])
    expect(holders(store.list())).toEqual([['mcp', 'agent:one']])
    await service.close()
  })

  it('drops the onces no call spent, and an owed mark, which is never written after', async () => {
    let failing = true
    const { store, registry, service, marks, approvals } = setUp({ grants: inner => ({ ...inner, grant: async (input) => { if (failing) throw new Error('The grants file was busy'); return inner.grant(input) } }) })
    const once = await asked(registry, { sessionId: 'chat-1' }, '/outside/once')
    await decided(service, once, 'once')
    const owed = await asked(registry, { sessionId: 'chat-1' }, '/outside/owed')
    expect(await service.answer({ decision: { token: owed, approved: true, scope: 'session' }, source: SOURCES.cli })).toMatchObject({ ok: true, save: 'owed' })
    expect(registry.unspent('chat-1')).toHaveLength(2)

    await idleCheck({ registry, service, marks, lastAt: sixteenMinutesAgo }).check.check()
    expect(registry.unspent('chat-1')).toEqual([])
    expect(ledgerOf(approvals).resolved.find(entry => entry.decision.token === owed)?.grant?.save).toBe('dropped')
    failing = false
    await registry.recover()
    expect(store.list()).toEqual([])
    await service.close()
  })

  it('withdraws the asks still waiting, which the terminal hears ended with the session', async () => {
    const { registry, service, events, marks } = setUp()
    const call: ApprovalAskInput = { sessionId: 'chat-1', requestId: 'request-held', tool: 'fs_write', call: CALL, asks: [ask('/outside/held')] }
    const [held] = (await service.request(call)).approvals
    expect(registry.pending()).toHaveLength(1)

    await idleCheck({ registry, service, marks, lastAt: sixteenMinutesAgo }).check.check()
    expect(registry.pending()).toEqual([])
    expect(registry.departures([held!.token]).get(held!.token)).toEqual({ type: 'cancelled', reason: 'session_ended' })
    await vi.waitFor(() => expect(events.map(event => ({ type: event.type, reason: event.reason }))).toEqual([{ type: 'cancelled', reason: 'session_ended' }]))
    await service.close()
  })

  it('queues the webhook a cancelled notice for each ask it withdraws, and another process reads that each left as its session ended', async () => {
    const root = scratch()
    const store = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: WORKSPACE })
    const approvals = join(root, 'approvals.json')
    const registry = createApprovalRegistry(store, approvals, 15_000, { durableNotices: true })
    const token = await asked(registry, { sessionId: 'chat-1' }, '/outside/held')

    expect(await registry.endSessions({ ending: { sessions: [{ sessionId: 'chat-1' }] } })).toEqual([expect.objectContaining({ sessionId: 'chat-1', withdrawn: [token] })])
    expect(registry.pendingDeliveries().map(delivery => [delivery.notice.token, delivery.notice.event])).toEqual([[token, 'cancelled']])
    const elsewhere = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: WORKSPACE }), approvals, 15_000)
    expect(elsewhere.departures([token]).get(token)).toEqual({ type: 'cancelled', reason: 'session_ended' })
  })

  it('ends the sessions named, each under its actor, or every caller\'s under one id where a face ends its own', async () => {
    const { store, registry, service } = setUp()
    for (const caller of [ONE, TWO, { sessionId: 'rpc', actor: 'agent:one' }]) await decided(service, await asked(registry, caller, `/outside/${caller.sessionId}/${caller.actor}`), 'session')

    expect((await registry.endSessions({ ending: { sessions: [ONE] } }))?.map(session => [session.sessionId, session.actor])).toEqual([['mcp', 'agent:one']])
    expect(holders(store.list())).toEqual([['mcp', 'agent:two'], ['rpc', 'agent:one']])
    // Read again under the lock: a session `due` no longer names keeps everything, and where it names none, nothing ends.
    expect(await registry.endSessions({ ending: { sessions: [ONE, TWO] }, due: session => session.actor !== TWO.actor })).toEqual([])
    expect(await registry.endSessions({ ending: { sessions: [TWO] }, due: () => false })).toBeNull()
    expect(holders(store.list())).toEqual([['mcp', 'agent:two'], ['rpc', 'agent:one']])
    await decided(service, await asked(registry, ONE, '/outside/again'), 'session')
    expect((await registry.endSessions({ ending: { sessionId: 'mcp' } }))?.map(session => session.actor)).toEqual(['agent:one', 'agent:two'])
    expect(holders(store.list())).toEqual([['rpc', 'agent:one']])
    await service.close()
  })

  it('lists the sessions that hold anything an end removes, each under its actor', async () => {
    const { registry, service } = setUp()
    await decided(service, await asked(registry, ONE, '/outside/a'), 'session')
    await decided(service, await asked(registry, TWO, '/outside/b'), 'once')
    await asked(registry, { sessionId: 'chat-1' }, '/outside/c')
    await decided(service, await asked(registry, { sessionId: 'rpc', actor: 'agent:three' }, '/outside/d'), 'always')

    expect(registry.heldSessions()).toEqual(expect.arrayContaining([ONE, TWO, { sessionId: 'chat-1' }]))
    expect(registry.heldSessions()).toHaveLength(3)
    await service.close()
  })

  it('records one end per session, with its actor, its cause, and what it ended, and none where nothing ended', async () => {
    const { registry, service, audit, marks } = setUp()
    await decided(service, await asked(registry, { sessionId: 'chat-1' }, '/outside/a'), 'session')
    await decided(service, await asked(registry, { sessionId: 'chat-1' }, '/outside/b'), 'once')
    await asked(registry, ONE, '/outside/c')
    const { check } = idleCheck({ registry, service, marks, lastAt: sixteenMinutesAgo })

    await check.check()
    const ended = audit.entries.filter(entry => entry.step === 'session_ended').map(entry => entry.fields)
    expect(ended).toEqual([
      { sessionId: 'chat-1', cause: 'idle', withdrawn: 0, onces: 1, owed: 0, grants: 1, denials: 0 },
      { sessionId: 'mcp', actor: 'agent:one', cause: 'idle', withdrawn: 1, onces: 0, owed: 0, grants: 0, denials: 0 },
    ])
    await createSessionIdleCheck({ workspaceId: WORKSPACE, idleMs: () => DEFAULT_SESSION_IDLE_MS, lastActivity: sixteenMinutesAgo, executing: () => [], runningHere: () => false, held: () => registry.heldSessions(), sessions: service }).check()
    expect(audit.entries.filter(entry => entry.step === 'session_ended')).toHaveLength(2)
    await service.close()
  })

  it('ends nothing where one of the session\'s tools started in another process between its first read and the approvals lock', async () => {
    const { store, registry, service, marks, approvals } = setUp()
    await decided(service, await asked(registry, { sessionId: 'chat-1' }, '/outside/a'), 'session')
    let clock = Date.now()
    const { check, reads } = idleCheck({ registry, service, marks, lastAt: () => clock - 16 * MINUTE, now: () => clock })
    const holder = await holdLockInProcess(`${approvals}.lock.sqlite`)

    const sweeping = check.check()
    await vi.waitFor(() => expect(reads.executing).toBe(1))
    const run = createExecutingMark({ directory: marks, workspaceId: WORKSPACE, instance: 'other' }).begin({ sessionId: 'chat-1' })
    await killHolder(holder)
    await sweeping
    expect(reads.executing).toBe(2)
    expect(store.list()).toHaveLength(1)
    run.end()

    clock += DEFAULT_SESSION_IDLE_MS + 1
    await check.check()
    expect(store.list()).toEqual([])
    await service.close()
  }, 30_000)

  it('keeps a session while its tool in a second process runs longer than the window, and for the window after it stopped', async () => {
    const { store, registry, service, marks } = setUp()
    await decided(service, await asked(registry, { sessionId: 'chat-1' }, '/outside/a'), 'session')
    await decided(service, await asked(registry, { sessionId: 'chat-2' }, '/outside/b'), 'session')
    const second = await runningElsewhere(marks, 'chat-1')
    let clock = Date.now()
    const { check } = idleCheck({ registry, service, marks, lastAt: () => clock - 60 * MINUTE, now: () => clock })

    await check.check()
    expect(store.list().map(grant => grant.sessionId)).toEqual(['chat-1'])
    const stoppedAt = await second.kill()
    clock = stoppedAt + DEFAULT_SESSION_IDLE_MS - ACTIVE_WORK_FRESH_MS
    await check.check()
    expect(store.list()).toHaveLength(1)
    clock = stoppedAt + DEFAULT_SESSION_IDLE_MS + ACTIVE_WORK_FRESH_MS
    await check.check()
    expect(store.list()).toEqual([])
    await service.close()
  }, 30_000)

  it('keeps a session while one of its calls is held for an answer, as another process reads the marks, and ends it a window after the answer', async () => {
    const { store, registry, service, marks } = setUp({ graceMs: null })
    await decided(service, await asked(registry, { sessionId: 'chat-1' }, '/outside/a'), 'session')
    await decided(service, await asked(registry, { sessionId: 'chat-2' }, '/outside/b'), 'session')
    const held = service.request({ sessionId: 'chat-1', requestId: 'request-held', tool: 'fs_write', call: CALL, asks: [ask('/outside/held')] })
    await vi.waitFor(() => expect(executingMarks({ directory: marks }).flatMap(mark => mark.sessions)).toEqual([{ sessionId: 'chat-1' }]))
    let clock = Date.now()
    // Its last call started an hour ago, as the history's activity store would read it.
    let lastAt = clock - 60 * MINUTE
    const { check } = idleCheck({ registry, service, marks, lastAt: () => lastAt, now: () => clock })

    await check.check()
    expect(store.list().map(grant => grant.sessionId)).toEqual(['chat-1'])
    const [waiting] = registry.pending()
    expect(waiting?.subject).toBe('/outside/held')

    await decided(service, waiting!.token, 'once')
    expect(await held).toMatchObject({ settled: true })
    expect(executingMarks({ directory: marks })).toEqual([])
    lastAt = clock
    await check.check()
    expect(store.list().map(grant => grant.sessionId)).toEqual(['chat-1'])
    clock += DEFAULT_SESSION_IDLE_MS + 1
    await check.check()
    expect(store.list()).toEqual([])
    await service.close()
  }, 30_000)

  it('ends nothing, and warns naming the store, where activity cannot be read; no session approval then clears a call until it can', async () => {
    const { store, registry, service, marks } = setUp()
    await decided(service, await asked(registry, { sessionId: 'chat-1' }, '/outside/a'), 'session')
    const warned = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    let clock = Date.now()
    let failing = true
    const check = createSessionIdleCheck({
      workspaceId: WORKSPACE, idleMs: () => DEFAULT_SESSION_IDLE_MS, executing: () => executingMarks({ directory: marks }).flatMap(mark => mark.sessions), runningHere: () => false, held: () => registry.heldSessions(), sessions: service, now: () => clock,
      lastActivity: () => { if (failing) throw new Error('SQLITE_IOERR'); return clock },
    })
    expect(check.sessionApprovalsSuspended({ sessionId: 'chat-1' })).toBe(false)

    await check.check()
    expect(store.list()).toHaveLength(1)
    expect(check.sessionApprovalsSuspended({ sessionId: 'chat-1' })).toBe(true)
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('activity.sqlite'), expect.objectContaining({ workspaceId: WORKSPACE }))
    clock += MINUTE
    await check.check()
    expect(check.sessionApprovalsSuspended({ sessionId: 'chat-1' })).toBe(true)
    expect(warned).toHaveBeenCalledOnce()

    failing = false
    await check.check()
    expect(check.sessionApprovalsSuspended({ sessionId: 'chat-1' })).toBe(false)
    await service.close()
  })

  it('suspends the approvals of the session whose activity cannot be read alone, and ends another that idled', async () => {
    const { store, registry, service, marks } = setUp()
    for (const caller of [ONE, TWO]) await decided(service, await asked(registry, caller, `/outside/${caller.actor}`), 'session')
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { check } = idleCheck({ registry, service, marks, lastAt: (session) => { if (session.actor === ONE.actor) throw new Error('SQLITE_IOERR'); return sixteenMinutesAgo() } })

    await check.check()
    expect(holders(store.list())).toEqual([['mcp', 'agent:one']])
    expect([check.sessionApprovalsSuspended(ONE), check.sessionApprovalsSuspended(TWO)]).toEqual([true, false])
    await service.close()
  })

  it('ends nothing and suspends nothing where the activity store was busy this time, and says nothing of it as a fault', async () => {
    const { store, registry, service, marks } = setUp()
    await decided(service, await asked(registry, { sessionId: 'chat-1' }, '/outside/a'), 'session')
    const warned = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const check = createSessionIdleCheck({
      workspaceId: WORKSPACE, idleMs: () => DEFAULT_SESSION_IDLE_MS, executing: () => executingMarks({ directory: marks }).flatMap(mark => mark.sessions), runningHere: () => false, held: () => registry.heldSessions(), sessions: service,
      lastActivity: () => { throw new ActivityBusyError() },
    })

    await check.check()
    expect(store.list()).toHaveLength(1)
    expect(check.sessionApprovalsSuspended({ sessionId: 'chat-1' })).toBe(false)
    expect(warned).not.toHaveBeenCalled()
    await service.close()
  })

  it('ends nothing and suspends nothing where another process held the approvals lock past its wait, and ends the sessions at the next check', async () => {
    const { store, registry, service, marks, approvals } = setUp({ lockDeadlineMs: 100 })
    await decided(service, await asked(registry, { sessionId: 'chat-1' }, '/outside/a'), 'session')
    const warned = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { check } = idleCheck({ registry, service, marks, lastAt: sixteenMinutesAgo })
    const holder = await holdLockInProcess(`${approvals}.lock.sqlite`)
    try { await check.check() } finally { await killHolder(holder) }
    expect(store.list()).toHaveLength(1)
    expect(check.sessionApprovalsSuspended({ sessionId: 'chat-1' })).toBe(false)
    expect(warned).not.toHaveBeenCalled()

    await check.check()
    expect(store.list()).toEqual([])
    await service.close()
  }, 30_000)

  it('lets activity this process sees after a gap wait for a check, which reads the gap and ends the session', async () => {
    const { store, registry, service, marks } = setUp()
    await decided(service, await asked(registry, { sessionId: 'chat-1' }, '/outside/a'), 'session')
    let clock = Date.now()
    const lastAt = clock
    const { check, reads } = idleCheck({ registry, service, marks, lastAt: () => lastAt, now: () => clock })
    await check.check()
    expect(reads.activity).toBe(1)

    clock += DEFAULT_SESSION_IDLE_MS + 1
    check.saw({ sessionId: 'chat-1' })
    await check.check({ sessionId: 'chat-1' })
    expect(reads.activity).toBeGreaterThan(1)
    expect(store.list()).toEqual([])
    await service.close()
  })

  it('ends nothing when the window is 0', async () => {
    const { store, registry, service } = setUp()
    await decided(service, await asked(registry, { sessionId: 'chat-1' }, '/outside/a'), 'session')
    const lastActivity = vi.fn(sixteenMinutesAgo)
    await createSessionIdleCheck({ workspaceId: WORKSPACE, idleMs: () => 0, lastActivity, executing: () => [], runningHere: () => false, held: () => registry.heldSessions(), sessions: service }).check()
    expect(store.list()).toHaveLength(1)
    expect(lastActivity).not.toHaveBeenCalled()
    await service.close()
  })
})

/** A second process that holds an executing mark for `sessionId` until it is killed; `kill` resolves with when it stopped. */
async function runningElsewhere(directory: string, sessionId: string): Promise<{ kill(): Promise<number> }> {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const script = join(dirname(directory), `running-elsewhere-${process.pid}.mts`)
  writeFileSync(script, `
    import { createExecutingMark } from ${JSON.stringify(new URL('../common/services/workspaces/active-work.ts', import.meta.url).href)};
    createExecutingMark({ directory: process.argv[2], workspaceId: 'w-1', instance: 'second' }).begin({ sessionId: process.argv[3] });
    setInterval(() => {}, 60_000);
    process.stdout.write('running\\n');
  `)
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), script, directory, sessionId], { stdio: ['ignore', 'pipe', 'ignore'] })
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  await new Promise<void>((resolve, reject) => {
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.includes('running\n')) resolve() })
    child.once('exit', code => reject(new Error(`the second process exited with ${code} before its run began`)))
  })
  await new Promise(resolve => setTimeout(resolve, ACTIVE_WORK_REFRESH_MS + 500))
  return {
    async kill() {
      child.kill('SIGKILL')
      await exited
      return Date.now()
    },
  }
}

function captured() {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err += String(chunk); return true })
  return { out: () => out, err: () => err, clear: () => { out = ''; err = '' } }
}
