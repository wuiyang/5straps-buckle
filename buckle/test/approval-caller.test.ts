import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalDecision, ApprovalRequest } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { rightsOf } from '../common/domain/approval/assurance.js'
import { guardDecision, guardSkip, type DecisionClaim, type LedgerView, type LiveSettings, type RecordedForSkip } from '../common/domain/approval/decision-guard.js'
import { TODAYS_ROUTES } from '../common/domain/approval/routes.js'
import { FILE_FLOOR_MARKS, PLAIN_MARKS, type AskMarks, type PermissionDecision } from '../common/domain/permission/decision.js'
import { NO_INTERACTION, type Interaction } from '../common/runtime/interaction.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import type { ApprovalService } from '../common/services/approvals/approval-service.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { openSettingsFile, settingsPath, WorkspaceSettingsSchema } from '../common/services/workspaces/workspace-settings.js'
import type { ApprovalHost } from '../common/types/ports/approval-backend.js'
import { SOURCES, type ApprovalSource, type FormsFace } from '../common/types/ports/approval-source.js'
import type { DecisionAudit } from '../common/types/ports/decision-audit.js'
import type { GrantStore } from '../common/types/ports/grant-store.js'
import { createFormsBackend } from '../mcp/forms-backend.js'
import { createMcpServer } from '../mcp/server.js'
import { openForms } from '../mcp/open-forms.js'
import { settleAuditLogs } from './support/action-log-writer.js'
import { askFor, fakeHost } from './support/approval-backend-kit.js'
import { approvalServiceWithTerminal, fixedInteraction } from './support/interaction.js'
import { hostTool } from './support/mcp-host-tool.js'
import { configFromEnvironment } from './support/workspace-config.js'

// An HTTP form answer decides only the asks its own caller raised: the actor the transport authenticated, carried from
// the face through the forms backend into core, and compared there with the ask's actor, waiting or decided, right after
// the forms setting and before a repeat is read. A stdio form answer is held to no caller.

const HTTP = SOURCES['http-forms']
const ON: LiveSettings = { forms: true }
const OFF: LiveSettings = { forms: false }
const NOW = Date.now()
const request: ApprovalRequest = { token: 't-1', rule: 'write_scope', subject: '/outside/a', reason: 'outside', tool: 'fs_write', offeredScopes: ['once', 'session', 'always'], expiresAt: new Date(NOW + 600_000).toISOString() }
const once = (approved = true): ApprovalDecision => ({ token: 't-1', approved, scope: 'once' })
const waitingFor = (actor: string | undefined, marks: AskMarks = PLAIN_MARKS): LedgerView => ({ waiting: { request, complete: true, challenges: [], marks, routes: TODAYS_ROUTES, ...(actor === undefined ? {} : { actor }) } })
const decidedFor = (actor: string | undefined): LedgerView => ({ resolved: { decision: once(), request, ...(actor === undefined ? {} : { actor }) } })
const claimOf = (source: ApprovalSource, input: { caller?: string; decision?: ApprovalDecision } = {}): DecisionClaim => ({ decision: input.decision ?? once(), source, ...(input.caller === undefined ? {} : { caller: input.caller }) })
const guard = (claim: DecisionClaim, ledger: LedgerView, live: LiveSettings = ON) => guardDecision({ claim, ledger, now: NOW, live })
const ANOTHER_CALLER = { ok: false, code: 'approver_not_allowed', reason: 'Only the caller that raised this ask answers it through http-forms: answer it at the node' }

