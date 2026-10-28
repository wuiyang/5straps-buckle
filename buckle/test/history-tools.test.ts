import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy, WorkspacePolicySchema, type InvokeResponse, type JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { actionPhrase } from '../common/domain/action-phrase.js'
import { createPathView } from '../common/domain/path-view.js'
import { openChangeHistory } from '../common/services/history/journal.js'
import { createHistoryPack } from '../common/services/packs/history/index.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'

// Slice D, rollback as an agent option: history_list answers the newest checkpoints from the current state back, and
// history_restore restores the workspace to before one, by id or steps, through the restore path. Every restore asks a
// person; the checkpoints here are real ones, made by fs_write.

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function node(packs = 'fs,history'): Promise<{ workspace: string; runtime: BuckleRuntime }> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-history-tools-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: packs, BUCKLE_APPROVAL_TIMEOUT_MS: '1' })
  const runtime = await createRuntime({ config })
  runtimes.push(runtime)
  // Writes anywhere in the folder are granted for the session, as a person's session grant would be; restores still ask.
  await runtime.grants.grant({ sessionId: 'agent', rule: 'write_scope', subject: runtime.paths().root, scope: 'session' })
  return { workspace, runtime }
}

function call(runtime: BuckleRuntime, requestId: string, tool: string, args: JsonObject, tokens: string[] = []): Promise<InvokeResponse> {
  return runtime.invoke({ request: { requestId, tool, args, approvalTokens: tokens }, sessionId: 'agent' })
}

async function approveAll(runtime: BuckleRuntime, asked: InvokeResponse): Promise<string[]> {
  const tokens = asked.outcome === 'approval_required' ? asked.approvals.map(approval => approval.token) : []
  for (const token of tokens) expect((await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, authority: 'admin' })).ok).toBe(true)
  return tokens
}

/** Three writes, each its own checkpoint: a.txt made, b.txt made, a.txt changed. */
async function threeWrites(runtime: BuckleRuntime): Promise<void> {
  expect((await call(runtime, 'w-1', 'fs_write', { path: 'a.txt', content: 'one' })).outcome).toBe('ok')
  expect((await call(runtime, 'w-2', 'fs_write', { path: 'b.txt', content: 'two' })).outcome).toBe('ok')
  expect((await call(runtime, 'w-3', 'fs_write', { path: 'a.txt', content: 'three' })).outcome).toBe('ok')
}

const output = (response: InvokeResponse) => (response.outcome === 'ok' ? response.output as JsonObject : null)

describe('the history pack', () => {
  it('lists history_list as a read and history_restore as a write in the manifest', async () => {
    const { runtime } = await node()
    const tools = runtime.manifest().tools.filter(tool => tool.pack === 'history').map(tool => [tool.name, tool.risk])
    expect(tools).toEqual([['history_list', 'read'], ['history_restore', 'write']])
    expect(runtime.manifest().packs.find(pack => pack.id === 'history')).toMatchObject({ unavailableReason: null })
  })

  it('names each tool in a few words for the head line of a question', () => {
    expect([actionPhrase('history_list'), actionPhrase('history_restore'), actionPhrase('git_revert')]).toEqual(['read the change history', 'restore files from the change history', 'revert a git commit'])
  })
})

