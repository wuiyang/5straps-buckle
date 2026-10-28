import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse, JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openChangeHistory } from '../common/services/history/journal.js'
import { assertSnapshotMatches, SnapshotConflictError, type Snapshot } from '../common/services/history/snapshot.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { runCli } from './support/cli.js'
import { configFromEnvironment } from './support/workspace-config.js'

// A restore refused as a conflict names the path in conflict: the owner's command as it lies in the workspace's folder, an
// agent's tool as the agent names it, and a path the agent's read rules keep from it not at all. The refusal once said
// only "a changed path no longer matches the checkpoint" (the 0.1.8 publish test).

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function journal() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-conflict-path-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const history = await openChangeHistory({ directory: join(root, 'history'), excluded: [], maxBytes: 1_000_000, retentionDays: 30 })
  let call = 0
  const write = (name: string, content: string) => history.run({ sessionId: 'chat-1', stageId: `req-${++call}`, tool: 'fs_write', requestId: `req-${call}`, roots: [workspace] }, async () => { writeFileSync(join(workspace, name), content) })
  const by = { sessionId: 'chat-1', stageId: 'undo-1', tool: 'history_restore', requestId: 'undo-1' }
  return { workspace, history, write, by }
}

describe('the refusal a conflict gives, at the journal', () => {
  it('names the changed path apart from its message, on a restore by id and on a rollback', async () => {
    const { workspace, history, write, by } = await journal()
    await write('a.txt', 'one')
    writeFileSync(join(workspace, 'a.txt'), 'edited by hand')
    const changed = join(workspace, 'a.txt')
    await expect(history.restore((await history.list())[0]!.id)).rejects.toMatchObject({ path: changed, message: 'Restore conflict: a changed path no longer matches the checkpoint' })
    await expect(history.rollback({ target: { steps: 1 }, by })).rejects.toMatchObject({ code: 'RESTORE_REFUSED', path: changed, message: 'Restore conflict: a changed path no longer matches the checkpoint' })
  })

  it('names the file a directory it would remove has gained', async () => {
    const { workspace, history } = await journal()
    await history.run({ sessionId: 'chat-1', stageId: 'req-1', tool: 'fs_write', requestId: 'req-1', roots: [workspace] }, async () => { mkdirSync(join(workspace, 'new')) })
    writeFileSync(join(workspace, 'new', 'owner-file'), 'owner')
    await expect(history.restore((await history.list())[0]!.id)).rejects.toMatchObject({ path: join(workspace, 'new', 'owner-file'), message: 'Restore conflict: a directory contains newer files' })
  })

  it('names the file that changed outside Buckle between two checkpoints a rollback undoes, from the plan too', async () => {
    const { workspace, history, write, by } = await journal()
    await write('a.txt', 'one')
    writeFileSync(join(workspace, 'a.txt'), 'edited by hand')
    await write('a.txt', 'two')
    await write('b.txt', 'three')
    const changed = join(workspace, 'a.txt')
    await expect(history.plan({ steps: 3 })).rejects.toMatchObject({ code: 'RESTORE_REFUSED', path: changed })
    await expect(history.rollback({ target: { steps: 3 }, by })).rejects.toMatchObject({ code: 'RESTORE_REFUSED', path: changed })
  })

  it('names the parent directory that changed, and the file the conflict is about', () => {
    const directory = { kind: 'directory' as const, mode: 0o755 }
    const file = { kind: 'file' as const, mode: 0o644, hash: 'x' }
    const expected: Snapshot = { '/w/sub': directory, '/w/sub/a.txt': file }
    const current: Snapshot = { '/w/sub': { ...directory, mode: 0o700 }, '/w/sub/a.txt': file }
    const target: Snapshot = { '/w/sub': directory }
    let refused: unknown
    try { assertSnapshotMatches({ current, expected, target, paths: ['/w/sub/a.txt'], operation: 'Restore' }) } catch (error) { refused = error }
    expect(refused).toBeInstanceOf(SnapshotConflictError)
    expect(refused).toMatchObject({ path: '/w/sub', message: 'Restore conflict: a parent directory changed since the checkpoint' })
  })
})

async function node(): Promise<{ workspace: string; runtime: BuckleRuntime; config: ReturnType<typeof configFromEnvironment> }> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-conflict-path-node-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_HOST_GIT: 'true', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs,history', BUCKLE_APPROVAL_TIMEOUT_MS: '1' })
  const runtime = await createRuntime({ config })
  runtimes.push(runtime)
  await runtime.grants.grant({ sessionId: 'agent', rule: 'write_scope', subject: runtime.paths().root, scope: 'session' })
  return { workspace, runtime, config }
}

function call(runtime: BuckleRuntime, requestId: string, tool: string, args: JsonObject, tokens: string[] = []): Promise<InvokeResponse> {
  return runtime.invoke({ request: { requestId, tool, args, approvalTokens: tokens }, sessionId: 'agent' })
}

async function approveAll(runtime: BuckleRuntime, asked: InvokeResponse): Promise<string[]> {
  const tokens = asked.outcome === 'approval_required' ? asked.approvals.map(approval => approval.token) : []
  for (const token of tokens) expect((await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, authority: 'admin' })).ok).toBe(true)
  return tokens
}

const errorOf = (response: InvokeResponse) => (response.outcome === 'error' ? response.error : null)

