import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActionReportSchema, type ActionReport, type InvokeResponse } from '@5straps/protocol'
import { createOperationScope, runInScope } from '@5straps/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { configFromEnvironment } from './support/workspace-config.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { SOURCES } from '../common/types/ports/approval-source.js'

// Review M4 of the second proof-of-possession re-review (keys-provisioning.md: every grant consumption is
// logged with key identity and scope): a call that used a session or always grant a person's key decided
// named only the rule; the key stayed on the grant record, which session end or a revoke removes.

const roots: string[] = []
const runtimes: CoreRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const KEY = 'key:SHA256:grantUseProbeKeyFingerprintForTestsOnly000000'

async function node() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-grant-use-'))
  roots.push(root)
  mkdirSync(join(root, 'workspace'))
  mkdirSync(join(root, 'outside'))
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '1' })
  const reports: ActionReport[] = []
  const runtime = await createRuntime({ config, reporter: { configured: true, record: entry => { reports.push(entry) }, report: async () => {}, flush: async () => {} } })
  runtimes.push(runtime)
  return { root, runtime, reports }
}

function write(runtime: CoreRuntime, requestId: string, path: string): Promise<InvokeResponse> {
  return runtime.invoke({ sessionId: 'chat-1', request: { requestId, tool: 'fs_write', args: { path, content: 'x' }, approvalTokens: [], context: { approvalWait: { mode: 'none' } } } })
}

function resultOf(runtime: CoreRuntime, requestId: string) {
  return runtime.actions.read(200).filter(entry => entry.event === 'result' && entry.requestId === requestId).at(-1)
}

describe('a call that uses a standing grant', () => {
  it.each(['session', 'always'] as const)('names the key that decided a %s grant, and its scope, on its audit entry', async (scope) => {
    const { root, runtime } = await node()
    const asked = await write(runtime, 'ask-1', join(root, 'outside', 'a.txt'))
    if (asked.outcome !== 'approval_required') throw new Error(`expected an ask, got ${asked.outcome}`)
    const decided = await runtime.approvalService.answer({ decision: { token: asked.approvals[0]!.token, approved: true, scope }, source: SOURCES.cli, decidedBy: KEY })
    expect(decided.ok).toBe(true)
    // A later call, another requestId and file, that the grant lets through.
    expect(await write(runtime, 'use-1', join(root, 'outside', 'b.txt'))).toMatchObject({ outcome: 'ok' })
    expect(resultOf(runtime, 'use-1')).toMatchObject({ outcome: 'ok', approvedBy: ['write_scope'], decidedBy: [KEY], grantUses: [{ rule: 'write_scope', scope, decidedBy: KEY }] })
    // The entry names the grant by rule and scope, never its subject.
    expect(JSON.stringify(resultOf(runtime, 'use-1')!.grantUses)).not.toContain(root)
  })

  it('names the scope of a grant no key decided, and no key', async () => {
    const { root, runtime } = await node()
    const asked = await write(runtime, 'ask-2', join(root, 'outside', 'a.txt'))
    if (asked.outcome !== 'approval_required') throw new Error(`expected an ask, got ${asked.outcome}`)
    expect((await runtime.approvalService.answer({ decision: { token: asked.approvals[0]!.token, approved: true, scope: 'session' }, source: SOURCES.cli })).ok).toBe(true)
    expect(await write(runtime, 'use-2', join(root, 'outside', 'b.txt'))).toMatchObject({ outcome: 'ok' })
    const entry = resultOf(runtime, 'use-2')!
    expect(entry.grantUses).toEqual([{ rule: 'write_scope', scope: 'session' }])
    expect(entry.decidedBy).toBeUndefined()
  })
})

// GPT review of c71dee5: the caller's context.actorId was recorded as the actor (requester attribution), and the
// report forwarded to Rings left out the deciding key and the grants a call used (reported audit fields).
describe('who a call is attributed to, locally and in its report', () => {
  const owner = Symbol('grant-use-audit')
  const asAgent = <T>(actor: string, run: () => Promise<T>) => runInScope(createOperationScope({ owner, context: { actor } }), run)
  const invoke = (runtime: CoreRuntime, requestId: string, path: string, actorId?: string) => runtime.invoke({ sessionId: 'chat-1', request: { requestId, tool: 'fs_write', args: { path, content: 'x' }, approvalTokens: [], context: { approvalWait: { mode: 'none' }, ...(actorId === undefined ? {} : { actorId }) } } })

  it('keeps the authenticated actor when a caller forges another requester, beside the claim, and forwards both with the grant attribution', async () => {
    const { root, runtime, reports } = await node()
    const asked = await asAgent('agent:token-a', () => invoke(runtime, 'ask-3', join(root, 'outside', 'a.txt')))
    if (asked.outcome !== 'approval_required') throw new Error(`expected an ask, got ${asked.outcome}`)
    expect((await runtime.approvalService.answer({ decision: { token: asked.approvals[0]!.token, approved: true, scope: 'session' }, source: SOURCES.cli, decidedBy: KEY })).ok).toBe(true)
    expect(await asAgent('agent:token-a', () => invoke(runtime, 'forged-3', join(root, 'outside', 'b.txt'), 'agent:someone-else'))).toMatchObject({ outcome: 'ok' })
    expect(resultOf(runtime, 'forged-3')).toMatchObject({ actorId: 'agent:token-a', actorTrust: 'authenticated', claimedActorId: 'agent:someone-else', claimedActorTrust: 'claimed' })
    const reported = reports.find(report => report.requestId === 'forged-3' && report.outcome === 'ok')!
    expect(reported).toMatchObject({ actor: { id: 'agent:token-a', trust: 'authenticated' }, claimedActorId: 'agent:someone-else', decidedBy: [KEY], grantUses: [{ rule: 'write_scope', scope: 'session', decidedBy: KEY }] })
    // The fields are additive: Rings' schema reads them, and one built before them strips them.
    expect(ActionReportSchema.parse(reported)).toMatchObject({ actor: reported.actor, decidedBy: [KEY] })
  })

  it('keeps the transport attribution of a call that names no requester, and claims nothing', async () => {
    const { root, runtime, reports } = await node()
    await asAgent('agent:token-b', () => invoke(runtime, 'plain-4', join(root, 'workspace', 'a.txt')))
    const entry = resultOf(runtime, 'plain-4')!
    expect(entry).toMatchObject({ actorId: 'agent:token-b', actorTrust: 'authenticated' })
    expect(entry).not.toHaveProperty('claimedActorId')
    const reported = reports.find(report => report.requestId === 'plain-4')!
    expect(reported.actor).toEqual({ id: 'agent:token-b', trust: 'authenticated' })
    expect(reported).not.toHaveProperty('claimedActorId')
  })
})
