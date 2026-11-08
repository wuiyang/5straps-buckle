import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { fixedInteraction } from './support/interaction.js'
import { openChangeHistory } from '../common/services/history/journal.js'
import { createShellWorkspaceRecovery, runIsolatedShell } from '../common/services/shell/isolated-shell.js'
import { createWorkbenchManager } from '../common/services/workbench/manager.js'
import { workbenchHash } from '../common/services/workbench/storage.js'
import { SOURCES } from '../common/types/ports/approval-source.js'
import { settleAuditLogs } from './support/action-log-writer.js'

const roots: string[] = []
afterEach(async () => { await settleAuditLogs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function fixture(extra: { maxBytes?: number; allowHostGit?: boolean } = {}) {
  let at = 1_000_000
  const root = mkdtempSync(join(tmpdir(), 'history-activity-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const directory = join(root, 'history')
  const options = { directory, excluded: [], maxBytes: 1_000_000, now: () => at, ...extra }
  const history = await openChangeHistory(options)
  const details = { sessionId: 'session', tool: 'test', roots: [workspace], turnStageId: null }
  return { root, workspace, directory, options, history, details, advance: (ms: number) => { at += ms } }
}
async function write(node: Awaited<ReturnType<typeof fixture>>, name: string, extra: { sessionId?: string; stageId?: string; turnStageId?: string | null } = {}) {
  await node.history.run({ ...node.details, ...extra }, async () => { writeFileSync(join(node.workspace, name), name) })
  return (await node.history.list()).at(-1)!
}

it('keeps the turn when a call follows a long write immediately', async () => {
  const node = await fixture({ allowHostGit: false })
  try {
    await node.history.run(node.details, async () => { writeFileSync(join(node.workspace, 'a'), 'a'); node.advance(70_000) })
    const first = (await node.history.list()).at(-1)!
    expect((await write(node, 'b')).turnId).toBe(first.turnId)
  } finally { await node.history.close() }
})

it('keeps read activity across reopen and starts a new turn after idle', async () => {
  const node = await fixture({ allowHostGit: false })
  let history = node.history
  try {
    const first = await write(node, 'a')
    node.advance(50_000); history.observeCall('session'); await history.close()
    node.advance(50_000); history = await openChangeHistory(node.options)
    await history.run(node.details, async () => { writeFileSync(join(node.workspace, 'b'), 'b') })
    expect((await history.list()).at(-1)!.turnId).toBe(first.turnId)
    node.advance(61_000)
    await history.run(node.details, async () => { writeFileSync(join(node.workspace, 'c'), 'c') })
    expect((await history.list()).at(-1)!.turnId).not.toBe(first.turnId)
  } finally { await history.close() }
})

it('groups real stages by session while synthetic stages follow idle activity', async () => {
  const node = await fixture({ allowHostGit: false })
  try {
    const first = await write(node, 'a', { stageId: 'request-a', turnStageId: null })
    const second = await write(node, 'b', { stageId: 'request-b', turnStageId: null })
    expect(second.turnId).toBe(first.turnId)
    const real = await write(node, 'c', { stageId: 'stage', turnStageId: 'stage' })
    node.advance(70_000)
    expect((await write(node, 'd', { stageId: 'stage', turnStageId: 'stage' })).turnId).toBe(real.turnId)
    expect((await write(node, 'e', { sessionId: 'other', stageId: 'stage', turnStageId: 'stage' })).turnId).not.toBe(real.turnId)
    expect((await write(node, 'f', { stageId: 'request-c', turnStageId: null })).turnId).not.toBe(first.turnId)
  } finally { await node.history.close() }
})

it('preserves an absent stage when publishing an interrupted isolated shell', async () => {
  const node = await fixture({ allowHostGit: false })
  const isolation = { directory: join(node.root, 'shell'), maxBytes: 1_000_000, history: node.history }
  try {
    const first = await write(node, 'a')
    await expect(runIsolatedShell({ isolation, sourceRoot: node.workspace, writableRoots: [node.workspace], excluded: [], details: { sessionId: 'session', stageId: 'synthetic-request', turnStageId: null, tool: 'shell' }, execute: async copy => { writeFileSync(join(copy, 'b'), 'b'); throw new Error('interrupted') } })).rejects.toThrow('owner review')
    const recovery = createShellWorkspaceRecovery({ ...isolation, sourceRoot: node.workspace, retentionDays: 30 })
    const result = await recovery.publish(recovery.list()[0]!.id)
    expect(result.checkpoint?.turnId).toBe(first.turnId)
  } finally { await node.history.close() }
})

it('does not treat a workbench id as an actual stage', async () => {
  const node = await fixture({ allowHostGit: false })
  const id = randomUUID(); const directory = join(node.root, 'workbenches')
  const manager = createWorkbenchManager({ sourceRoot: node.workspace, directory, workspaceId: 'workspace', maxBytes: 1_000_000, protectedRoots: [node.directory], ripgrep: () => null, history: node.history,
    actions: { async record() {}, append() {}, async recordMany() {}, async recoverInterrupted() { return 0 }, read() { return [] }, page() { return { entries: [], nextCursor: null } } },
    authorizePath: () => true, policyHash: () => 'policy', authorizeTool: () => true,
    async prepareTerminal() { throw new Error('unused') }, async spawnPty() { throw new Error('unused') },
  })
  try {
    writeFileSync(join(node.workspace, 'note'), 'before')
    const first = await write(node, 'a', { sessionId: 'chat' })
    await manager.provision({ id, token: 'fixture-workbench-token-long-enough', projectId: 'project', chatId: 'chat', allowShell: true })
    const copy = join(directory, id, 'workspace', 'note')
    await manager.invoke(id, { actorId: 'actor', tool: 'fs_write', args: { path: 'note', content: 'after', expectedHash: workbenchHash(readFileSync(copy)) } })
    const { review } = await manager.review(id, 'actor')
    const result = await manager.apply(id, { actorId: 'actor', reviewId: review.id })
    expect(result.checkpoint?.turnId).toBe(first.turnId)
  } finally { await manager.close(); await node.history.close() }
})

it('keeps a later checkpoint complete when host git is disabled over the budget', async () => {
  const node = await fixture({ maxBytes: 100_000 })
  try {
    await write(node, 'first', { stageId: 'first', turnStageId: 'first' })
    writeFileSync(join(node.directory, 'padding'), Buffer.alloc(150_000))
    node.history.configure({ allowHostGit: false })
    const second = await write(node, 'second', { stageId: 'second', turnStageId: 'second' })
    expect(second.status).toBe('complete')
    expect(second.restorable).toBe(false)
  } finally { await node.history.close() }
})


it('keeps the original turn while an invocation waits for the execution lock', async () => {
  let at = 1_000_000
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => at)
  const root = mkdtempSync(join(tmpdir(), 'history-wait-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_ALLOW_HOST_GIT: 'false', BUCKLE_PACKS: 'fs' })
  const runtime = await createRuntime({ config, interaction: fixedInteraction() })
  let release = () => {}
  try {
    await runtime.grants.grant({ sessionId: 'session', rule: 'write_scope', subject: runtime.paths().root, scope: 'session' })
    const call = (id: string) => runtime.invoke({ sessionId: 'session', request: { requestId: id, tool: 'fs_write', args: { path: id, content: id }, approvalTokens: [] } })
    expect((await call('first')).outcome).toBe('ok')
    const first = (await runtime.history.list()).at(-1)!
    let locked = () => {}
    const ready = new Promise<void>(resolve => { locked = resolve })
    const hold = runtime.history.exclusive(async () => { locked(); await new Promise<void>(resolve => { release = resolve }) })
    await ready
    let observed = () => {}
    const entered = new Promise<void>(resolve => { observed = resolve })
    const original = runtime.history.startCall
    vi.spyOn(runtime.history, 'startCall').mockImplementation((...args) => { const result = original(...args); observed(); return result })
    const waiting = call('second')
    await entered
    at += 70_000
    release(); await hold
    expect((await waiting).outcome).toBe('ok')
    expect((await runtime.history.list()).at(-1)!.turnId).toBe(first.turnId)
  } finally { release(); runtime.closeWatchers(); await runtime.approvalService.close(); await runtime.history.close(); clock.mockRestore(); vi.restoreAllMocks() }
})

it('keeps the original turn while an invocation waits for approval', async () => {
  let at = 1_000_000
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => at)
  const root = mkdtempSync(join(tmpdir(), 'history-approval-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_ALLOW_HOST_GIT: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '600000' })
  const runtime = await createRuntime({ config, interaction: fixedInteraction() })
  try {
    await runtime.history.run({ sessionId: 'session', turnStageId: null, tool: 'seed', roots: [workspace] }, async () => { writeFileSync(join(workspace, 'first'), 'first') })
    const first = (await runtime.history.list()).at(-1)!
    let signalAsked = () => {}
    const asked = new Promise<void>(resolve => { signalAsked = resolve })
    const waiting = runtime.invoke({ sessionId: 'session', request: { requestId: 'second', tool: 'fs_write', args: { path: 'second', content: 'second' }, approvalTokens: [] }, approvalWait: { mode: 'finite', ms: 180_000 }, onAsked: signalAsked })
    await asked
    await vi.waitFor(() => expect(runtime.approvalService.pending()).toHaveLength(1))
    const token = runtime.approvalService.pending()[0]!.token
    at += 70_000
    expect((await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, source: SOURCES.cli })).ok).toBe(true)
    expect((await waiting).outcome).toBe('ok')
    expect((await runtime.history.list()).at(-1)!.turnId).toBe(first.turnId)
  } finally { runtime.closeWatchers(); await runtime.approvalService.close(); await runtime.history.close(); clock.mockRestore(); vi.restoreAllMocks() }
})
