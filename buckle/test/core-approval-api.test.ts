import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approvalDecisionPath, approvalKey, mintApprovalKey, seal } from '@5straps/protocol/envelope'
import { challengeBytes } from '@5straps/protocol/signed-request'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { FILE_FLOOR_MARKS, PLAIN_MARKS, type PermissionDecision } from '../common/domain/permission/decision.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { decisionRecord } from '../common/services/approvals/core-approval-api.js'
import type { ApprovalService } from '../common/services/approvals/approval-service.js'
import { approvalServiceWithTerminal, fixedInteraction } from './support/interaction.js'

// The core approval API: what `buckle approve`, `buckle approvals --watch`, and `--approve-if-safe` decide through. A
// client names its source by tag; core holds that source, and the decision guard checks the decision as any backend's.

type Ask = Extract<PermissionDecision, { kind: 'ask' }>

const CALL = { arguments: { paths: ['/srv/data/reports/old.csv'] }, cwd: '/workspace', description: 'Delete 1 file', effects: ['delete /srv/data/reports/old.csv'], complete: true as const }
const WIDE: Ask = { kind: 'ask', ...FILE_FLOOR_MARKS, rule: 'write_scope', subject: 'delete:/srv/data/reports', reason: 'Deleting /data/reports/old.csv asks a person', offeredScopes: ['once', 'session', 'always'], widerSubject: 'delete-below:/srv/data/reports' }
const COMMAND: Ask = { kind: 'ask', destructive: true, floor: false, rule: 'destructive_command', subject: 'python3 build.py', reason: 'Runs an interpreter', offeredScopes: ['once', 'session'] }
const HOST: Ask = { kind: 'ask', ...PLAIN_MARKS, rule: 'network_egress', subject: 'api.example.com', reason: 'Reaches a host the policy does not name', offeredScopes: ['once', 'session', 'always'] }

const roots: string[] = []
const services: ApprovalService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function asked(ask: Ask) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-core-api-'))
  roots.push(root)
  const grants = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'w-1' })
  const registry = createApprovalRegistry(grants, join(root, 'approvals.json'), 15_000)
  const service = approvalServiceWithTerminal({ registry, workspaceId: 'w-1', serverId: 'node-1', graceMs: 200, interaction: fixedInteraction() })
  services.push(service)
  const [request] = (await registry.ask({ tool: 'fs_delete', sessionId: 's-1', requestId: 'r-1', asks: [ask], call: CALL })).requests
  const ledger = () => JSON.parse(readFileSync(join(root, 'approvals.json'), 'utf8')) as { once: Array<Record<string, unknown>> }
  return { service, registry, grants, token: request!.token, ledger }
}