describe('history_list', () => {
  it('answers the newest checkpoints newest first, each with the call that made it and its files, the current one marked, and asks nothing', async () => {
    const { runtime } = await node()
    await threeWrites(runtime)
    const listed = await call(runtime, 'list-1', 'history_list', { last: 2 })
    expect(listed.outcome).toBe('ok')
    const answer = output(listed)!
    expect(answer.more).toBe(true)
    expect(answer.checkpoints).toMatchObject([
      { tool: 'fs_write', sessionId: 'agent', requestId: 'w-3', current: true, status: 'complete', changes: [{ path: 'a.txt', kind: 'modified' }] },
      { tool: 'fs_write', sessionId: 'agent', requestId: 'w-2', current: false, changes: [{ path: 'b.txt', kind: 'created' }] },
    ])
    expect((output(await call(runtime, 'list-2', 'history_list', {}))!.checkpoints as unknown[]).length).toBe(3)
    expect(await call(runtime, 'list-3', 'history_list', { last: 101 })).toMatchObject({ outcome: 'error', error: { code: 'INVALID_TOOL_INPUT' } })
  })

  it('leaves out a file the read rules keep from the agent, and counts it', async () => {
    const { runtime, workspace } = await node()
    await runtime.policy.apply(WorkspacePolicySchema.parse({ ...emptyWorkspacePolicy(), filesystem: { rules: [{ path: 'secret.txt', read: 'deny' }] } }))
    await runtime.history.run({ sessionId: 'other', stageId: 'x', tool: 'shell_exec', requestId: 'x', roots: [runtime.paths().root] }, async () => {
      writeFileSync(join(workspace, 'secret.txt'), 'hidden')
      writeFileSync(join(workspace, 'open.txt'), 'shown')
    })
    const [entry] = output(await call(runtime, 'list-1', 'history_list', { last: 1 }))!.checkpoints as JsonObject[]
    expect(entry).toMatchObject({ changes: [{ path: 'open.txt', kind: 'created' }], unlisted: 1 })
  })
})

