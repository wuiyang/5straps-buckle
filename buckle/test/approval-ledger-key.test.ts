import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { approvalsPath, type BuckleConfig } from '../common/runtime/config.js'
import { NO_INTERACTION, type Interaction } from '../common/services/approvals/interaction.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction } from './support/interaction.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The ask ledger is keyed by the workspace's id, as its grants and its state directory are, so a moved folder keeps its asks.

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const NOBODY: Interaction = { requestCli: NO_INTERACTION.requestCli, hold: 'prompt' }

function setUp() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-ledger-key-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, 'one'), { recursive: true })
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' })
  return { root, workspace, config }
}

async function open(config: BuckleConfig): Promise<BuckleRuntime> {
  const runtime = await createRuntime({ config, interaction: fixedInteraction(NOBODY) })
  runtimes.push(runtime)
  return runtime
}

const write = (runtime: BuckleRuntime, path: string): Promise<InvokeResponse> =>
  runtime.invoke({ request: { requestId: `write-${path}`, tool: 'fs_write', args: { path, content: 'a' }, approvalTokens: [] }, sessionId: 's' })

const tokenOf = (response: InvokeResponse): string => {
  if (response.outcome !== 'approval_required') throw new Error(`expected an ask, got ${response.outcome}`)
  return response.approvals[0]!.token
}

interface Ledger { pending: Array<{ workspace: string; request: { token: string } }>; once: Array<{ workspace: string }>; resolved: Array<{ workspace: string }> }
const ledgerOf = (config: BuckleConfig): Ledger => JSON.parse(readFileSync(approvalsPath(config), 'utf8')) as Ledger

describe('the ask ledger key', () => {
  it('keeps every ask, decision and once under the workspace id', async () => {
    const { config } = setUp()
    const runtime = await open(config)
    const token = tokenOf(await write(runtime, 'one/a.md'))
    tokenOf(await write(runtime, 'one/b.md'))
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, source: 'cli' })).toMatchObject({ ok: true })

    const ledger = ledgerOf(config)
    expect(config.cwd).not.toBe(runtime.workspaceId)
    expect([...ledger.pending, ...ledger.once, ...ledger.resolved].map(entry => entry.workspace)).toEqual([runtime.workspaceId, runtime.workspaceId, runtime.workspaceId])
  })

  it('answers, after the workspace folder moved, an ask recorded before the move', async () => {
    const { root, workspace, config } = setUp()
    const before = await open(config)
    const token = tokenOf(await write(before, 'one/a.md'))

    const moved = join(root, 'moved')
    renameSync(workspace, moved)
    const after = await open({ ...config, cwd: moved })
    expect(after.approvalService.pending().map(request => request.token)).toEqual([token])
    expect(await after.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, source: 'cli' })).toMatchObject({ ok: true })
    expect(after.approvalService.pending()).toEqual([])
  })

  it('reads a ledger whole that also holds an entry under another key, and leaves that entry alone', async () => {
    const { config } = setUp()
    const runtime = await open(config)
    tokenOf(await write(runtime, 'one/a.md'))
    const ledger = ledgerOf(config)
    const elsewhere = { ...ledger.pending[0]!, workspace: config.cwd, request: { ...ledger.pending[0]!.request, token: '00000000-0000-4000-8000-000000000001' } }
    writeFileSync(approvalsPath(config), JSON.stringify({ ...ledger, pending: [...ledger.pending, elsewhere] }))

    const own = runtime.approvalService.pending().map(request => request.token)
    expect(own).toEqual([ledger.pending[0]!.request.token])
    expect(await runtime.approvalService.answer({ decision: { token: elsewhere.request.token, approved: true, scope: 'once' }, source: 'cli' })).toEqual({ ok: false, reason: 'Approval token is unknown or expired' })
    expect(await runtime.approvalService.answer({ decision: { token: own[0]!, approved: false, scope: 'once' }, source: 'cli' })).toMatchObject({ ok: true })
    expect(ledgerOf(config).pending.map(entry => entry.request.token)).toEqual([elsewhere.request.token])
  })
})
