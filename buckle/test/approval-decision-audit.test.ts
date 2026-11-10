import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approvalDecisionPath, approvalKey, mintApprovalKey, seal, type ApprovalKey } from '@5straps/protocol/envelope'
import { challengeBytes } from '@5straps/protocol/signed-request'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryNonceClaims } from '../common/adapters/approval/memory-nonce-claims.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'
import { actionsPath } from '../common/runtime/config.js'
import { NO_INTERACTION } from '../common/runtime/interaction.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createApprovalService } from '../common/services/approvals/approval-service.js'
import { deviceDecision } from './support/device-decision.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { ApprovalBackend } from '../common/types/ports/approval-backend.js'
import { SOURCES } from '../common/types/ports/approval-source.js'
import type { DecisionAudit } from '../common/types/ports/decision-audit.js'
import { fixedInteraction } from './support/interaction.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { auditEntries, settleAuditLogs } from './support/action-log-writer.js'
import { recordingDecisionAudit } from './support/decision-audit.js'

// The decision audit's seam: told of each decision as received, then applied, refused, or failed. The runtime records each
// one in the workspace's own log through the log service, so a record that cannot be written never blocks an answer.

const roots: string[] = []
const runtimes: CoreRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const IDLE: ApprovalBackend = {
  open: async () => ({ contractVersion: 1, decides: true, scopes: ['once'], cancels: true, revokes: false }),
  submit: async () => ({ kind: 'accepted', refs: [] }),
  notify: async () => undefined,
  close: async () => undefined,
}

async function asked(input: { decisionAudit: DecisionAudit; terminal?: ApprovalBackend; decisionKey?: ApprovalKey }) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-decision-audit-'))
  roots.push(root)
  const registry = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'w-1' }), join(root, 'approvals.json'), 15_000)
  const service = createApprovalService({ registry, workspaceId: 'w-1', serverId: 'node-1', graceMs: 200, hold: async () => 'grace', terminal: IDLE, nonces: createMemoryNonceClaims(), ...input })
  const { requests } = await registry.ask({ tool: 'fs_write', sessionId: 's', requestId: 'r', asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: '/outside/a.md', reason: 'outside', offeredScopes: ['once', 'session'] }], call: CALL, attempt: ATTEMPT })
  return { registry, service, token: requests[0]!.token }
}

const CALL = { arguments: { path: '/outside/a.md' }, cwd: '/w', description: null, effects: [], complete: true as const }
const ATTEMPT = { auditId: 'call-audit-1', requestId: 'write-1' }
const ANSWERED = { rule: 'write_scope', subject: '/outside/a.md', attempt: ATTEMPT }
const NONE = { kind: 'none' }