describe('the core approval API', () => {
  it('records an --approve-if-safe pass as the judge\'s once, at relayed, bound to the code it rated', async () => {
    const { service, token, ledger } = await asked(COMMAND)
    const receipt = await service.decide({ source: 'judge', decision: { token, outcome: 'approve', scope: 'once' }, rater: 'thorough:openai:gpt-test', code: { key: 'c'.repeat(64), allowed: true } })
    expect(receipt).toEqual({ status: 'applied', state: 'approved', assurance: 'relayed', decision: { token, approved: true, scope: 'once' }, asked: { rule: 'destructive_command', subject: 'python3 build.py' } })
    expect(ledger().once).toMatchObject([{ token, decidedBy: 'judge:thorough:openai:gpt-test', code: { key: 'c'.repeat(64), allowed: true } }])
  })

  it('holds the judge to one call', async () => {
    const { service, token, grants } = await asked(COMMAND)
    const receipt = await service.decide({ source: 'judge', decision: { token, outcome: 'approve', scope: 'session' }, rater: 'thorough:openai:gpt-test' })
    expect(receipt).toMatchObject({ status: 'refused', error: { code: 'assurance_too_low', retryable: false } })
    expect(grants.list()).toEqual([])
  })

  it('grants the ask\'s folder and its subfolders where a person at the node widens below', async () => {
    const { service, token, grants } = await asked(WIDE)
    const receipt = await service.decide({ source: 'cli', decision: { token, outcome: 'approve', scope: 'session', widen: 'below' } })
    expect(receipt).toEqual({ status: 'applied', state: 'approved', assurance: 'local', decision: { token, approved: true, scope: 'session' }, asked: { rule: 'write_scope', subject: 'delete:/srv/data/reports' }, granted: 'delete-below:/srv/data/reports' })
    expect(grants.list()).toMatchObject([{ rule: 'write_scope', subject: 'delete-below:/srv/data/reports', scope: 'session', sessionId: 's-1' }])
  })

  it('reads the wider subject from the ledger, so a widening sent again once its ask left the queue repeats it', async () => {
    const { service, token } = await asked(WIDE)
    const decision = { token, outcome: 'approve' as const, scope: 'always' as const, widen: 'below' as const }
    expect(await service.decide({ source: 'cli', decision })).toMatchObject({ status: 'applied', granted: 'delete-below:/srv/data/reports' })
    expect(service.waitingAsk(token)).toBeUndefined()
    expect(await service.decide({ source: 'cli', decision })).toEqual({ status: 'repeated', state: 'approved', decision: { token, approved: true, scope: 'always' }, asked: { rule: 'write_scope', subject: 'delete:/srv/data/reports' } })
    expect(await service.decide({ source: 'cli', decision: { token, outcome: 'approve', scope: 'always' } })).toMatchObject({ status: 'refused', error: { code: 'conflicting_decision' } })
  })

  it('refuses a widening below where the ask offers no wider subject', async () => {
    const { widerSubject: _none, ...narrow } = WIDE
    const { service, token, grants } = await asked(narrow)
    expect(await service.decide({ source: 'cli', decision: { token, outcome: 'approve', scope: 'session', widen: 'below' } })).toEqual({ status: 'refused', step: 'decision', decision: { token, approved: true, scope: 'session' }, error: { code: 'scope_not_offered', message: 'This ask has no wider subject to grant', retryable: false } })
    expect(grants.list()).toEqual([])
  })

  it('widens a network approval to the host pattern buckle approve --host names', async () => {
    const { service, token, grants } = await asked(HOST)
    const receipt = await service.decide({ source: 'cli', decision: { token, outcome: 'approve', scope: 'always' }, hostPattern: '*.example.com' })
    expect(receipt).toMatchObject({ status: 'applied', widened: { pattern: '*.example.com', askedBy: 'api.example.com' } })
    expect(grants.list()).toMatchObject([{ rule: 'network_egress', subject: '*.example.com', pattern: true, scope: 'always' }])
  })

  it('says why the decision guard refused, in its own words', async () => {
    const { service } = await asked(HOST)
    expect(await service.decide({ source: 'cli', decision: { token: 'no-such-token', outcome: 'deny', scope: 'once' } })).toEqual({ status: 'refused', step: 'decision', decision: { token: 'no-such-token', approved: false, scope: 'once' }, error: { code: 'unknown_ask', message: 'Approval token is unknown or expired', retryable: false } })
  })

  it('approves a decision an enrolled key signed as the devices source, recording the key and its proof deadline', async () => {
    const { service, token, ledger } = await asked(HOST)
    const challenge = service.challengeListing().challenges.find(entry => entry.token === token)!.challenge!
    const deadline = Date.now() + 60_000
    const receipt = await service.decide({ source: 'devices', body: { token, approved: true, scope: 'once', challenge: challengeBytes(challenge).digest }, signedBy: 'key:device-1', proofDeadline: deadline })
    expect(receipt).toMatchObject({ status: 'applied', state: 'approved', assurance: 'key', decision: { token, approved: true, scope: 'once', challenge: challengeBytes(challenge).digest } })
    expect(ledger().once).toMatchObject([{ token, decidedBy: 'key:device-1', expiresAt: new Date(deadline).toISOString() }])
  })

  it('reads a device\'s body as the statement: one that does not parse, or a signed once with no proof deadline, is refused unread', async () => {
    const { service, token, registry } = await asked(HOST)
    expect(await service.decide({ source: 'devices', body: { token, approved: true }, signedBy: 'key:device-1', proofDeadline: Date.now() + 60_000 })).toEqual({ status: 'refused', step: 'statement', error: { code: 'statement_invalid', message: 'Invalid approval decision', retryable: false } })
    expect(await service.decide({ source: 'devices', body: { token, approved: true, scope: 'once', challenge: 'a'.repeat(64) }, signedBy: 'key:device-1' })).toMatchObject({ status: 'refused', step: 'statement' })
    expect(registry.pending().map(request => request.token)).toEqual([token])
  })

  it('takes no subject from a device, whose challenge named the ask\'s own, and names buckle approve --below', async () => {
    const { service, token, grants } = await asked(WIDE)
    const receipt = await service.decide({ source: 'devices', body: { token, approved: true, scope: 'session', subject: WIDE.widerSubject, challenge: 'a'.repeat(64) }, signedBy: 'key:device-1', proofDeadline: Date.now() + 60_000 })
    expect(receipt).toMatchObject({ status: 'refused', step: 'decision', decision: { token, approved: true, scope: 'session', challenge: 'a'.repeat(64) }, error: { code: 'scope_forbidden', message: expect.stringContaining('buckle approve --below') } })
    expect(grants.list()).toEqual([])
  })

  it('denies through the setup bearer\'s plain body as the sealed source, and never approves through it', async () => {
    const { service, token, registry } = await asked(HOST)
    expect(await service.decide({ source: 'sealed', body: { token, approved: true, scope: 'once' } })).toEqual({
      status: 'refused', step: 'decision', decision: { token, approved: true, scope: 'once' },
      error: { code: 'capability_exceeded', message: 'Approval requires an enrolled device key: review and confirm with buckle client approve', retryable: false },
    })
    expect(await service.decide({ source: 'sealed', body: { token, approved: false, scope: 'once' } })).toMatchObject({ status: 'applied', state: 'denied', assurance: 'relayed' })
    expect(registry.wasDenied([token])).toBe(true)
  })

  it('refuses a sealed envelope the node holds no key for at the proof, naming why', async () => {
    const { service, token } = await asked(HOST)
    const sealed = seal(approvalKey(mintApprovalKey()), { method: 'POST', path: approvalDecisionPath('w-1'), body: { token, approved: false, scope: 'once' } })
    expect(await service.decide({ source: 'sealed', body: sealed })).toEqual({ status: 'refused', step: 'proof', error: { code: 'proof_invalid', message: 'unknown_key', retryable: false } })
  })

  it('keeps what a setup decision answered for its audit entry, a command as its executable and its length', async () => {
    const { service, token } = await asked(COMMAND)
    const receipt = await service.decide({ source: 'sealed', body: { token, approved: false, scope: 'once' } })
    expect(decisionRecord(receipt)).toEqual({ token, approved: false, scope: 'once', rule: 'destructive_command', subject: 'python3 [16 characters]' })
  })
})
