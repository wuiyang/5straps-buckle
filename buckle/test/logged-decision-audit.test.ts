import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { createLoggedDecisionAudit } from '../common/adapters/approval/logged-decision-audit.js'
import { DECISION_TOOL, LOG_DROPPED_TOOL } from '../common/domain/record-tools.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { SOURCES } from '../common/types/ports/approval-source.js'
import { auditEntries, settleAuditLogs } from './support/action-log-writer.js'
import { configFromEnvironment } from './support/workspace-config.js'

// Each decision's record in its workspace's log, through the log service: received as an attempt, then how it ended as
// its result. Nothing waits on it, so a record that cannot be written never holds up an answer.

const roots: string[] = []
const runtimes: CoreRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspaceLog() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-decision-log-'))
  roots.push(root)
  const filePath = join(root, 'actions.jsonl')
  const actions = createFileActionLog(filePath, { workspaceId: 'w-1', workspaceName: () => 'The site' })
  return { filePath, actions, audit: createLoggedDecisionAudit({ actions, workspaceId: 'w-1' }) }
}

const NONE = { kind: 'none' as const }
const DEVICE = { token: 'token-1', approved: true, scope: 'once' as const, source: SOURCES.devices, proof: 'device' as const, decidedBy: 'key:device-1', widen: NONE }
const CALL = { rule: 'write_scope' as const, subject: '/outside/a.md', attempt: { auditId: 'call-audit-1', requestId: 'write-1' } }

