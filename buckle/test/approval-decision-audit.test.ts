import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approvalDecisionPath, approvalKey, mintApprovalKey, seal, type ApprovalKey } from '@5straps/protocol/envelope'
import { challengeBytes } from '@5straps/protocol/signed-request'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryNonceClaims } from '../common/adapters/approval/memory-nonce-claims.js'
import { NO_DECISION_AUDIT } from '../common/adapters/approval/no-decision-audit.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'
import { NO_INTERACTION } from '../common/runtime/interaction.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createApprovalService } from '../common/services/approvals/approval-service.js'
import { mintDeviceProof } from '../common/services/approvals/device-proof.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { ApprovalBackend } from '../common/types/ports/approval-backend.js'
import { SOURCES } from '../common/types/ports/approval-source.js'
import type { DecisionAudit } from '../common/types/ports/decision-audit.js'
import { fixedInteraction } from './support/interaction.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The decision audit's seam: told of each decision as received, then applied or refused. Today's adapter writes no entry
// and a failed entry never blocks an answer; a node may later turn both on.

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const IDLE: ApprovalBackend = {
  open: async () => ({ contractVersion: 1, decides: true, scopes: ['once'], cancels: true, revokes: false }),
  submit: async () => ({ kind: 'accepted', refs: [] }),
  notify: async () => undefined,
  close: async () => undefined,
}

function recordingAudit() {
  const entries: Array<{ step: string; fields: object }> = []
  const audit: DecisionAudit = {
    received: async (fields) => { entries.push({ step: 'received', fields }) },
    applied: async (fields) => { entries.push({ step: 'applied', fields }) },
    refused: async (fields) => { entries.push({ step: 'refused', fields }) },
  }
  return { audit, entries }
}

const BROKEN: DecisionAudit = {
  received: async () => { throw new Error('The audit log is full') },
  applied: async () => { throw new Error('The audit log is full') },
  refused: async () => { throw new Error('The audit log is full') },
}

async function asked(input: { decisionAudit: DecisionAudit; blockOnAuditFailure?: boolean; terminal?: ApprovalBackend; decisionKey?: ApprovalKey }) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-decision-audit-'))
  roots.push(root)
  const registry = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'w-1' }), join(root, 'approvals.json'), 15_000)
  const service = createApprovalService({ registry, workspaceId: 'w-1', serverId: 'node-1', graceMs: 200, hold: async () => 'grace', terminal: IDLE, nonces: createMemoryNonceClaims(), ...input })
  const { requests } = await registry.ask({ tool: 'fs_write', sessionId: 's', requestId: 'r', asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: '/outside/a.md', reason: 'outside', offeredScopes: ['once', 'session'] }], call: { arguments: { path: '/outside/a.md' }, cwd: '/w', description: null, effects: [], complete: true } })
  return { registry, service, token: requests[0]!.token }
}