describe('history_restore, for an agent', () => {
  it('names the changed file as the agent names it, and nothing of the host folder', async () => {
    const { runtime, workspace } = await node()
    expect((await call(runtime, 'w-1', 'fs_write', { path: 'src/a.txt', content: 'one', createParents: true })).outcome).toBe('ok')
    const tokens = await approveAll(runtime, await call(runtime, 'undo-1', 'history_restore', { steps: 1 }))
    writeFileSync(join(workspace, 'src', 'a.txt'), 'edited by hand')
    const error = errorOf(await call(runtime, 'undo-1', 'history_restore', { steps: 1 }, tokens))
    expect(error).toMatchObject({ code: 'RESTORE_REFUSED' })
    expect(error?.message).toContain('Restore conflict: ')
    expect(error?.message).toContain('(src/a.txt)')
    expect(error?.message).not.toContain(workspace)
  })

  it('names the file that changed between two checkpoints, in the refusal the plan gives before anything asks', async () => {
    const { runtime, workspace } = await node()
    expect((await call(runtime, 'w-1', 'fs_write', { path: 'a.txt', content: 'one one one one one one' })).outcome).toBe('ok')
    writeFileSync(join(workspace, 'a.txt'), 'edited by hand, a longer line than the one before')
    expect((await call(runtime, 'w-2', 'fs_write', { path: 'a.txt', content: 'two two two two two two two two two two two' })).outcome).toBe('ok')
    expect((await call(runtime, 'w-3', 'fs_write', { path: 'b.txt', content: 'three' })).outcome).toBe('ok')
    const error = errorOf(await call(runtime, 'undo-1', 'history_restore', { steps: 3 }))
    expect(error).toMatchObject({ code: 'RESTORE_REFUSED' })
    expect(error?.message).toContain('between two of the checkpoints')
    expect(error?.message).toContain('(a.txt)')
    expect(error?.message).not.toContain(workspace)
    expect(runtime.approvalService.waiting()).toEqual([])
  })

  // The plan refuses before anything asks, by its own read of the rules: the same hiding as the tool's own refusal.
  it.each([
    ['notes.txt', 'Restore conflict: a file changed outside Buckle between two of the checkpoints this restore undoes (notes.txt)'],
    ['.env', 'Restore conflict: a file changed outside Buckle between two of the checkpoints this restore undoes'],
  ])('names the file changed by hand between two checkpoints in the plan only where the read rules let the agent see it: %s', async (name, message) => {
    const { runtime, workspace } = await node()
    const root = runtime.paths().root
    const change = (id: string, content: string) => runtime.history.run({ sessionId: 'agent', stageId: id, tool: 'fs_write', requestId: id, roots: [root] }, async () => { writeFileSync(join(workspace, name), content) })
    await change('env-1', 'TOKEN=one one one one one one')
    writeFileSync(join(workspace, name), 'TOKEN=edited by hand, a longer line than the one before')
    await change('env-2', 'TOKEN=two two two two two two two two two two two')
    const error = errorOf(await call(runtime, 'undo-1', 'history_restore', { steps: 2 }))
    expect(error).toEqual({ code: 'RESTORE_REFUSED', message, retryable: false })
    expect(runtime.approvalService.waiting()).toEqual([])
  })

  // The agent has the person's word for the paths a restore puts back, and for none a directory it removes has gained.
  it.each([
    ['notes.txt', 'Restore conflict: a directory contains newer files (new/notes.txt)'],
    ['.env', 'Restore conflict: a directory contains newer files'],
  ])('names a file a directory it would remove has gained only where the read rules let the agent see it: %s', async (name, message) => {
    const { runtime, workspace } = await node()
    await runtime.history.run({ sessionId: 'agent', stageId: 'dir-1', tool: 'fs_write', requestId: 'dir-1', roots: [runtime.paths().root] }, async () => { mkdirSync(join(workspace, 'new')) })
    const tokens = await approveAll(runtime, await call(runtime, 'undo-1', 'history_restore', { steps: 1 }))
    writeFileSync(join(workspace, 'new', name), 'TOKEN=added by hand')
    const error = errorOf(await call(runtime, 'undo-1', 'history_restore', { steps: 1 }, tokens))
    expect(error).toEqual({ code: 'RESTORE_REFUSED', message, retryable: false })
  })
})

describe('buckle history restore, for the owner', () => {
  it('names the conflicting path relative to the workspace folder, and exits 1', async () => {
    const { runtime, workspace, config } = await node()
    await runtime.history.run({ sessionId: 'agent', stageId: 'req-1', tool: 'fs_write', requestId: 'req-1', roots: [runtime.paths().root] }, async () => { mkdirSync(join(workspace, 'src')); writeFileSync(join(workspace, 'src', 'a.txt'), 'one') })
    const id = (await runtime.history.list())[0]!.id
    writeFileSync(join(workspace, 'src', 'a.txt'), 'edited by hand')
    await runtime.approvalService.close(); await runtime.history.close(); runtimes.length = 0
    let err = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err += String(chunk); return true })
    const result = await runCli({ argv: ['history', 'restore', id], config, confirm: null })
    expect(result.exitCode).toBe(1)
    // The logger writes to stderr too; the refusal is its own line.
    expect(err.split('\n').filter(line => line.startsWith('Restore conflict'))).toEqual(['Restore conflict: a changed path no longer matches the checkpoint (src/a.txt)'])
  })
})