describe('history_restore', () => {
  it('asks a person under a subject naming what it undoes, whatever the folder\'s write grant, and once approved undoes that many checkpoints', async () => {
    const { runtime, workspace } = await node()
    await threeWrites(runtime)
    const [newest, middle] = (await runtime.history.recent(3)).checkpoints
    const asked = await call(runtime, 'undo-1', 'history_restore', { steps: 2 })
    expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ rule: 'write_scope', subject: `restore:${middle!.id}..${newest!.id}`, offeredScopes: ['once'] }] })
    const ask = runtime.approvalService.waiting().find(item => item.request.tool === 'history_restore')
    expect(ask?.call?.description).toBe(`Restore the workspace 2 checkpoints back in ${JSON.stringify(runtime.paths().displayRoot)}`)
    expect(ask?.call?.effects).toEqual([
      `restore the workspace to before checkpoint ${middle!.id}, undoing it and the 1 checkpoint after it, to ${newest!.id} the newest`,
      `restore ${join(runtime.paths().root, 'a.txt')}`,
      `remove ${join(runtime.paths().root, 'b.txt')} (it was created after that checkpoint)`,
    ])
    expect([readFileSync(join(workspace, 'a.txt'), 'utf8'), existsSync(join(workspace, 'b.txt'))]).toEqual(['three', true])

    const tokens = await approveAll(runtime, asked)
    const restored = await call(runtime, 'undo-1', 'history_restore', { steps: 2 }, tokens)
    expect(restored).toMatchObject({ outcome: 'ok', output: { restores: middle!.id, undoes: 2, changes: [{ path: 'a.txt', kind: 'modified' }, { path: 'b.txt', kind: 'deleted' }] } })
    expect([readFileSync(join(workspace, 'a.txt'), 'utf8'), existsSync(join(workspace, 'b.txt'))]).toEqual(['one', false])
    const [entry] = output(await call(runtime, 'list-1', 'history_list', { last: 1 }))!.checkpoints as JsonObject[]
    expect(entry).toMatchObject({ id: output(restored)!.checkpoint, tool: 'history_restore', requestId: 'undo-1', current: true, restores: middle!.id, undoes: 2 })
  })

  it('by id goes back to before that checkpoint, and one step undoes the restore itself', async () => {
    const { runtime, workspace } = await node()
    await threeWrites(runtime)
    const oldest = (await runtime.history.recent(3)).checkpoints[2]!
    const asked = await call(runtime, 'undo-1', 'history_restore', { id: oldest.id })
    expect(await call(runtime, 'undo-1', 'history_restore', { id: oldest.id }, await approveAll(runtime, asked))).toMatchObject({ outcome: 'ok', output: { undoes: 3 } })
    expect([existsSync(join(workspace, 'a.txt')), existsSync(join(workspace, 'b.txt'))]).toEqual([false, false])
    const redo = await call(runtime, 'redo-1', 'history_restore', { steps: 1 })
    expect(await call(runtime, 'redo-1', 'history_restore', { steps: 1 }, await approveAll(runtime, redo))).toMatchObject({ outcome: 'ok', output: { undoes: 1 } })
    expect([readFileSync(join(workspace, 'a.txt'), 'utf8'), readFileSync(join(workspace, 'b.txt'), 'utf8')]).toEqual(['three', 'two'])
  })

  it('asks again where a checkpoint landed after the approval, so it never undoes more than the person was shown', async () => {
    const { runtime, workspace } = await node()
    await threeWrites(runtime)
    const oldest = (await runtime.history.recent(3)).checkpoints[2]!
    const asked = await call(runtime, 'undo-1', 'history_restore', { id: oldest.id })
    const tokens = await approveAll(runtime, asked)
    expect((await call(runtime, 'w-4', 'fs_write', { path: 'c.txt', content: 'four' })).outcome).toBe('ok')
    const again = await call(runtime, 'undo-1', 'history_restore', { id: oldest.id }, tokens)
    expect(again).toMatchObject({ outcome: 'approval_required', approvals: [{ subject: expect.stringMatching(new RegExp(`^restore:${oldest.id}\\.\\.`)) }] })
    expect(readFileSync(join(workspace, 'c.txt'), 'utf8')).toBe('four')
  })

  // Review M2 of the Slice D tests review: the invoker hands the pack the plan the person was shown, and the pack's own
  // check is only as good as that comparison, so a stale judged plan is pinned here through the whole runtime.
  it('restores nothing where the history under the lock is not the plan the person approved', async () => {
    const { runtime, workspace } = await node()
    await threeWrites(runtime)
    const asked = await call(runtime, 'undo-1', 'history_restore', { steps: 1 })
    const tokens = await approveAll(runtime, asked)
    const stale = await runtime.history.plan({ steps: 1 })
    expect((await call(runtime, 'w-4', 'fs_write', { path: 'c.txt', content: 'four' })).outcome).toBe('ok')
    const spy = vi.spyOn(runtime.history, 'plan').mockResolvedValue(stale)
    try {
      const refused = await call(runtime, 'undo-1', 'history_restore', { steps: 1 }, tokens)
      expect(refused).toMatchObject({ outcome: 'error', error: { code: 'RESTORE_REFUSED', message: expect.stringContaining('moved since') } })
    } finally { spy.mockRestore() }
    expect([readFileSync(join(workspace, 'a.txt'), 'utf8'), readFileSync(join(workspace, 'c.txt'), 'utf8')]).toEqual(['three', 'four'])
  })

  // Review m1 of the Slice D tests review: a file changed by hand reaches the agent as a refusal that says so, not as a failed tool.
  it('answers a file changed by hand since as a refused restore that names the conflict', async () => {
    const { runtime, workspace } = await node()
    await threeWrites(runtime)
    const asked = await call(runtime, 'undo-1', 'history_restore', { steps: 1 })
    const tokens = await approveAll(runtime, asked)
    writeFileSync(join(workspace, 'a.txt'), 'edited by hand')
    const refused = await call(runtime, 'undo-1', 'history_restore', { steps: 1 }, tokens)
    expect(refused).toMatchObject({ outcome: 'error', error: { code: 'RESTORE_REFUSED', message: expect.stringContaining('Restore conflict') } })
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('edited by hand')
  })

  // Review M1 of the Slice D rules review: the history keeps .git, so a restore over a commit's checkpoint rewound the
  // repository and deleted the commit objects, and a branch the owner made at that commit lost its commit.
  it('is refused before anything asks where it would put back files inside a Git directory, and the repository stays whole', async () => {
    const { runtime, workspace } = await node()
    const git = (...args: string[]) => execFileSync('git', ['-C', workspace, '-c', 'user.name=owner', '-c', 'user.email=owner@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(workspace, 'a.txt'), 'one')
    git('add', 'a.txt')
    git('commit', '-q', '-m', 'first')
    await runtime.history.run({ sessionId: 'agent', stageId: 'commit', tool: 'git_commit', requestId: 'commit-1', roots: [runtime.paths().root] }, async () => {
      writeFileSync(join(workspace, 'a.txt'), 'two')
      git('commit', '-q', '-am', 'second')
    })
    git('branch', 'keep')
    const refused = await call(runtime, 'undo-1', 'history_restore', { steps: 1 })
    expect(refused).toMatchObject({ outcome: 'error', error: { code: 'RESTORE_REFUSED', message: expect.stringContaining('inside a Git directory') } })
    expect(runtime.approvalService.waiting()).toEqual([])
    expect(git('log', '--format=%s', 'keep')).toBe('second\nfirst\n')
    expect(() => git('fsck', '--no-progress')).not.toThrow()
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('two')
    // A restore over a checkpoint that changed files outside .git too is refused whole, and one that names none still asks.
    expect((await call(runtime, 'w-1', 'fs_write', { path: 'b.txt', content: 'x' })).outcome).toBe('ok')
    expect(await call(runtime, 'undo-2', 'history_restore', { steps: 2 })).toMatchObject({ outcome: 'error', error: { code: 'RESTORE_REFUSED' } })
    expect(await call(runtime, 'undo-3', 'history_restore', { steps: 1 })).toMatchObject({ outcome: 'approval_required' })
  })

  it('is refused before anything asks where steps reach past the history, and names neither id and steps nor both', async () => {
    const { runtime } = await node()
    expect((await call(runtime, 'w-1', 'fs_write', { path: 'a.txt', content: 'one' })).outcome).toBe('ok')
    expect(await call(runtime, 'undo-1', 'history_restore', { steps: 4 })).toMatchObject({ outcome: 'error', error: { code: 'RESTORE_REFUSED', message: expect.stringContaining('fewer than the 4 steps') } })
    expect(runtime.approvalService.waiting()).toEqual([])
    expect(await call(runtime, 'undo-2', 'history_restore', {})).toMatchObject({ outcome: 'error', error: { code: 'INVALID_TOOL_INPUT' } })
    expect(await call(runtime, 'undo-3', 'history_restore', { steps: 1, id: 'change-x' })).toMatchObject({ outcome: 'error', error: { code: 'INVALID_TOOL_INPUT' } })
  })

  it('restores nothing where the history planned under the lock is not the one judged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-history-tools-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const history = await openChangeHistory({ directory: join(root, 'history'), excluded: [], maxBytes: 1_000_000, retentionDays: 30 })
    try {
      await history.run({ sessionId: 's', stageId: 'w', tool: 'fs_write', roots: [workspace] }, async () => { writeFileSync(join(workspace, 'a.txt'), 'one') })
      const pack = createHistoryPack({ paths: createPathView({ root: workspace, mount: null }), history })
      const tool = pack.tools.find(item => item.capability.name === 'history_restore')!
      const run = tool.prepare({ steps: 1 }).execute({ requestId: 'r', sessionId: 's', timeoutMs: 5_000, signal: new AbortController().signal, authorizeRestore: () => false })
      await expect(run).rejects.toMatchObject({ code: 'RESTORE_REFUSED', message: expect.stringContaining('moved since') })
      expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('one')
    } finally { await history.close() }
  })
})

describe('code mode', () => {
  it('reaches history_list as it reaches every listed tool, and a restore a script makes asks a person', async () => {
    const { runtime } = await node('fs,history,code')
    await threeWrites(runtime)
    const listed = await call(runtime, 'script-1', 'code_run', { script: 'const r = await tools.history_list({ last: 1 }); return r.checkpoints[0].requestId' })
    expect(listed).toMatchObject({ outcome: 'ok', output: { ok: true, value: 'w-3' } })
    const restored = await call(runtime, 'script-2', 'code_run', { script: 'return await tools.history_restore({ steps: 1 })' })
    expect(restored).toMatchObject({ outcome: 'approval_required', approvals: [{ rule: 'write_scope', subject: expect.stringMatching(/^restore:change-/) }] })
  })
})
