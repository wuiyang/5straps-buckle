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

const DEVICE = { token: 'token-1', approved: true, scope: 'once' as const, source: SOURCES.devices, proof: 'device' as const, decidedBy: 'key:device-1' }

describe('the logged decision audit', () => {
  it('records a decision as received, then applied, under one auditId in the workspace\'s log', async () => {
    const { actions, audit } = workspaceLog()
    audit.received(DEVICE).applied({ assurance: 'key', repeated: false, grantOwed: true })

    const [attempt, result] = await auditEntries(actions, 10)
    const decision = { token: 'token-1', outcome: 'approve', scope: 'once', source: { id: 'devices', kind: 'devices' }, proof: 'device', decidedBy: 'key:device-1' }
    expect(attempt).toMatchObject({ tool: DECISION_TOOL, event: 'attempt', outcome: 'started', workspaceId: 'w-1', workspaceName: 'The site', sessionId: 'approvals', effects: [], args: decision })
    expect(result).toMatchObject({ tool: DECISION_TOOL, event: 'result', outcome: 'ok', auditId: attempt!.auditId, requestId: attempt!.requestId, args: { ...decision, assurance: 'key', repeated: false, grantOwed: true } })
    expect(DECISION_TOOL).toBe('approval_decision')
  })

  it('records a refused decision with its code, and none of the reason, which may name a path', async () => {
    const { actions, audit } = workspaceLog()
    audit.received({ token: 'token-2', approved: false, scope: 'session', source: SOURCES.cli, proof: 'none' }).refused({ code: 'scope_not_offered' })

    const [attempt, result] = await auditEntries(actions, 10)
    expect(attempt!.args).toEqual({ token: 'token-2', outcome: 'deny', scope: 'session', source: { id: 'cli', kind: 'cli' }, proof: 'none' })
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
    audit.received({ token: 'token-3', approved: true, scope: 'once', source: SOURCES.terminal, proof: 'none' }).failed()

    const entries = await auditEntries(actions, 10)
    expect(entries.map(entry => [entry.event, entry.outcome])).toEqual([['attempt', 'started'], ['result', 'error']])
    expect(entries[1]!.auditId).toBe(entries[0]!.auditId)
  })

  it('names a configured backend by its kind beside its id, as the guard rates it', async () => {
    const { actions, audit } = workspaceLog()
    audit.received({ token: 't', approved: false, scope: 'once', source: { id: 'terminal', kind: 'backend' }, proof: 'none' }).refused({ code: 'approver_not_allowed' })
    expect((await auditEntries(actions, 10))[0]!.args).toMatchObject({ source: { id: 'terminal', kind: 'backend' } })
  })

  it('cuts a token past 200 characters, as every identifier the log keeps', async () => {
    const { actions, audit } = workspaceLog()
    audit.received({ token: 'x'.repeat(5_000), approved: false, scope: 'once', source: SOURCES.forms, proof: 'none' }).refused({ code: 'unknown_ask' })
    expect((await auditEntries(actions, 10)).map(entry => (entry.args as { token: string }).token)).toEqual(['x'.repeat(200), 'x'.repeat(200)])
  })

  it('names who answered, by the key or judge that decided or else the route, as an authenticated actor', async () => {
    const { actions, audit } = workspaceLog()
    const decisions = [
      DEVICE,
      { token: 't-cli', approved: true, scope: 'session' as const, source: SOURCES.cli, proof: 'none' as const },
      { token: 't-terminal', approved: false, scope: 'once' as const, source: SOURCES.terminal, proof: 'none' as const },
      { token: 't-judge', approved: true, scope: 'once' as const, source: SOURCES.judge, proof: 'none' as const, decidedBy: 'judge:jev' },
      { token: 't-forms', approved: true, scope: 'once' as const, source: SOURCES.forms, proof: 'none' as const },
      { token: 't-backend', approved: false, scope: 'once' as const, source: { id: 'pager', kind: 'backend' as const }, proof: 'none' as const },
    ]
    for (const decision of decisions) audit.received(decision).refused({ code: 'unknown_ask' })

    const attempts = (await auditEntries(actions, 20)).filter(entry => entry.event === 'attempt')
    expect(attempts.map(entry => [entry.actorId, entry.actorTrust])).toEqual([
      ['key:device-1', 'authenticated'], ['local-owner', 'authenticated'], ['local-owner', 'authenticated'],
      ['judge:jev', 'authenticated'], ['forms', 'authenticated'], ['backend:pager', 'authenticated'],
    ])
  })

  it('returns at once and never throws while the log will not take a write', () => {
    const { filePath, audit } = workspaceLog()
    mkdirSync(filePath)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const received = audit.received(DEVICE)
    expect(received.applied({ assurance: 'key', repeated: false, grantOwed: false })).toBeUndefined()
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