describe('the caller check in the decision guard', () => {
  it('decides an ask its own caller raised, and refuses an approval or a denial from another caller while it waits', () => {
    expect(guard(claimOf(HTTP, { caller: 'agent:a' }), waitingFor('agent:a'))).toEqual({ ok: true, apply: {} })
    expect(guard(claimOf(HTTP, { caller: 'agent:a', decision: once(false) }), waitingFor('agent:a'))).toEqual({ ok: true, apply: {} })
    expect(guard(claimOf(HTTP, { caller: 'agent:b' }), waitingFor('agent:a'))).toEqual(ANOTHER_CALLER)
    expect(guard(claimOf(HTTP, { caller: 'agent:b', decision: once(false) }), waitingFor('agent:a'))).toEqual(ANOTHER_CALLER)
  })

  it('refuses another caller before a repeat is read, a different decision too, and gives the caller that raised it its repeat', () => {
    expect(guard(claimOf(HTTP, { caller: 'agent:b' }), decidedFor('agent:a'))).toEqual(ANOTHER_CALLER)
    expect(guard(claimOf(HTTP, { caller: 'agent:b', decision: once(false) }), decidedFor('agent:a'))).toEqual(ANOTHER_CALLER)
    expect(guard(claimOf(HTTP, { caller: 'agent:a' }), decidedFor('agent:a'))).toEqual({ ok: true, repeated: true, asked: { rule: 'write_scope', subject: '/outside/a' } })
  })

  it('refuses an answer that carries no caller, and one to an ask that recorded no actor', () => {
    expect(guard(claimOf(HTTP), waitingFor('agent:a'))).toEqual(ANOTHER_CALLER)
    expect(guard(claimOf(HTTP, { caller: 'agent:a' }), waitingFor(undefined))).toEqual(ANOTHER_CALLER)
    expect(guard(claimOf(HTTP, { caller: 'agent:a' }), decidedFor(undefined))).toEqual(ANOTHER_CALLER)
  })

  it('answers a token the ledger does not hold as unknown, as it does every source', () => {
    expect(guard(claimOf(HTTP, { caller: 'agent:b' }), {})).toMatchObject({ ok: false, code: 'unknown_ask' })
  })

  it('reads the forms setting before the caller: off, another caller\'s answer is refused for the setting', () => {
    expect(guard(claimOf(HTTP, { caller: 'agent:b' }), waitingFor('agent:a'), OFF)).toMatchObject({ ok: false, code: 'approver_not_allowed', reason: expect.stringContaining('approval.forms') })
    expect(guardSkip({ source: HTTP, caller: 'agent:b', recorded: { approved: true, scope: 'session', source: HTTP, actor: 'agent:a' }, live: OFF })).toMatchObject({ ok: false, reason: expect.stringContaining('approval.forms') })
  })

  it('refuses a skip from another caller before the decision or the source that recorded it is read, and lets its own caller skip', () => {
    const recorded = (input: Partial<RecordedForSkip> = {}): RecordedForSkip => ({ approved: true, scope: 'session', source: HTTP, actor: 'agent:a', ...input })
    expect(guardSkip({ source: HTTP, caller: 'agent:b', recorded: recorded(), live: ON })).toEqual(ANOTHER_CALLER)
    expect(guardSkip({ source: HTTP, caller: 'agent:b', recorded: recorded({ scope: 'once' }), live: ON })).toEqual(ANOTHER_CALLER)
    expect(guardSkip({ source: HTTP, caller: 'agent:b', recorded: recorded({ source: SOURCES.cli }), live: ON })).toEqual(ANOTHER_CALLER)
    expect(guardSkip({ source: HTTP, recorded: recorded(), live: ON })).toEqual(ANOTHER_CALLER)
    expect(guardSkip({ source: HTTP, caller: 'agent:a', recorded: recorded(), live: ON })).toEqual({ ok: true })
    expect(guardSkip({ source: HTTP, caller: 'agent:b', recorded: undefined, live: ON })).toMatchObject({ ok: false, code: 'unknown_ask' })
  })

  it('holds a stdio form answer to no caller, nor any other source, so each decides an ask another caller raised', () => {
    const session: ApprovalDecision = { token: 't-1', approved: true, scope: 'session' }
    expect(guard(claimOf(SOURCES.forms, { caller: 'mcp-stdio', decision: session }), waitingFor('agent:a'))).toEqual({ ok: true, apply: {} })
    expect(guard(claimOf(SOURCES.forms, { decision: session }), waitingFor('agent:a'))).toEqual({ ok: true, apply: {} })
    expect(guard(claimOf(SOURCES.forms, { caller: 'mcp-stdio' }), decidedFor('agent:a'))).toMatchObject({ ok: true, repeated: true })
    expect(guardSkip({ source: SOURCES.forms, caller: 'mcp-stdio', recorded: { approved: true, scope: 'session', source: SOURCES.forms, actor: 'agent:a' }, live: ON })).toEqual({ ok: true })
    for (const source of [SOURCES.terminal, SOURCES.cli, SOURCES.devices]) {
      expect(guard(claimOf(source, { caller: 'agent:b', decision: session }), waitingFor('agent:a')), source.id).toEqual({ ok: true, apply: {} })
    }
  })
})

