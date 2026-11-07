import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'
import { approvalsPath, type BuckleConfig } from '../common/runtime/config.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { NO_INTERACTION, type Interaction } from '../common/runtime/interaction.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction } from './support/interaction.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { SOURCES } from '../common/types/ports/approval-source.js'

// The ask ledger is keyed by the workspace's id, as its grants and its state directory are, so a moved folder keeps its asks.

const roots: string[] = []
const runtimes: CoreRuntime[] = []
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

async function open(config: BuckleConfig): Promise<CoreRuntime> {
  const runtime = await createRuntime({ config, interaction: fixedInteraction(NOBODY) })
  runtimes.push(runtime)
  return runtime
}

const write = (runtime: CoreRuntime, path: string): Promise<InvokeResponse> =>
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
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, source: SOURCES.cli })).toMatchObject({ ok: true })

    const ledger = ledgerOf(config)
    expect(config.cwd).not.toBe(runtime.workspaceId)
    expect([...ledger.pending, ...ledger.once, ...ledger.resolved].map(entry => entry.workspace)).toEqual([runtime.workspaceId, runtime.workspaceId, runtime.workspaceId])
  })

  it('takes its key from the grant store, so an ask and its grant are kept under one workspace', async () => {
    const { root } = setUp()
    const grants = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'workspace-id' })
    const registry = createApprovalRegistry(grants, join(root, 'approvals.json'))
    const [request] = (await registry.ask({ tool: 'fs_write', sessionId: 's', asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once', 'session'] }], call: { arguments: {}, cwd: root, description: null, complete: true } })).requests
    expect(await registry.resolve({ token: request!.token, approved: true, scope: 'session' }, SOURCES.cli)).toMatchObject({ ok: true })

    const ledger = JSON.parse(readFileSync(join(root, 'approvals.json'), 'utf8')) as Ledger
    expect(ledger.resolved.map(entry => entry.workspace)).toEqual(['workspace-id'])
    expect(grants.list()).toEqual([expect.objectContaining({ workspace: 'workspace-id', subject: '/outside' })])
  })

  it('answers, after the workspace folder moved, an ask recorded before the move', async () => {
    const { root, workspace, config } = setUp()
    const before = await open(config)
    const token = tokenOf(await write(before, 'one/a.md'))

    const moved = join(root, 'moved')
    renameSync(workspace, moved)
    const after = await open({ ...config, cwd: moved })
    expect(after.approvalService.pending().map(request => request.token)).toEqual([token])
    expect(await after.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, source: SOURCES.cli })).toMatchObject({ ok: true })
    expect(after.approvalService.pending()).toEqual([])
  })

  it('leaves the entries an earlier build kept under the folder where they are, and answers none of them', async () => {
    const { config } = setUp()
    const before = await open(config)
    const waiting = tokenOf(await write(before, 'one/a.md'))
    const ledger = JSON.parse(readFileSync(approvalsPath(config), 'utf8')) as Record<string, unknown>
    const folderKeyed = (entries: unknown) => (entries as Array<Record<string, unknown>>).map(entry => ({ ...entry, workspace: config.cwd }))
    writeFileSync(approvalsPath(config), JSON.stringify({ ...ledger, pending: folderKeyed(ledger.pending) }))

    const after = await open(config)
    const keys = (JSON.parse(readFileSync(approvalsPath(config), 'utf8')) as Ledger).pending.map(entry => entry.workspace)
    expect(keys).toEqual([config.cwd])
    expect(after.approvalService.pending()).toEqual([])
    expect(await after.approvalService.answer({ decision: { token: waiting, approved: true, scope: 'once' }, source: SOURCES.cli })).toMatchObject({ ok: false, code: 'unknown_ask' })
  })
})
