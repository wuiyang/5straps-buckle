import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOperationScope, runInScope } from '@5straps/runtime'
import type { InvokeResponse } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { NO_INTERACTION, type Interaction } from '../common/services/approvals/interaction.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction } from './support/interaction.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { SOURCES } from '../common/types/ports/approval-source.js'

// A once and a session grant serve the actor whose call asked, never another actor's call in the same session.

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const NOBODY: Interaction = { requestCli: NO_INTERACTION.requestCli, hold: 'prompt' }
const owner = Symbol('approval-gate-actors')

async function node() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-gate-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, 'one'), { recursive: true })
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' })
  const runtime = await createRuntime({ config, interaction: fixedInteraction(NOBODY) })
  runtimes.push(runtime)
  let sequence = 0
  // The same call, requestId aside, from the actor the transport authenticated, in the one session `shared`.
  const write = (actor: string, path: string, tokens: string[] = []): Promise<InvokeResponse> =>
    runInScope(createOperationScope({ owner, context: { actor } }), () => runtime.invoke({ request: { requestId: `call-${++sequence}`, tool: 'fs_write', args: { path, content: 'a' }, approvalTokens: tokens }, sessionId: 'shared' }))
  const answer = (token: string, scope: 'once' | 'session') => runtime.approvalService.answer({ decision: { token, approved: true, scope }, source: SOURCES.cli })
  return { runtime, write, answer }
}

const tokensOf = (response: InvokeResponse): string[] => {
  if (response.outcome !== 'approval_required') throw new Error(`expected an ask, got ${response.outcome}`)
  return response.approvals.map(approval => approval.token)
}

describe('the approval gate', () => {
  it('spends a once only on a call of the actor that asked, with its token or without it', async () => {
    const { runtime, write, answer } = await node()
    const tokens = tokensOf(await write('agent:one', 'one/a.md'))
    expect(await answer(tokens[0]!, 'once')).toMatchObject({ ok: true })

    expect((await write('agent:two', 'one/a.md', tokens)).outcome).toBe('approval_required')
    expect((await write('agent:two', 'one/a.md')).outcome).toBe('approval_required')
    expect(runtime.approvalGate.unspent('shared')).toEqual([expect.objectContaining({ tool: 'fs_write' })])
    expect(await write('agent:one', 'one/a.md', tokens)).toMatchObject({ outcome: 'ok' })
    expect(runtime.approvalGate.unspent('shared')).toEqual([])
  })

  it('lets a session grant clear the calls of the actor that asked, and asks another actor in the same session', async () => {
    const { runtime, write, answer } = await node()
    const tokens = tokensOf(await write('agent:one', 'one/a.md'))
    expect(await answer(tokens[0]!, 'session')).toMatchObject({ ok: true })
    expect(runtime.grants.list()).toEqual([expect.objectContaining({ rule: 'write_scope', scope: 'session', sessionId: 'shared', actor: 'agent:one' })])

    expect((await write('agent:two', 'one/b.md')).outcome).toBe('approval_required')
    expect(await write('agent:one', 'one/b.md')).toMatchObject({ outcome: 'ok' })
  })

  it('keeps an always grant for every actor', async () => {
    const { runtime, write } = await node()
    await runtime.grants.grant({ sessionId: 'shared', rule: 'write_scope', subject: join(runtime.paths().root, 'one'), scope: 'always' })

    expect(await write('agent:one', 'one/a.md')).toMatchObject({ outcome: 'ok' })
    expect(await write('agent:two', 'one/b.md')).toMatchObject({ outcome: 'ok' })
  })
})