describe('the rights of an HTTP form answer', () => {
  it('rates it local, as a stdio form answer, read while forms are on and bound to its own caller, and routes it to every ask today', () => {
    expect(rightsOf('http-forms')).toMatchObject({ assurance: 'local', approves: true, person: true, whileFormsOn: true, sameCaller: true })
    expect(rightsOf('forms')).not.toHaveProperty('sameCaller')
    expect(TODAYS_ROUTES).toContainEqual({ id: 'http-forms', role: 'decide' })
  })

  it('approves its own caller\'s ask for each scope the ask offers, a floor ask included, as a stdio form answer does, and none of another caller\'s', () => {
    const scoped = (scope: 'session' | 'always'): ApprovalDecision => ({ token: 't-1', approved: true, scope })
    for (const scope of ['session', 'always'] as const) {
      expect(guard(claimOf(HTTP, { caller: 'agent:a', decision: scoped(scope) }), waitingFor('agent:a'))).toEqual({ ok: true, apply: {} })
      expect(guard(claimOf(HTTP, { caller: 'agent:b', decision: scoped(scope) }), waitingFor('agent:a'))).toEqual(ANOTHER_CALLER)
    }
    expect(guard(claimOf(HTTP, { caller: 'agent:a' }), waitingFor('agent:a', FILE_FLOOR_MARKS))).toEqual({ ok: true, apply: {} })
    expect(guard(claimOf(HTTP, { caller: 'agent:a', decision: scoped('session') }), waitingFor('agent:a', FILE_FLOOR_MARKS))).toEqual({ ok: true, apply: {} })
    expect(guard(claimOf(HTTP, { caller: 'agent:b' }), waitingFor('agent:a', FILE_FLOOR_MARKS))).toEqual(ANOTHER_CALLER)
  })
})

const roots: string[] = []
const services: ApprovalService[] = []
const runtimes: CoreRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const service of services.splice(0)) await service.close()
  for (const runtime of runtimes.splice(0)) { runtime.closeWatchers(); await runtime.approvalService.close(); await runtime.history.close() }
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-caller-')))
  roots.push(root)
  return root
}

type Ask = Extract<PermissionDecision, { kind: 'ask' }>
const WRITE: Ask = { kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: '/outside/a', reason: 'outside', offeredScopes: ['once', 'session', 'always'] }
const CALL = { arguments: { path: '/outside/a' }, cwd: '/', description: null, complete: true as const }

/** The store, its first `failing` grant writes refused as a locked grants file refuses them. */
function failingGrants(store: GrantStore, failing: number): GrantStore {
  let left = failing
  return { ...store, grant: async (input) => {
    if (left > 0) { left -= 1; throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) }
    return store.grant(input)
  } }
}

function ledger(input: { failingGrants?: number } = {}) {
  const root = scratch()
  const store = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'w-1' })
  const registry = createApprovalRegistry(failingGrants(store, input.failingGrants ?? 0), join(root, 'approvals.json'), 15_000, { live: () => ON })
  const askBy = async (actor: string) => (await registry.ask({ tool: 'fs_write', sessionId: 's', requestId: `r-${actor}`, actor, asks: [WRITE], call: CALL })).requests[0]!.token
  return { store, registry, askBy }
}

const decision = (token: string, scope: ApprovalDecision['scope'] = 'once', approved = true): ApprovalDecision => ({ token, approved, scope })

