import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../common/runtime/config.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'

// Review M4 of the second proof-of-possession re-review (keys-provisioning.md: every grant consumption is
// logged with key identity and scope): a call that used a session or always grant a person's key decided
// named only the rule; the key stayed on the grant record, which session end or a revoke removes.

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
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
  const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '1' })
  const runtime = await createRuntime({ config })
  runtimes.push(runtime)
  return { root, runtime }
}

function write(runtime: BuckleRuntime, requestId: string, path: string): Promise<InvokeResponse> {
  return runtime.invoke({ sessionId: 'chat-1', request: { requestId, tool: 'fs_write', args: { path, content: 'x' }, approvalTokens: [], context: { approvalWait: { mode: 'none' } } } })
}

function resultOf(runtime: BuckleRuntime, requestId: string) {
  return runtime.actions.read(200).filter(entry => entry.event === 'result' && entry.requestId === requestId).at(-1)
}

describe('a call that uses a standing grant', () => {
  it.each(['session', 'always'] as const)('names the key that decided a %s grant, and its scope, on its audit entry', async (scope) => {
    const { root, runtime } = await node()
    const asked = await write(runtime, 'ask-1', join(root, 'outside', 'a.txt'))
    if (asked.outcome !== 'approval_required') throw new Error(`expected an ask, got ${asked.outcome}`)
    const decided = await runtime.approvalService.answer({ decision: { token: asked.approvals[0]!.token, approved: true, scope }, authority: 'admin', decidedBy: KEY })
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
    expect((await runtime.approvalService.answer({ decision: { token: asked.approvals[0]!.token, approved: true, scope: 'session' }, authority: 'admin' })).ok).toBe(true)
    expect(await write(runtime, 'use-2', join(root, 'outside', 'b.txt'))).toMatchObject({ outcome: 'ok' })
    const entry = resultOf(runtime, 'use-2')!
    expect(entry.grantUses).toEqual([{ rule: 'write_scope', scope: 'session' }])
    expect(entry.decidedBy).toBeUndefined()
  })
})
