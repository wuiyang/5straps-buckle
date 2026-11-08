import { spawn } from 'node:child_process'
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
import { loadConfig } from '../common/runtime/config.js'
import { logger } from '../common/runtime/log.js'
import { createApprovalRegistry, type ApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createApprovalService, type ApprovalAskInput, type ApprovalService } from '../common/services/approvals/approval-service.js'
import { createSessionIdleCheck } from '../common/services/approvals/session-idle-check.js'
import { openHistoryActivity } from '../common/services/history/activity.js'
import { ACTIVE_WORK_FRESH_MS, ACTIVE_WORK_REFRESH_MS, createExecutingMark, executingInstances } from '../common/services/workspaces/active-work.js'
import { openSettingsFile, resolveSettings, settingsPath, WorkspaceSettingsSchema } from '../common/services/workspaces/workspace-settings.js'
import type { ApprovalBackend, LifecycleEvent } from '../common/types/ports/approval-backend.js'
import { SOURCES } from '../common/types/ports/approval-source.js'
import type { GrantStore } from '../common/types/ports/grant-store.js'
import { recordingDecisionAudit } from './support/decision-audit.js'
import { runCli } from './support/cli.js'
import { holdLockInProcess, killHolder } from './support/lock-holder.js'
import { idOf, workspacesOf } from './support/workspaces.js'

// Session end at idle: a session ends once the workspace has had no activity for longer than its window, 15 minutes unless
// set. Activity is a running tool, a call starting or ending, an ask, and a decision, never a call waiting for a person.
// Where activity cannot be read, no session ends, and a session approval older than the window clears no call.

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
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

  it('takes, where the store holds no activity, the newest session grant\'s making as the last activity', () => {
    const made = (scope: string, at: number) => ({ scope, createdAt: new Date(at).toISOString() })
    expect(newestSessionGrant([])).toBeUndefined()
    expect(newestSessionGrant([made('always', NOW)])).toBeUndefined()
    expect(newestSessionGrant([made('session', NOW - MINUTE), made('session', NOW - 5), made('always', NOW)])).toBe(NOW - 5)
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
    const refused = await settings(['set', 'approval-session-idle', '10'])
    expect(refused.exitCode).toBe(1)
    expect(refused.printed).toContain('BUCKLE_APPROVAL_SESSION_IDLE_MS is milliseconds')
  })
})

describe('the activity store', () => {
  it('reads the newest activity of any session, or the workspace\'s own row that asks and decisions touch', async () => {
    const directory = scratch()
    const activity = await openHistoryActivity(directory)
    expect(activity.latest()).toBeUndefined()
    activity.observe({ session: 'chat-1', at: NOW, idleMs: MINUTE })
    activity.observe({ session: 'chat-2', at: NOW + 5, idleMs: MINUTE })
    expect(activity.latest()).toBe(NOW + 5)
    activity.touch(NOW + 9)
    activity.touch(NOW + 7)
    expect(activity.latest()).toBe(NOW + 9)
    await activity.close()
    const reopened = await openHistoryActivity(directory)
    expect(reopened.latest()).toBe(NOW + 9)
    await reopened.close()
  })

  it('counts its in-memory fallback as unknown: latest throws where the store could not be opened', async () => {
    const directory = scratch()
    mkdirSync(join(directory, 'activity.sqlite'))
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const activity = await openHistoryActivity(directory)
    activity.observe({ session: 'chat-1', at: NOW, idleMs: MINUTE })
    activity.touch(NOW)
    expect(() => activity.latest()).toThrow()
    await activity.close()
  })
})

const WORKSPACE = 'w-1'

/** One workspace's ledger and service, as a node composes them, with a terminal that keeps asking until core stops it. */
function setUp(options: { grants?: (store: GrantStore) => GrantStore } = {}) {
  const root = scratch()
  const store = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: WORKSPACE })
  const grants = options.grants ? options.grants(store) : store
  const approvals = join(root, 'approvals.json')
  const registry = createApprovalRegistry(grants, approvals, 15_000)
  const events: LifecycleEvent[] = []
  const terminal: ApprovalBackend = {
    open: async () => ({ contractVersion: 1, decides: true, scopes: ['once'], cancels: true, revokes: false }),
    submit: (_asks, context) => new Promise(resolve => context.signal.addEventListener('abort', () => resolve({ kind: 'accepted', refs: [] }), { once: true })),
    async notify(sent) { events.push(...sent) },
    close: async () => undefined,
  }
  const audit = recordingDecisionAudit()
  const service = createApprovalService({ registry, workspaceId: WORKSPACE, serverId: 'node-1', graceMs: 200, hold: async () => 'grace', terminal, nonces: createMemoryNonceClaims(), decisionAudit: audit.audit })
  const marks = join(root, 'active-work')
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