describe('the caller in the ledger', () => {
  it('refuses another caller\'s HTTP form answer under the lock and leaves the ask waiting, then lets its own caller\'s once through and its repeat', async () => {
    const { registry, askBy } = ledger()
    const token = await askBy('agent:a')
    expect(await registry.resolve(decision(token), HTTP, { caller: 'agent:b' })).toEqual({ ...ANOTHER_CALLER })
    expect(await registry.resolve(decision(token, 'once', false), HTTP, { caller: 'agent:b' })).toEqual({ ...ANOTHER_CALLER })
    expect(registry.pending().map(asked => asked.token)).toEqual([token])

    expect(await registry.resolve(decision(token), HTTP, { caller: 'agent:a' })).toMatchObject({ ok: true })
    expect(registry.unspent('s')).toEqual([expect.objectContaining({ tool: 'fs_write', actor: 'agent:a' })])
    expect(await registry.resolve(decision(token), HTTP, { caller: 'agent:b' })).toEqual({ ...ANOTHER_CALLER })
    expect(await registry.resolve(decision(token), HTTP, { caller: 'agent:a' })).toMatchObject({ ok: true, repeated: true })
  })

  it('refuses a skip from another HTTP caller as another caller\'s, before the source that recorded the decision is read', async () => {
    const { store, registry, askBy } = ledger({ failingGrants: 1 })
    const token = await askBy('agent:a')
    expect(await registry.resolve(decision(token, 'session'), SOURCES.cli)).toMatchObject({ ok: true, save: 'owed' })
    expect(await registry.skipSave({ token, source: HTTP, caller: 'agent:b' })).toEqual({ ...ANOTHER_CALLER })
    expect(await registry.skipSave({ token, source: HTTP, caller: 'agent:a' })).toMatchObject({ ok: false, code: 'approver_not_allowed', reason: 'cli recorded this decision, so only it may skip its save' })
    await registry.recover()
    expect(store.list()).toEqual([expect.objectContaining({ subject: '/outside/a', scope: 'session', actor: 'agent:a' })])
  })

  it('lets an HTTP form answer decide its own caller\'s ask for the session, writing the grant for that caller, and refuses another caller\'s', async () => {
    const { store, registry, askBy } = ledger()
    const token = await askBy('agent:a')
    expect(await registry.resolve(decision(token, 'session'), HTTP, { caller: 'agent:b' })).toEqual({ ...ANOTHER_CALLER })
    expect(store.list()).toEqual([])
    expect(await registry.resolve(decision(token, 'session'), HTTP, { caller: 'agent:a' })).toMatchObject({ ok: true, save: 'saved' })
    expect(store.list()).toEqual([expect.objectContaining({ subject: '/outside/a', scope: 'session', actor: 'agent:a' })])
  })

  it('lets a stdio form answer decide, for the session, an ask another caller raised, as before', async () => {
    const { store, registry, askBy } = ledger()
    const token = await askBy('agent:a')
    expect(await registry.resolve(decision(token, 'session'), SOURCES.forms, { caller: 'mcp-stdio' })).toMatchObject({ ok: true, save: 'saved' })
    expect(store.list()).toEqual([expect.objectContaining({ subject: '/outside/a', scope: 'session', actor: 'agent:a' })])
  })
})

const accepted = (content: Record<string, unknown>) => ({ action: 'accept', content })

/** A forms backend core opens under one face's forms source, the host it hands over caught as the backend receives it. */
function opened(face: FormsFace) {
  const root = scratch()
  const grants = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'w-1' })
  const registry = createApprovalRegistry(grants, join(root, 'approvals.json'), 15_000, { live: () => ON })
  const heard: ApprovalSource[] = []
  const callers: Array<string | undefined> = []
  const refused: Array<{ token: string; code: string }> = []
  const ending = (token: string) => ({ applied: () => undefined, failed: () => undefined, refused: (refusal: { code: string }) => { refused.push({ token, code: refusal.code }) } })
  const decisionAudit: DecisionAudit = {
    received: (answer) => { heard.push(answer.source); callers.push(answer.caller); return ending(answer.token) },
    skipReceived: (skip) => { heard.push(skip.source); callers.push(skip.caller); return ending(skip.token) },
    sessionEnded: () => undefined,
  }
  const service = approvalServiceWithTerminal({ registry, workspaceId: 'w-1', serverId: 'node-1', graceMs: 200, interaction: fixedInteraction(), decisionAudit })
  services.push(service)
  const backend = createFormsBackend({ workspace: () => ({ id: 'w-1', name: 'Site' }), node: 'node-1', approves: () => false })
  let host: ApprovalHost | undefined
  service.openFormsBackend({ ...backend, open: async (opener) => { host = opener; return backend.open(opener) } }, face)
  const askBy = async (actor: string) => (await registry.ask({ tool: 'fs_write', sessionId: 's', requestId: `r-${actor}`, actor, asks: [WRITE], call: CALL })).requests[0]!.token
  return { registry, grants, backend, heard, callers, refused, askBy, host: () => host! }
}