describe('the logged decision audit', () => {
  it('records a decision as received, then applied, under one auditId in the workspace\'s log, naming its widening and the call it answered', async () => {
    const { actions, audit } = workspaceLog()
    audit.received(DEVICE).applied({ assurance: 'key', repeated: false, save: 'owed', call: CALL })

    const [attempt, result] = await auditEntries(actions, 10)
    const decision = { token: 'token-1', outcome: 'approve', scope: 'once', source: { id: 'devices', kind: 'devices' }, proof: 'device', decidedBy: 'key:device-1', widening: { kind: 'none' } }
    expect(attempt).toMatchObject({ tool: DECISION_TOOL, event: 'attempt', outcome: 'started', workspaceId: 'w-1', workspaceName: 'The site', sessionId: 'approvals', effects: [], args: decision })
    expect(result).toMatchObject({ tool: DECISION_TOOL, event: 'result', outcome: 'ok', auditId: attempt!.auditId, requestId: attempt!.requestId, args: { ...decision, assurance: 'key', repeated: false, save: 'owed', call: { requestId: 'write-1', auditId: 'call-audit-1', rule: 'write_scope', subject: '/outside/a.md' } } })
    expect(DECISION_TOOL).toBe('approval_decision')
  })

  it('names a widening as it was asked for, then with the subject the grant took in place of the ask\'s own', async () => {
    const { actions, audit } = workspaceLog()
    const cli = { approved: true, source: SOURCES.cli, proof: 'none' as const }
    audit.received({ ...cli, token: 't-below', scope: 'session', widen: { kind: 'below' } }).applied({ assurance: 'local', repeated: false, widenedTo: 'delete-below:/srv/data', call: { rule: 'write_scope', subject: 'delete:/srv/data/a.txt' } })
    audit.received({ ...cli, token: 't-host', scope: 'always', widen: { kind: 'host', pattern: '*.example.com' } }).applied({ assurance: 'local', repeated: false, widenedTo: '*.example.com', call: { rule: 'network_egress', subject: 'api.example.com' } })
    audit.received({ ...cli, token: 't-refused', scope: 'session', widen: { kind: 'below' } }).refused({ code: 'scope_not_offered', call: { rule: 'write_scope', subject: '/outside' } })

    const entries = await auditEntries(actions, 10)
    expect(entries.map(entry => [entry.event, (entry.args as { widening: unknown }).widening])).toEqual([
      ['attempt', { kind: 'below' }], ['result', { kind: 'below', subject: 'delete-below:/srv/data' }],
      ['attempt', { kind: 'host', subject: '*.example.com' }], ['result', { kind: 'host', subject: '*.example.com' }],
      ['attempt', { kind: 'below' }], ['result', { kind: 'below' }],
    ])
    expect(entries.filter(entry => entry.event === 'result').map(entry => (entry.args as { call: unknown }).call)).toEqual([
      { rule: 'write_scope', subject: 'delete:/srv/data/a.txt' }, { rule: 'network_egress', subject: 'api.example.com' }, { rule: 'write_scope', subject: '/outside' },
    ])
  })

  it('names the call as the audit keeps subjects: a command line by its executable and its length, a credential hidden, and every id cut to 200 characters', async () => {
    const { actions, audit } = workspaceLog()
    const long = 'r'.repeat(5_000)
    audit.received({ token: 't', approved: true, scope: 'once', source: SOURCES.cli, proof: 'none', widen: NONE }).refused({ code: 'assurance_too_low', call: { rule: 'destructive_command', subject: 'rm -rf /srv/data', attempt: { auditId: 'call-audit-2', requestId: long } } })

    audit.received({ token: 't-2', approved: true, scope: 'session', source: SOURCES.cli, proof: 'none', widen: { kind: 'below' } }).applied({ assurance: 'local', repeated: false, widenedTo: 'delete-below:/w/token=synthetic-value', call: { rule: 'write_scope', subject: 'delete:/w/token=synthetic-value/a.txt' } })

    const entries = await auditEntries(actions, 10)
    expect((entries[1]!.args as { call: unknown }).call).toEqual({ requestId: 'r'.repeat(200), auditId: 'call-audit-2', rule: 'destructive_command', subject: 'rm [16 characters]' })
    expect(entries[3]!.args).toMatchObject({ widening: { kind: 'below', subject: 'delete-below:/w/token=[redacted]' }, call: { subject: 'delete:/w/token=[redacted]/a.txt' } })
    expect(JSON.stringify(entries)).not.toContain('synthetic-value')
  })

  it('records a refused decision with its code, and none of the reason, which may name a path', async () => {
    const { actions, audit } = workspaceLog()
    audit.received({ token: 'token-2', approved: false, scope: 'session', source: SOURCES.cli, proof: 'none', widen: NONE }).refused({ code: 'scope_not_offered' })

    const [attempt, result] = await auditEntries(actions, 10)
    expect(attempt!.args).toEqual({ token: 'token-2', outcome: 'deny', scope: 'session', source: { id: 'cli', kind: 'cli' }, proof: 'none', widening: { kind: 'none' } })
    expect(result).toMatchObject({ event: 'result', outcome: 'error', auditId: attempt!.auditId, detail: 'scope_not_offered', args: { ...attempt!.args as object, code: 'scope_not_offered' } })
  })

  it('records a skip of an approval\'s save as received, then how it ended, under one auditId, as its route answered', async () => {
    const { actions, audit } = workspaceLog()
    audit.skipReceived({ token: 'token-4', source: SOURCES.forms }).applied({ repeated: false, removed: true })
    audit.skipReceived({ token: 'token-5', source: SOURCES.cli }).refused({ code: 'approver_not_allowed' })
    audit.skipReceived({ token: 'token-6', source: SOURCES.cli }).failed()

    const entries = await auditEntries(actions, 10)
    const skip = (token: string, source: { id: string; kind: string }) => ({ token, outcome: 'skip_save', source })
    expect(entries.map(entry => [entry.tool, entry.event, entry.outcome, entry.actorId, entry.detail, entry.args])).toEqual([
      [DECISION_TOOL, 'attempt', 'started', 'forms', undefined, skip('token-4', { id: 'forms', kind: 'forms' })],
      [DECISION_TOOL, 'result', 'ok', 'forms', undefined, { ...skip('token-4', { id: 'forms', kind: 'forms' }), repeated: false, removed: true }],
      [DECISION_TOOL, 'attempt', 'started', 'local-owner', undefined, skip('token-5', { id: 'cli', kind: 'cli' })],
      [DECISION_TOOL, 'result', 'error', 'local-owner', 'approver_not_allowed', { ...skip('token-5', { id: 'cli', kind: 'cli' }), code: 'approver_not_allowed' }],
      [DECISION_TOOL, 'attempt', 'started', 'local-owner', undefined, skip('token-6', { id: 'cli', kind: 'cli' })],
      [DECISION_TOOL, 'result', 'error', 'local-owner', undefined, skip('token-6', { id: 'cli', kind: 'cli' })],
    ])
    expect(entries[1]!.auditId).toBe(entries[0]!.auditId)
  })

  it('closes a decision that stopped on an error with an error result, so no later process reads it as interrupted', async () => {
    const { actions, audit } = workspaceLog()
    audit.received({ token: 'token-3', approved: true, scope: 'once', source: SOURCES.terminal, proof: 'none', widen: NONE }).failed()

    const entries = await auditEntries(actions, 10)
    expect(entries.map(entry => [entry.event, entry.outcome])).toEqual([['attempt', 'started'], ['result', 'error']])
    expect(entries[1]!.auditId).toBe(entries[0]!.auditId)
  })

  it('names a configured backend by its kind beside its id, as the guard rates it', async () => {
    const { actions, audit } = workspaceLog()
    audit.received({ token: 't', approved: false, scope: 'once', source: { id: 'terminal', kind: 'backend' }, proof: 'none', widen: NONE }).refused({ code: 'approver_not_allowed' })
    expect((await auditEntries(actions, 10))[0]!.args).toMatchObject({ source: { id: 'terminal', kind: 'backend' } })
  })

  it('cuts a token past 200 characters, as every identifier the log keeps', async () => {
    const { actions, audit } = workspaceLog()
    audit.received({ token: 'x'.repeat(5_000), approved: false, scope: 'once', source: SOURCES.forms, proof: 'none', widen: NONE }).refused({ code: 'unknown_ask' })
    expect((await auditEntries(actions, 10)).map(entry => (entry.args as { token: string }).token)).toEqual(['x'.repeat(200), 'x'.repeat(200)])
  })

  it('names who answered, by the key or judge that decided or else the route, as an authenticated actor', async () => {
    const { actions, audit } = workspaceLog()
    const decisions = [
      DEVICE,
      { token: 't-cli', approved: true, scope: 'session' as const, source: SOURCES.cli, proof: 'none' as const, widen: NONE },
      { token: 't-terminal', approved: false, scope: 'once' as const, source: SOURCES.terminal, proof: 'none' as const, widen: NONE },
      { token: 't-judge', approved: true, scope: 'once' as const, source: SOURCES.judge, proof: 'none' as const, decidedBy: 'judge:jev', widen: NONE },
      { token: 't-forms', approved: true, scope: 'once' as const, source: SOURCES.forms, proof: 'none' as const, widen: NONE },
      { token: 't-backend', approved: false, scope: 'once' as const, source: { id: 'pager', kind: 'backend' as const }, proof: 'none' as const, widen: NONE },
    ]
    for (const decision of decisions) audit.received(decision).refused({ code: 'unknown_ask' })

    const attempts = (await auditEntries(actions, 20)).filter(entry => entry.event === 'attempt')
    expect(attempts.map(entry => [entry.actorId, entry.actorTrust])).toEqual([
      ['key:device-1', 'authenticated'], ['local-owner', 'authenticated'], ['local-owner', 'authenticated'],
      ['judge:jev', 'authenticated'], ['forms', 'authenticated'], ['backend:pager', 'authenticated'],
    ])
  })

  it('names an HTTP form answer, and its skip, by the caller its transport authenticated, and one with none by its route', async () => {
    const { actions, audit } = workspaceLog()
    const http = SOURCES['http-forms']
    audit.received({ token: 't-own', approved: true, scope: 'once', source: http, proof: 'none', caller: 'agent:tok-a', widen: NONE }).refused({ code: 'unknown_ask' })
    audit.skipReceived({ token: 't-own', source: http, caller: 'agent:tok-a' }).refused({ code: 'unknown_ask' })
    audit.received({ token: 't-none', approved: true, scope: 'once', source: http, proof: 'none', widen: NONE }).refused({ code: 'unknown_ask' })
    audit.received({ token: 't-stdio', approved: true, scope: 'once', source: SOURCES.forms, proof: 'none', caller: 'mcp-stdio', widen: NONE }).refused({ code: 'unknown_ask' })

    const attempts = (await auditEntries(actions, 20)).filter(entry => entry.event === 'attempt')
    expect(attempts.map(entry => [entry.actorId, (entry.args as { source: unknown }).source])).toEqual([
      ['agent:tok-a', { id: 'http-forms', kind: 'http-forms' }], ['agent:tok-a', { id: 'http-forms', kind: 'http-forms' }],
      ['http-forms', { id: 'http-forms', kind: 'http-forms' }], ['forms', { id: 'forms', kind: 'forms' }],
    ])
  })

  it('lets an HTTP form answer\'s attempt and refusal give way first, as records anyone holding the agent\'s token can make, and keeps what it applied', () => {
    const appended: Array<{ event: string; outcome: string; untrusted: boolean }> = []
    const audit = createLoggedDecisionAudit({ actions: { append: (entry, options) => { appended.push({ event: entry.event ?? 'none', outcome: entry.outcome ?? 'none', untrusted: options?.untrusted === true }) } }, workspaceId: 'w-1' })
    const http = SOURCES['http-forms']
    audit.received({ token: 't-1', approved: true, scope: 'always', source: http, proof: 'none', caller: 'agent:tok-a', widen: NONE }).refused({ code: 'assurance_too_low' })
    audit.skipReceived({ token: 't-2', source: http, caller: 'agent:tok-a' }).refused({ code: 'unknown_ask' })
    audit.received({ token: 't-3', approved: true, scope: 'once', source: http, proof: 'none', caller: 'agent:tok-a', widen: NONE }).applied({ assurance: 'relayed', repeated: false })
    audit.received({ token: 't-4', approved: false, scope: 'session', source: SOURCES.cli, proof: 'none', widen: NONE }).refused({ code: 'scope_not_offered' })

    const given = (event: string, outcome: string, untrusted: boolean) => ({ event, outcome, untrusted })
    expect(appended).toEqual([
      given('attempt', 'started', true), given('result', 'error', true),
      given('attempt', 'started', true), given('result', 'error', true),
      given('attempt', 'started', true), given('result', 'ok', false),
      given('attempt', 'started', false), given('result', 'error', false),
    ])
  })

  it('returns at once and never throws while the log will not take a write', () => {
    const { filePath, audit } = workspaceLog()
    mkdirSync(filePath)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const received = audit.received(DEVICE)
    expect(received.applied({ assurance: 'key', repeated: false, save: 'saved' })).toBeUndefined()
  })
})

describe('a name Buckle writes its own records under', () => {
  it('names no tool, and an agent\'s call under one is refused before anything is written', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-record-names-'))
    roots.push(root)
    mkdirSync(join(root, 'workspace'))
    const runtime = await createRuntime({ config: configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' }) })
    runtimes.push(runtime)
    for (const tool of [DECISION_TOOL, LOG_DROPPED_TOOL, 'cli_grants', 'setup_post_approvals', 'workspace_register']) {
      const answer = await runtime.invoke({ sessionId: 'approvals', request: { requestId: `fake-${tool}`, tool, args: {}, approvalTokens: [] } })
      expect(answer, tool).toMatchObject({ outcome: 'error', error: { code: 'TOOL_NOT_FOUND' } })
    }
    expect(await auditEntries(runtime.actions, 50)).toEqual([])
  })
})