/** The idle check over the ledger, with the workspace's last activity `idleFor` ago and the marks in `marks`. */
function idleCheck(input: { service: ApprovalService; marks: string; lastAt: () => number | undefined; now?: () => number }) {
  const now = input.now ?? Date.now
  const reads = { activity: 0, executing: 0 }
  const check = createSessionIdleCheck({
    workspaceId: WORKSPACE,
    idleMs: () => DEFAULT_SESSION_IDLE_MS,
    lastActivity: () => { reads.activity++; return input.lastAt() },
    executing: () => { reads.executing++; return executingInstances({ directory: input.marks, now: now() }) },
    runningHere: () => false,
    sessions: input.service,
    now,
  })
  return { check, reads }
}

const sixteenMinutesAgo = () => Date.now() - 16 * MINUTE
const ledgerOf = (approvals: string) => JSON.parse(readFileSync(approvals, 'utf8')) as { pending: Array<{ request: { token: string } }>; once: Array<{ token: string }>; resolved: Array<{ decision: { token: string }; grant?: { save: string } }> }

describe('an idle end', () => {
  it('ends the session approvals and lasting denials of every face, and keeps always grants', async () => {
    const { store, registry, service, marks } = setUp()
    const faces = [{ sessionId: 'cli', actor: 'local-owner' }, { sessionId: 'rpc', actor: 'agent:token-1' }, { sessionId: 'mcp', actor: 'agent:token-2' }, { sessionId: 'mcp', actor: 'mcp-stdio' }]
    for (const [index, face] of faces.entries()) await decided(service, await asked(registry, face, `/outside/${index}`), 'session')
    await decided(service, await asked(registry, faces[0]!, '/outside/.env', 'sensitive_path'), 'session', false)
    await decided(service, await asked(registry, faces[1]!, '/outside/kept'), 'always')
    expect(store.list()).toHaveLength(6)

    await idleCheck({ service, marks, lastAt: sixteenMinutesAgo }).check.check()
    expect(store.list().map(grant => [grant.scope, grant.subject])).toEqual([['always', '/outside/kept']])
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

    await idleCheck({ service, marks, lastAt: sixteenMinutesAgo }).check.check()
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

    await idleCheck({ service, marks, lastAt: sixteenMinutesAgo }).check.check()
    expect(registry.pending()).toEqual([])
    expect(registry.departures([held!.token]).get(held!.token)).toEqual({ type: 'cancelled', reason: 'session_ended' })
    await vi.waitFor(() => expect(events.map(event => ({ type: event.type, reason: event.reason }))).toEqual([{ type: 'cancelled', reason: 'session_ended' }]))
    await service.close()
  })

  it('records one end per session, with its cause and what it ended, and none where nothing ended', async () => {
    const { registry, service, audit, marks } = setUp()
    await decided(service, await asked(registry, { sessionId: 'chat-1' }, '/outside/a'), 'session')
    await decided(service, await asked(registry, { sessionId: 'chat-1' }, '/outside/b'), 'once')
    await asked(registry, { sessionId: 'chat-2' }, '/outside/c')
    const { check } = idleCheck({ service, marks, lastAt: sixteenMinutesAgo })

    await check.check()
    const ended = audit.entries.filter(entry => entry.step === 'session_ended').map(entry => entry.fields)
    expect(ended).toEqual([
      { sessionId: 'chat-1', cause: 'idle', withdrawn: 0, onces: 1, owed: 0, grants: 1, denials: 0 },
      { sessionId: 'chat-2', cause: 'idle', withdrawn: 1, onces: 0, owed: 0, grants: 0, denials: 0 },
    ])
    await createSessionIdleCheck({ workspaceId: WORKSPACE, idleMs: () => DEFAULT_SESSION_IDLE_MS, lastActivity: sixteenMinutesAgo, executing: () => [], runningHere: () => false, sessions: service }).check()
    expect(audit.entries.filter(entry => entry.step === 'session_ended')).toHaveLength(2)
    await service.close()
  })

  it('ends nothing where a tool started in another process between its first read and the approvals lock', async () => {
    const { store, registry, service, marks, approvals } = setUp()
    await decided(service, await asked(registry, { sessionId: 'chat-1' }, '/outside/a'), 'session')
    let clock = Date.now()
    const { check, reads } = idleCheck({ service, marks, lastAt: () => clock - 16 * MINUTE, now: () => clock })
    const holder = await holdLockInProcess(`${approvals}.lock.sqlite`)

    const sweeping = check.check()
    await vi.waitFor(() => expect(reads.executing).toBe(1))
    const run = createExecutingMark({ directory: marks, workspaceId: WORKSPACE, instance: 'other' }).begin()
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

  it('keeps every session while a tool in a second process runs longer than the window, and for the window after it stopped', async () => {
    const { store, registry, service, marks } = setUp()
    await decided(service, await asked(registry, { sessionId: 'chat-1' }, '/outside/a'), 'session')
    const second = await runningElsewhere(marks)
    let clock = Date.now()
    const { check } = idleCheck({ service, marks, lastAt: () => clock - 60 * MINUTE, now: () => clock })

    await check.check()
    expect(store.list()).toHaveLength(1)
    const stoppedAt = await second.kill()
    clock = stoppedAt + DEFAULT_SESSION_IDLE_MS - ACTIVE_WORK_FRESH_MS
    await check.check()
    expect(store.list()).toHaveLength(1)
    clock = stoppedAt + DEFAULT_SESSION_IDLE_MS + ACTIVE_WORK_FRESH_MS
    await check.check()
    expect(store.list()).toEqual([])
    await service.close()
  }, 30_000)

  it('ends nothing, and warns naming the store, where activity cannot be read; a session approval older than the window then clears no call', async () => {
    const { store, registry, service, marks } = setUp()
    await decided(service, await asked(registry, { sessionId: 'chat-1' }, '/outside/a'), 'session')
    const warned = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    let clock = Date.now()
    const check = createSessionIdleCheck({
      workspaceId: WORKSPACE, idleMs: () => DEFAULT_SESSION_IDLE_MS, executing: () => [], runningHere: () => false, sessions: service, now: () => clock,
      lastActivity: () => { throw new Error('SQLITE_IOERR') },
    })
    expect(check.sessionsFrom()).toBeUndefined()

    await check.check()
    expect(store.list()).toHaveLength(1)
    expect(check.sessionsFrom()).toBe(clock - DEFAULT_SESSION_IDLE_MS)
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('activity.sqlite'), expect.objectContaining({ workspaceId: WORKSPACE }))
    clock += MINUTE
    await check.check()
    expect(check.sessionsFrom()).toBe(clock - DEFAULT_SESSION_IDLE_MS)
    expect(warned).toHaveBeenCalledOnce()
    await service.close()
  })

  it('ends nothing when the window is 0', async () => {
    const { store, registry, service } = setUp()
    await decided(service, await asked(registry, { sessionId: 'chat-1' }, '/outside/a'), 'session')
    const lastActivity = vi.fn(sixteenMinutesAgo)
    await createSessionIdleCheck({ workspaceId: WORKSPACE, idleMs: () => 0, lastActivity, executing: () => [], runningHere: () => false, sessions: service }).check()
    expect(store.list()).toHaveLength(1)
    expect(lastActivity).not.toHaveBeenCalled()
    await service.close()
  })
})

/** A second process that holds an executing mark until it is killed; `kill` resolves with when it stopped. */
async function runningElsewhere(directory: string): Promise<{ kill(): Promise<number> }> {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const script = join(dirname(directory), `running-elsewhere-${process.pid}.mts`)
  writeFileSync(script, `
    import { createExecutingMark } from ${JSON.stringify(new URL('../common/services/workspaces/active-work.ts', import.meta.url).href)};
    createExecutingMark({ directory: process.argv[2], workspaceId: 'w-1', instance: 'second' }).begin();
    setInterval(() => {}, 60_000);
    process.stdout.write('running\\n');
  `)
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), script, directory], { stdio: ['ignore', 'pipe', 'ignore'] })
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