describe('the caller carried through the forms host core opens', () => {
  it('opens an HTTP face\'s forms under http-forms, sends no answer for another caller\'s ask, refuses and records another caller\'s skip, and decides its own caller\'s', async () => {
    const { registry, backend, heard, callers, refused, askBy, host } = opened('http')
    const token = await askBy('agent:a')
    expect(host().source).toEqual({ id: 'http-forms', kind: 'http-forms' })

    expect((await backend.answer({ [token]: accepted({ approve: true, scope: 'once' }) }, { caller: 'agent:b' })).tokens).toEqual([])
    expect(registry.pending().map(asked => asked.token)).toEqual([token])
    expect(heard).toEqual([])

    expect((await backend.answer({ [token]: accepted({ approve: true, scope: 'once' }) }, { caller: 'agent:a' })).tokens).toEqual([token])
    expect(registry.pending()).toEqual([])
    expect(await host().skipSave(token, { caller: 'agent:b' })).toEqual({ status: 'refused', error: { code: 'approver_not_allowed', message: ANOTHER_CALLER.reason, retryable: false } })
    expect(refused).toEqual([{ token, code: 'approver_not_allowed' }])
    expect(heard).toEqual([HTTP, HTTP])
    expect(callers).toEqual(['agent:a', 'agent:b'])
  })

  it('carries a stdio host\'s caller too, which no check compares: its answer decides another caller\'s ask for the session', async () => {
    const { grants, backend, askBy, host } = opened('stdio')
    const token = await askBy('agent:a')
    expect(host().source).toEqual(SOURCES.forms)
    expect((await backend.answer({ [token]: accepted({ approve: true, scope: 'session' }) }, { caller: 'mcp-stdio' })).tokens).toEqual([token])
    expect(grants.list()).toEqual([expect.objectContaining({ subject: '/outside/a', scope: 'session', actor: 'agent:a' })])
  })
})

describe('the forms backend', () => {
  it('sends the host the sender the face gave with each answer it decides, and none where the face gave none', async () => {
    const backend = createFormsBackend({ workspace: () => ({ id: 'w-1', name: 'Site' }), approves: () => false })
    const host = fakeHost({ routed: [askFor('a'), askFor('b')] })
    await backend.open(host)
    await backend.answer({ a: accepted({ approve: true, scope: 'once' }) }, { caller: 'agent:a' })
    await backend.answer({ b: accepted({ approve: true, scope: 'once' }) })
    expect(host.decided.map(({ at: _at, ...input }) => input)).toEqual([
      { kind: 'plain', decision: { token: 'a', outcome: 'approve', scope: 'once' }, sender: { caller: 'agent:a' } },
      { kind: 'plain', decision: { token: 'b', outcome: 'approve', scope: 'once' } },
    ])
  })
})

/** No terminal, a hold only while this process asks: a gated call answers at once. */
const NOBODY: Interaction = { requestCli: NO_INTERACTION.requestCli, hold: 'prompt' }

async function formsNode() {
  const root = scratch()
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, 'one'), { recursive: true })
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const config = configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: 'caller-agent-token', BUCKLE_ADMIN_TOKEN: 'caller-admin-token',
    BUCKLE_APPROVAL_TIMEOUT_MS: '60000', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs',
  })
  const settings = openSettingsFile({ filePath: settingsPath(config.nodeStateDirectory ?? config.stateDirectory, config.workspaceId), fallback: () => WorkspaceSettingsSchema.parse({ version: 1 }) })
  await settings.update(current => ({ ...current, approval: { ...current.approval, forms: true } }))
  const runtime = await createRuntime({ config, interaction: fixedInteraction(NOBODY) })
  runtimes.push(runtime)
  const server = createMcpServer({ runtime, serverName: 'caller-mcp', version: '0', sessionId: 'mcp', followToolChanges: false, forms: openForms(runtime, { face: 'stdio' }) })
  return { workspace, runtime, write: hostTool(server, 'fs_write') }
}

describe('the MCP face', () => {
  it('passes the actor its transport authenticated as the caller, never one a form answer or the call\'s _meta names', async () => {
    const { workspace, runtime, write } = await formsNode()
    const args = { path: 'one/a.md', content: 'a' }
    expect(await write({ actor: 'agent:tok-a', args })).toMatchObject({ resultType: 'input_required' })
    const [token] = runtime.approvalService.pending().map(asked => asked.token)
    const answers = vi.spyOn(runtime.approvalService, 'answer')
    const forged = { [token!]: accepted({ approve: true, scope: 'once', caller: 'agent:tok-b' }) }
    expect(await write({ actor: 'agent:tok-a', args, responses: forged, meta: { '5straps/caller': 'agent:tok-b', caller: 'agent:tok-b' } })).not.toHaveProperty('isError')
    expect(answers).toHaveBeenCalledTimes(1)
    expect(answers.mock.calls[0]![0]).toMatchObject({ source: SOURCES.forms, caller: 'agent:tok-a' })
    expect(existsSync(join(workspace, 'one', 'a.md')) && readFileSync(join(workspace, 'one', 'a.md'), 'utf8')).toBe('a')
  })
})
