import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOperationScope, runInScope, runInScopeContext } from '@5straps/runtime'
import type { InvokeResponse } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NO_INTERACTION, type Interaction } from '../common/services/approvals/interaction.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction } from './support/interaction.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { SOURCES } from '../common/types/ports/approval-source.js'

// A once and a session grant serve the actor whose call asked, never another actor's call in the same session.

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
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
  return { root, runtime, write, answer }
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

  it('clears no actor\'s call with a session grant or a once kept without an actor, as an earlier build kept them', async () => {
    const { runtime, write, answer } = await node()
    await runtime.grants.grant({ sessionId: 'shared', rule: 'write_scope', subject: join(runtime.paths().root, 'one'), scope: 'session' })
    expect((await write('agent:x', 'one/a.md')).outcome).toBe('approval_required')

    const unnamed = (tokens: string[] = []) => runtime.invoke({ request: { requestId: `unnamed-${tokens.length}`, tool: 'fs_write', args: { path: 'two.md', content: 'a' }, approvalTokens: tokens }, sessionId: 'shared' })
    const tokens = tokensOf(await unnamed())
    expect(await answer(tokens[0]!, 'once')).toMatchObject({ ok: true })
    expect((await write('agent:x', 'two.md', tokens)).outcome).toBe('approval_required')
    expect(runtime.approvalGate.unspent('shared')).toHaveLength(1)
  })

  it('keeps an always grant for every actor', async () => {
    const { runtime, write } = await node()
    await runtime.grants.grant({ sessionId: 'shared', rule: 'write_scope', subject: join(runtime.paths().root, 'one'), scope: 'always' })

    expect(await write('agent:one', 'one/a.md')).toMatchObject({ outcome: 'ok' })
    expect(await write('agent:two', 'one/b.md')).toMatchObject({ outcome: 'ok' })
  })

  it('serves the asking actor\'s session grants to a check a tool makes outside the call\'s context', async () => {
    const { root, runtime } = await node()
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'x.txt'), 'x')
    writeFileSync(join(runtime.paths().root, 'one', 'a.md'), 'a')
    await runtime.grants.grant({ sessionId: 'shared', actor: 'agent:one', rule: 'read_scope', subject: outside, scope: 'session' })
    // The tool asks mid-call from a callback that runs in another context, as an event emitter or a native callback may.
    const elsewhere = createOperationScope({ owner, context: {} })
    const tools = runtime.registry()
    const get = tools.get.bind(tools)
    vi.spyOn(tools, 'get').mockImplementation((name) => {
      const tool = get(name)
      if (name !== 'fs_read') return tool
      return { ...tool, prepare: args => ({ ...tool.prepare(args), execute: async context => ({ reached: await runInScopeContext(elsewhere, () => context.authorizeRead!(join(outside, 'x.txt'))) }) }) }
    })

    const read = await runInScope(createOperationScope({ owner, context: { actor: 'agent:one' } }), () => runtime.invoke({ request: { requestId: 'read-1', tool: 'fs_read', args: { path: 'one/a.md' }, approvalTokens: [] }, sessionId: 'shared' }))
    expect(read).toMatchObject({ outcome: 'ok', output: { reached: true } })
  })
})