describe('the decision audit seam', () => {
  it('tells the audit of each decision as received, then applied or refused', async () => {
    const { audit, entries } = recordingDecisionAudit()
    const { service, token } = await asked({ decisionAudit: audit })
    expect(await service.answer({ decision: { token, approved: true, scope: 'always' }, source: SOURCES.cli })).toMatchObject({ ok: false, code: 'scope_not_offered' })
    expect(await service.answer({ decision: { token, approved: true, scope: 'session' }, source: SOURCES.cli })).toMatchObject({ ok: true })
    const decision = { token, approved: true, source: SOURCES.cli, proof: 'none', widen: NONE }
    expect(entries).toEqual([
      { step: 'received', fields: { ...decision, scope: 'always' } },
      { step: 'refused', fields: { ...decision, scope: 'always', code: 'scope_not_offered', call: ANSWERED } },
      { step: 'received', fields: { ...decision, scope: 'session' } },
      { step: 'applied', fields: { ...decision, scope: 'session', assurance: 'local', repeated: false, save: 'saved', call: ANSWERED } },
    ])
    await service.close()
  })

  it('tells the audit the widening each answer asked for and the subject its grant took, and the call a repeat answered', async () => {
    const { audit, entries } = recordingDecisionAudit()
    const { registry, service } = await asked({ decisionAudit: audit })
    const ask = { kind: 'ask' as const, ...PLAIN_MARKS, reason: 'asks', offeredScopes: ['once' as const, 'session' as const, 'always' as const] }
    const [below, host] = (await registry.ask({ tool: 'fs_delete', sessionId: 's', requestId: 'r-2', asks: [{ ...ask, rule: 'write_scope', subject: 'delete:/srv/data/a.txt', widerSubject: 'delete-below:/srv/data' }, { ...ask, rule: 'network_egress', subject: 'api.example.com' }], call: CALL, attempt: { auditId: 'call-audit-2', requestId: 'delete-1' } })).requests
    const attempt = { auditId: 'call-audit-2', requestId: 'delete-1' }
    expect(await service.answer({ decision: { token: below!.token, approved: true, scope: 'session' }, source: SOURCES.cli, widen: 'below' })).toMatchObject({ ok: true })
    expect(await service.answer({ decision: { token: host!.token, approved: true, scope: 'always' }, source: SOURCES.cli, widenTo: '*.example.com' })).toMatchObject({ ok: true })
    expect(await service.answer({ decision: { token: host!.token, approved: true, scope: 'always' }, source: SOURCES.cli, widenTo: '*.example.com' })).toMatchObject({ ok: true, repeated: true })

    const results = entries.filter(entry => entry.step === 'applied').map(entry => entry.fields)
    expect(results.map(fields => [fields.widen, 'widenedTo' in fields ? fields.widenedTo : undefined, fields.call])).toEqual([
      [{ kind: 'below' }, 'delete-below:/srv/data', { rule: 'write_scope', subject: 'delete:/srv/data/a.txt', attempt }],
      [{ kind: 'host', pattern: '*.example.com' }, '*.example.com', { rule: 'network_egress', subject: 'api.example.com', attempt }],
      [{ kind: 'host', pattern: '*.example.com' }, '*.example.com', { rule: 'network_egress', subject: 'api.example.com', attempt }],
    ])
    await service.close()
  })

  // APPROVAL-37 (owner, 2026-11-10): every route a person answers on grants a delete's folder and its subfolders, and the
  // audit names each widening as it names buckle approve --below's.
  it('tells the audit the same widening for a below answer from the terminal, buckle approve, a form, and a device', async () => {
    const { audit, entries } = recordingDecisionAudit()
    const root = mkdtempSync(join(tmpdir(), 'buckle-decision-audit-'))
    roots.push(root)
    const registry = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'w-1' }), join(root, 'approvals.json'), 15_000, { live: () => ({ forms: true }) })
    const service = createApprovalService({ registry, workspaceId: 'w-1', serverId: 'node-1', graceMs: 200, hold: async () => 'grace', terminal: IDLE, nonces: createMemoryNonceClaims(), decisionAudit: audit })
    const below = { kind: 'ask' as const, ...PLAIN_MARKS, rule: 'write_scope' as const, reason: 'asks', offeredScopes: ['once' as const, 'session' as const, 'always' as const] }
    const sources = ['terminal', 'cli', 'forms', 'http-forms', 'devices'] as const
    const tokens = (await registry.ask({ tool: 'fs_delete', sessionId: 's', actor: 'agent:a', requestId: 'r-below', asks: sources.map(source => ({ ...below, subject: `delete:/srv/${source}`, widerSubject: `delete-below:/srv/${source}` })), call: CALL, attempt: ATTEMPT })).requests.map(request => request.token)
    for (const [index, source] of sources.entries()) {
      const token = tokens[index]!
      if (source !== 'devices') {
        expect(await service.answer({ decision: { token, approved: true, scope: 'session' }, source: SOURCES[source], widen: 'below', ...(source === 'http-forms' ? { caller: 'agent:a' } : {}) })).toMatchObject({ ok: true, granted: `delete-below:/srv/${source}` })
        continue
      }
      const challenge = service.challengeListing({ widerSubject: true }).challenges.find(entry => entry.token === token)!.challenge!
      expect(await service.decide(deviceDecision({ token, approved: true, scope: 'session', subject: `delete-below:/srv/${source}`, challenge: challengeBytes(challenge).digest }))).toMatchObject({ status: 'applied', granted: `delete-below:/srv/${source}` })
    }
    const applied = entries.filter(entry => entry.step === 'applied').map(entry => entry.fields)
    expect(applied.map(fields => [fields.source.kind, fields.widen, 'widenedTo' in fields ? fields.widenedTo : undefined, fields.call?.subject])).toEqual(sources.map(source => [source, { kind: 'below' }, `delete-below:/srv/${source}`, `delete:/srv/${source}`]))
    await service.close()
  })

  it('tells the audit of each skip as received, then applied or refused, and of one the ledger could not take as failed', async () => {
    const { audit, entries } = recordingDecisionAudit()
    const { registry, service, token } = await asked({ decisionAudit: audit })
    expect(await service.answer({ decision: { token, approved: true, scope: 'session' }, source: SOURCES.cli })).toMatchObject({ ok: true, save: 'saved' })
    entries.splice(0)

    expect(await service.skip({ token, source: SOURCES.terminal })).toMatchObject({ ok: false, code: 'approver_not_allowed' })
    expect(await service.skip({ token, source: SOURCES.cli })).toEqual({ ok: true, removed: true })
    expect(await service.skip({ token, source: SOURCES.cli })).toEqual({ ok: true, repeated: true })
    vi.spyOn(registry, 'skipSave').mockRejectedValueOnce(new Error('The approvals file is busy'))
    await expect(service.skip({ token, source: SOURCES.cli })).rejects.toThrow('busy')
    const terminal = { token, source: SOURCES.terminal }
    const skip = { token, source: SOURCES.cli }
    expect(entries).toEqual([
      { step: 'skip_received', fields: terminal },
      { step: 'skip_refused', fields: { ...terminal, code: 'approver_not_allowed' } },
      { step: 'skip_received', fields: skip },
      { step: 'skip_applied', fields: { ...skip, repeated: false, removed: true } },
      { step: 'skip_received', fields: skip },
      { step: 'skip_applied', fields: { ...skip, repeated: true, removed: false } },
      { step: 'skip_received', fields: skip },
      { step: 'skip_failed', fields: skip },
    ])
    await service.close()
  })

  it('tells the audit where each answer left its grant: owed, then saved by a retry, then skipped', async () => {
    const { audit, entries } = recordingDecisionAudit()
    const { registry, service, token } = await asked({ decisionAudit: audit })
    const answer = { decision: { token, approved: true, scope: 'session' as const }, source: SOURCES.cli }
    const resolve = registry.resolve.bind(registry)
    vi.spyOn(registry, 'resolve').mockImplementationOnce(async (...input) => ({ ...await resolve(...input), save: 'owed' as const }))
    await service.answer(answer)
    await service.answer(answer)
    vi.spyOn(registry, 'resolve').mockImplementationOnce(async (...input) => ({ ...await resolve(...input), save: 'skipped' as const }))
    await service.answer(answer)
    expect(entries.filter(entry => entry.step === 'applied').map(entry => entry.fields)).toEqual([
      expect.objectContaining({ repeated: false, save: 'owed' }),
      expect.objectContaining({ repeated: true, save: 'saved' }),
      expect.objectContaining({ repeated: true, save: 'skipped' }),
    ])
    await service.close()
  })

  it('tells the audit of a skip whose grant is not confirmed removed as applied, marked unfinished', async () => {
    const { audit, entries } = recordingDecisionAudit()
    const { registry, service, token } = await asked({ decisionAudit: audit })
    vi.spyOn(registry, 'skipSave').mockResolvedValueOnce({ ok: true, unfinished: { stands: true, saveError: 'permission denied' } })
    expect(await service.skip({ token, source: SOURCES.cli })).toMatchObject({ ok: true, unfinished: { stands: true } })
    expect(entries).toEqual([
      { step: 'skip_received', fields: { token, source: SOURCES.cli } },
      { step: 'skip_applied', fields: { token, source: SOURCES.cli, repeated: false, removed: false, unfinished: true } },
    ])
    await service.close()
  })

  it('audits a terminal decision the host refuses before the guard, as received and refused', async () => {
    const { audit, entries } = recordingDecisionAudit()
    const decided = Promise.withResolvers<void>()
    const stray: ApprovalBackend = { ...IDLE, async open(host) {
      void Promise.resolve().then(async () => { await host.decide({ kind: 'plain', decision: { token: 'not-routed', outcome: 'deny', scope: 'once' } }); decided.resolve() })
      return IDLE.open(host)
    } }
    const { service } = await asked({ decisionAudit: audit, terminal: stray })
    void service.request({ sessionId: 's', requestId: 'other', tool: 'fs_write', asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: '/outside/b.md', reason: 'outside', offeredScopes: ['once'] }], wait: { mode: 'none' } })
    await decided.promise
    const decision = { token: 'not-routed', approved: false, scope: 'once', source: SOURCES.terminal, proof: 'none', widen: NONE }
    expect(entries).toEqual([
      { step: 'received', fields: decision },
      { step: 'refused', fields: { ...decision, code: 'approver_not_allowed' } },
    ])
    await service.close()
  })

  it('records a decision the ledger could not take as failed, and the route still hears the error', async () => {
    const { audit, entries } = recordingDecisionAudit()
    const { registry, service, token } = await asked({ decisionAudit: audit })
    vi.spyOn(registry, 'resolve').mockRejectedValue(new Error('The approvals file is busy'))
    await expect(service.answer({ decision: { token, approved: true, scope: 'once' }, source: SOURCES.cli })).rejects.toThrow('busy')
    expect(entries.map(entry => entry.step)).toEqual(['received', 'failed'])
    await service.close()
  })

  it('names the proof that carried each decision', async () => {
    const { audit, entries } = recordingDecisionAudit()
    const { service, token } = await asked({ decisionAudit: audit })
    const challenge = service.challengeListing().challenges.find(entry => entry.token === token)!.challenge!
    await service.decide({ source: 'cli', decision: { token: 'not-asked', outcome: 'deny', scope: 'once' } })
    await service.decide(deviceDecision({ token, approved: true, scope: 'once', challenge: challengeBytes(challenge).digest }))
    await service.decide({ source: 'sealed', body: { token: 'not-asked', approved: false, scope: 'once' } })
    expect(entries.filter(entry => entry.step === 'received').map(entry => entry.fields)).toEqual([
      expect.objectContaining({ source: SOURCES.cli, proof: 'none' }),
      expect.objectContaining({ source: SOURCES.devices, proof: 'device', decidedBy: 'key:device-1' }),
      expect.objectContaining({ source: SOURCES.sealed, proof: 'none' }),
    ])
    await service.close()
  })

  it('names an envelope the paired key sealed as its proof', async () => {
    const { audit, entries } = recordingDecisionAudit()
    const key = approvalKey(mintApprovalKey())
    const { service, token } = await asked({ decisionAudit: audit, decisionKey: key })
    await service.decide({ source: 'sealed', body: seal(key, { method: 'POST', path: approvalDecisionPath('w-1'), body: { token, approved: false, scope: 'once' } }) })
    expect(entries.map(entry => entry.fields)).toEqual([expect.objectContaining({ source: SOURCES.sealed, proof: 'envelope' }), expect.objectContaining({ source: SOURCES.sealed, proof: 'envelope' })])
    await service.close()
  })

  it('records each decision in the workspace\'s own log, as the runtime composes it, joined to the attempt of the call it answered', async () => {
    const { runtime, token } = await askedInRuntime()
    const [subject] = runtime.approvalService.pending().map(request => request.subject)
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'session' }, source: SOURCES.terminal })).toMatchObject({ ok: true })

    const entries = await auditEntries(runtime.actions, 200)
    const call = entries.find(entry => entry.tool === 'fs_write' && entry.event === 'attempt')!
    const decisions = entries.filter(entry => entry.tool === 'approval_decision')
    const decision = { token, outcome: 'approve', scope: 'session', source: { id: 'terminal', kind: 'terminal' }, proof: 'none', widening: { kind: 'none' } }
    expect(decisions).toEqual([
      expect.objectContaining({ event: 'attempt', outcome: 'started', workspaceId: runtime.workspaceId, args: decision }),
      expect.objectContaining({ event: 'result', outcome: 'ok', workspaceId: runtime.workspaceId, args: { ...decision, assurance: 'local', repeated: false, save: 'saved', call: { requestId: 'write-1', auditId: call.auditId, rule: 'write_scope', subject } } }),
    ])
    expect(call.requestId).toBe('write-1')
  })

  it('records each skip in the workspace\'s own log, beside the decision it gave up the save of', async () => {
    const { runtime, token } = await askedInRuntime()
    expect(await runtime.approvalApi.decide({ source: 'cli', decision: { token, outcome: 'approve', scope: 'session' } })).toMatchObject({ status: 'applied', save: 'saved' })
    expect(await runtime.approvalApi.skipSave({ source: 'cli', token })).toEqual({ status: 'skipped', removed: true })

    const skips = (await auditEntries(runtime.actions, 200)).filter(entry => entry.tool === 'approval_decision' && (entry.args as { outcome?: string }).outcome === 'skip_save')
    const skip = { token, outcome: 'skip_save', source: { id: 'cli', kind: 'cli' } }
    expect(skips).toEqual([
      expect.objectContaining({ event: 'attempt', outcome: 'started', actorId: 'local-owner', args: skip }),
      expect.objectContaining({ event: 'result', outcome: 'ok', args: { ...skip, repeated: false, removed: true } }),
    ])
  })

  it('records a device\'s decision with its key, and the setup face\'s plain denial, in the workspace\'s log', async () => {
    const { runtime, token } = await askedInRuntime()
    const challenge = runtime.approvalService.challengeListing().challenges.find(entry => entry.token === token)!.challenge!
    expect(await runtime.approvalApi.decide({ source: 'sealed', body: { token, approved: true, scope: 'once' } })).toMatchObject({ status: 'refused', error: { code: 'capability_exceeded' } })
    expect(await runtime.approvalApi.decide(deviceDecision({ token, approved: true, scope: 'once', challenge: challengeBytes(challenge).digest }))).toMatchObject({ status: 'applied' })

    const results = (await auditEntries(runtime.actions, 200)).filter(entry => entry.tool === 'approval_decision' && entry.event === 'result')
    expect(results.map(entry => [entry.outcome, entry.detail, entry.args])).toEqual([
      ['error', 'capability_exceeded', expect.objectContaining({ source: { id: 'sealed', kind: 'sealed' }, proof: 'none', code: 'capability_exceeded' })],
      ['ok', undefined, expect.objectContaining({ source: { id: 'devices', kind: 'devices' }, proof: 'device', decidedBy: 'key:device-1', assurance: 'key' })],
    ])
  })

  it('applies a decision while the workspace\'s log will not take a write', async () => {
    const { runtime, config, token } = await askedInRuntime()
    rmSync(actionsPath(config), { force: true })
    mkdirSync(actionsPath(config))
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'session' }, source: SOURCES.terminal })).toMatchObject({ ok: true })
    expect(runtime.approvalService.pending()).toEqual([])
  })
})

async function askedInRuntime() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-decision-audit-'))
  roots.push(root)
  mkdirSync(join(root, 'workspace', 'one'), { recursive: true })
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' })
  const runtime = await createRuntime({ config, interaction: fixedInteraction(NO_INTERACTION) })
  runtimes.push(runtime)
  const response = await runtime.invoke({ request: { requestId: 'write-1', tool: 'fs_write', args: { path: 'one/a.md', content: 'a' }, approvalTokens: [] }, sessionId: 's' })
  if (response.outcome !== 'approval_required') throw new Error(`expected an ask, got ${response.outcome}`)
  return { runtime, config, token: response.approvals[0]!.token }
}