describe('the decision audit seam', () => {
  it('tells the audit of each decision as received, then applied or refused', async () => {
    const { audit, entries } = recordingAudit()
    const { service, token } = await asked({ decisionAudit: audit })
    expect(await service.answer({ decision: { token, approved: true, scope: 'always' }, source: SOURCES.cli })).toMatchObject({ ok: false, code: 'scope_not_offered' })
    expect(await service.answer({ decision: { token, approved: true, scope: 'session' }, source: SOURCES.cli })).toMatchObject({ ok: true })
    const decision = { token, approved: true, source: SOURCES.cli, proof: 'none' }
    expect(entries).toEqual([
      { step: 'received', fields: { ...decision, scope: 'always' } },
      { step: 'refused', fields: { ...decision, scope: 'always', code: 'scope_not_offered', reason: 'Scope always is not offered for this approval' } },
      { step: 'received', fields: { ...decision, scope: 'session' } },
      { step: 'applied', fields: { ...decision, scope: 'session', assurance: 'local', repeated: false, grantOwed: false } },
    ])
    await service.close()
  })

  it('audits a terminal decision the host refuses before the guard, as received and refused', async () => {
    const { audit, entries } = recordingAudit()
    const decided = Promise.withResolvers<void>()
    const stray: ApprovalBackend = { ...IDLE, async open(host) {
      void Promise.resolve().then(async () => { await host.decide({ kind: 'plain', decision: { token: 'not-routed', outcome: 'deny', scope: 'once' } }); decided.resolve() })
      return IDLE.open(host)
    } }
    const { service } = await asked({ decisionAudit: audit, terminal: stray })
    void service.request({ sessionId: 's', requestId: 'other', tool: 'fs_write', asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: '/outside/b.md', reason: 'outside', offeredScopes: ['once'] }], wait: { mode: 'none' } })
    await decided.promise
    const decision = { token: 'not-routed', approved: false, scope: 'once', source: SOURCES.terminal, proof: 'none' }
    expect(entries).toEqual([
      { step: 'received', fields: decision },
      { step: 'refused', fields: { ...decision, code: 'approver_not_allowed', reason: 'This ask was not routed to the terminal' } },
    ])
    await service.close()
  })

  it('answers as today when the audit cannot be written', async () => {
    const { registry, service, token } = await asked({ decisionAudit: BROKEN })
    expect(await service.answer({ decision: { token, approved: true, scope: 'once' }, source: SOURCES.cli })).toMatchObject({ ok: true })
    expect(registry.pending()).toEqual([])
    await service.close()
  })

  it('leaves the ask waiting when a node blocks a decision whose received entry cannot be written', async () => {
    const { registry, service, token } = await asked({ decisionAudit: BROKEN, blockOnAuditFailure: true })
    expect(await service.answer({ decision: { token, approved: true, scope: 'once' }, source: SOURCES.cli })).toMatchObject({ ok: false, code: 'audit_unavailable' })
    expect(registry.pending().map(request => request.token)).toEqual([token])
    await service.close()
  })

  it('names the proof that carried each decision', async () => {
    const { audit, entries } = recordingAudit()
    const { service, token } = await asked({ decisionAudit: audit })
    const challenge = service.challengeListing().challenges.find(entry => entry.token === token)!.challenge!
    await service.decide({ source: 'cli', decision: { token: 'not-asked', outcome: 'deny', scope: 'once' } })
    await service.decide({ source: 'devices', body: { token, approved: true, scope: 'once', challenge: challengeBytes(challenge).digest }, proof: mintDeviceProof({ keyId: 'device-1', deadline: Date.now() + 60_000 }) })
    await service.decide({ source: 'sealed', body: { token: 'not-asked', approved: false, scope: 'once' } })
    expect(entries.filter(entry => entry.step === 'received').map(entry => entry.fields)).toEqual([
      expect.objectContaining({ source: SOURCES.cli, proof: 'none' }),
      expect.objectContaining({ source: SOURCES.devices, proof: 'device', decidedBy: 'key:device-1' }),
      expect.objectContaining({ source: SOURCES.sealed, proof: 'none' }),
    ])
    await service.close()
  })

  it('names an envelope the paired key sealed as its proof', async () => {
    const { audit, entries } = recordingAudit()
    const key = approvalKey(mintApprovalKey())
    const { service, token } = await asked({ decisionAudit: audit, decisionKey: key })
    await service.decide({ source: 'sealed', body: seal(key, { method: 'POST', path: approvalDecisionPath('w-1'), body: { token, approved: false, scope: 'once' } }) })
    expect(entries.map(entry => entry.fields)).toEqual([expect.objectContaining({ source: SOURCES.sealed, proof: 'envelope' }), expect.objectContaining({ source: SOURCES.sealed, proof: 'envelope' })])
    await service.close()
  })

  it('marks a blocked decision retryable only where sending it again is not refused as a replay', async () => {
    const { service, token } = await asked({ decisionAudit: BROKEN, blockOnAuditFailure: true })
    const challenge = service.challengeListing().challenges.find(entry => entry.token === token)!.challenge!
    expect(await service.decide({ source: 'cli', decision: { token, outcome: 'approve', scope: 'once' } })).toMatchObject({ status: 'refused', error: { code: 'audit_unavailable', retryable: true } })
    expect(await service.decide({ source: 'devices', body: { token, approved: true, scope: 'once', challenge: challengeBytes(challenge).digest }, proof: mintDeviceProof({ keyId: 'device-1', deadline: Date.now() + 60_000 }) })).toMatchObject({ status: 'refused', error: { code: 'audit_unavailable', retryable: false } })
    await service.close()
  })

  it('writes no entry with today\'s audit, which the runtime composes', async () => {
    expect(await NO_DECISION_AUDIT.received({ token: 't', approved: true, scope: 'once', source: SOURCES.terminal, proof: 'none' })).toBeUndefined()
    const root = mkdtempSync(join(tmpdir(), 'buckle-decision-audit-'))
    roots.push(root)
    mkdirSync(join(root, 'workspace', 'one'), { recursive: true })
    mkdirSync(join(root, 'state'), { mode: 0o700 })
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' })
    const runtime = await createRuntime({ config, interaction: fixedInteraction(NO_INTERACTION) })
    runtimes.push(runtime)
    const response = await runtime.invoke({ request: { requestId: 'write-1', tool: 'fs_write', args: { path: 'one/a.md', content: 'a' }, approvalTokens: [] }, sessionId: 's' })
    if (response.outcome !== 'approval_required') throw new Error(`expected an ask, got ${response.outcome}`)
    const before = runtime.actions.read(200)
    expect(await runtime.approvalService.answer({ decision: { token: response.approvals[0]!.token, approved: true, scope: 'session' }, source: SOURCES.terminal })).toMatchObject({ ok: true })
    expect(runtime.actions.read(200)).toEqual(before)
  })
})
