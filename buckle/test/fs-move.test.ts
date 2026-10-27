import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy, WorkspacePolicySchema, type InvokeResponse, type JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { actionPhrase } from '../common/domain/action-phrase.js'
import { createPathView } from '../common/domain/path-view.js'
import { moveEntry, settleMove, type MoveIo } from '../common/services/packs/fs/move.js'
import { moveInput } from '../common/services/packs/fs/schemas.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'

// fs_move (the fs-verbs brief): safe by default, `replace` to replace a file, into a folder by name, no folder made, a
// rename beneath parents reached without following a link, and a copy then a removal across devices.

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function node(): Promise<{ root: string; workspace: string; runtime: BuckleRuntime }> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-fs-move-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '1' })
  const runtime = await createRuntime({ config })
  runtimes.push(runtime)
  await runtime.grants.grant({ sessionId: 'agent', rule: 'write_scope', subject: runtime.paths().root, scope: 'session' })
  return { root, workspace, runtime }
}

let sequence = 0
function call(runtime: BuckleRuntime, args: JsonObject, input: { requestId?: string; tokens?: string[] } = {}): Promise<InvokeResponse> {
  return runtime.invoke({ request: { requestId: input.requestId ?? `move-${++sequence}`, tool: 'fs_move', args, approvalTokens: input.tokens ?? [] }, sessionId: 'agent' })
}

async function approved(runtime: BuckleRuntime, args: JsonObject): Promise<InvokeResponse> {
  const requestId = `approved-${++sequence}`
  const asked = await call(runtime, args, { requestId })
  expect(asked.outcome).toBe('approval_required')
  const tokens = asked.outcome === 'approval_required' ? asked.approvals.map(approval => approval.token) : []
  for (const token of tokens) expect((await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, authority: 'admin' })).ok).toBe(true)
  return call(runtime, args, { requestId, tokens })
}

const errorOf = (response: InvokeResponse) => (response.outcome === 'error' ? response.error : null)

describe('fs_move is safe by default', () => {
  it('renames a file where writes are granted without asking, as a write to each folder asks', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'draft.md'), 'draft')
    expect(await call(runtime, { from: 'draft.md', to: 'final.md' })).toMatchObject({ outcome: 'ok', output: { from: 'draft.md', to: 'final.md', replaced: false } })
    expect(readFileSync(join(workspace, 'final.md'), 'utf8')).toBe('draft')
    expect(existsSync(join(workspace, 'draft.md'))).toBe(false)
    expect(actionPhrase('fs_move')).toBe('move a file')
  })

  it('refuses a to that exists before anyone is asked, and leaves both files as they were', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'a.md'), 'a')
    writeFileSync(join(workspace, 'b.md'), 'b')
    expect(errorOf(await call(runtime, { from: 'a.md', to: 'b.md' }))).toMatchObject({ code: 'TARGET_EXISTS' })
    expect(runtime.approvalService.waiting()).toEqual([])
    expect(readFileSync(join(workspace, 'b.md'), 'utf8')).toBe('b')
  })

  it('replaces a file with replace, at the destructive floor, and the checkpoint brings both back', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'a.md'), 'new')
    writeFileSync(join(workspace, 'b.md'), 'old')
    const asked = await call(runtime, { from: 'a.md', to: 'b.md', replace: true })
    expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ rule: 'write_scope', subject: `delete:${runtime.paths().root}` }] })
    const ask = runtime.approvalService.waiting().find(item => item.request.tool === 'fs_move')
    expect(ask?.call?.description).toBe(`Move "a.md" to "b.md", replacing the file there in ${JSON.stringify(runtime.paths().displayRoot)}`)
    expect(await approved(runtime, { from: 'a.md', to: 'b.md', replace: true })).toMatchObject({ outcome: 'ok', output: { replaced: true } })
    expect(readFileSync(join(workspace, 'b.md'), 'utf8')).toBe('new')
    expect(existsSync(join(workspace, 'a.md'))).toBe(false)
    const [checkpoint] = (await runtime.history.list()).filter(item => item.tool === 'fs_move')
    await runtime.history.restore(checkpoint!.id)
    expect(readFileSync(join(workspace, 'a.md'), 'utf8')).toBe('new')
    expect(readFileSync(join(workspace, 'b.md'), 'utf8')).toBe('old')
  })

  it('moves into a folder that to names, and into one a trailing separator names, keeping the name', async () => {
    const { runtime, workspace } = await node()
    mkdirSync(join(workspace, 'docs'))
    writeFileSync(join(workspace, 'one.md'), '1')
    writeFileSync(join(workspace, 'two.md'), '2')
    expect(await call(runtime, { from: 'one.md', to: 'docs' })).toMatchObject({ outcome: 'ok', output: { to: 'docs/one.md' } })
    expect(await call(runtime, { from: 'two.md', to: 'docs/' })).toMatchObject({ outcome: 'ok', output: { to: 'docs/two.md' } })
    expect(readdirSync(join(workspace, 'docs')).sort()).toEqual(['one.md', 'two.md'])
  })

  it('refuses a trailing separator on a folder that does not exist, or on a file, and a missing folder to land in, naming it', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'a.md'), 'a')
    writeFileSync(join(workspace, 'file.md'), 'f')
    expect(errorOf(await call(runtime, { from: 'a.md', to: 'missing/' }))).toMatchObject({ code: 'PARENT_MISSING' })
    expect(errorOf(await call(runtime, { from: 'a.md', to: 'file.md/' }))?.message).toBe('file.md/ is a file, not a folder: name it without the trailing separator to move onto it')
    expect(errorOf(await call(runtime, { from: 'a.md', to: 'nowhere/a.md' }))).toMatchObject({ code: 'PARENT_MISSING', message: 'The folder nowhere does not exist, and a move makes no folder: create it first, or move into one that exists' })
    expect(readFileSync(join(workspace, 'a.md'), 'utf8')).toBe('a')
  })

  it('asks at the floor for a folder, naming what it holds, and refuses moving it into itself', async () => {
    const { runtime, workspace } = await node()
    mkdirSync(join(workspace, 'src/lib'), { recursive: true })
    writeFileSync(join(workspace, 'src/lib/a.ts'), 'a')
    expect(errorOf(await call(runtime, { from: 'src', to: 'src/lib' }))?.message).toContain('a folder is not moved into itself')
    const asked = await call(runtime, { from: 'src', to: 'app' })
    expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ subject: `delete-tree:${join(runtime.paths().root, 'src')}` }] })
    if (asked.outcome === 'approval_required') expect(asked.approvals[0]!.reason).toContain('(1 file and 1 folder)')
    expect(await approved(runtime, { from: 'src', to: 'app' })).toMatchObject({ outcome: 'ok' })
    expect(readFileSync(join(workspace, 'app/lib/a.ts'), 'utf8')).toBe('a')
  })

  it('moves a link as itself, its target untouched', async () => {
    const { runtime, workspace, root } = await node()
    writeFileSync(join(workspace, 'target.md'), 'kept')
    symlinkSync('target.md', join(workspace, 'link.md'))
    expect(await call(runtime, { from: 'link.md', to: 'renamed.md' })).toMatchObject({ outcome: 'ok' })
    expect(readlinkSync(join(workspace, 'renamed.md'))).toBe('target.md')
    expect(readFileSync(join(workspace, 'target.md'), 'utf8')).toBe('kept')
    expect(lstatSync(join(workspace, 'link.md'), { throwIfNoEntry: false })).toBeUndefined()
    expect(existsSync(join(root, 'renamed.md'))).toBe(false)
  })

  it('keeps both paths in its audit entry', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'a.md'), 'a')
    await call(runtime, { from: 'a.md', to: 'b.md' })
    expect(runtime.actions.read(10).filter(entry => entry.tool === 'fs_move' && entry.event === 'result').at(-1)).toMatchObject({ outcome: 'ok', args: { from: 'a.md', to: 'b.md' } })
  })
})

describe('fs_move meets the workspace rules beneath a folder it moves', () => {
  const policy = (rules: unknown[]) => WorkspacePolicySchema.parse({ ...emptyWorkspacePolicy(), filesystem: { rules } })

  it('refuses to land a folder where a file inside would stand on a path the rules deny writing, as a direct write is refused', async () => {
    const { runtime, workspace } = await node()
    await runtime.policy.apply(policy([{ path: '.github/workflows', write: 'deny' }]))
    mkdirSync(join(workspace, 'stuff/workflows'), { recursive: true })
    writeFileSync(join(workspace, 'stuff/workflows/x.yml'), 'on: push')
    mkdirSync(join(workspace, 'stuff2'))
    const direct = await runtime.invoke({ request: { requestId: 'direct', tool: 'fs_write', args: { path: '.github/workflows/x.yml', content: 'x', createParents: true }, approvalTokens: [] }, sessionId: 'agent' })
    expect(errorOf(direct)).toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(errorOf(await call(runtime, { from: 'stuff', to: '.github' }))).toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(existsSync(join(workspace, '.github'))).toBe(false)
    expect(existsSync(join(workspace, 'stuff/workflows/x.yml'))).toBe(true)
  })

  it('refuses to move a folder out from under a rule that denies reading a file inside it', async () => {
    const { runtime, workspace } = await node()
    await runtime.policy.apply(policy([{ path: 'config/prod.json', read: 'deny' }]))
    mkdirSync(join(workspace, 'config'))
    writeFileSync(join(workspace, 'config/prod.json'), '{"key":"value"}')
    const read = (path: string) => runtime.invoke({ request: { requestId: `read-${path}`, tool: 'fs_read', args: { path }, approvalTokens: [] }, sessionId: 'agent' })
    expect(errorOf(await read('config/prod.json'))).toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(errorOf(await call(runtime, { from: 'config', to: 'cfg2' }))).toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(existsSync(join(workspace, 'cfg2'))).toBe(false)
    expect(readFileSync(join(workspace, 'config/prod.json'), 'utf8')).toBe('{"key":"value"}')
  })

  it('moves a folder that holds nothing the rules restrict', async () => {
    const { runtime, workspace } = await node()
    await runtime.policy.apply(policy([{ path: 'config/prod.json', read: 'deny' }]))
    mkdirSync(join(workspace, 'other'))
    writeFileSync(join(workspace, 'other/a.txt'), 'a')
    expect(await approved(runtime, { from: 'other', to: 'moved' })).toMatchObject({ outcome: 'ok' })
    expect(readFileSync(join(workspace, 'moved/a.txt'), 'utf8')).toBe('a')
  })
})

describe('moveEntry', () => {
  function folder() {
    const root = mkdtempSync(join(tmpdir(), 'buckle-fs-move-unit-'))
    roots.push(root)
    return { root, paths: createPathView({ root, mount: null }) }
  }

  /** The system's own operations, with the first rename of `from` answered EXDEV, as a move across devices is. */
  function acrossDevices(input: { from: string; failUnlinkOf?: string }): MoveIo {
    let crossed = false
    return {
      rename: (from, to) => { if (!crossed && from.endsWith(input.from)) { crossed = true; throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }) } renameSync(from, to) },
      unlink: (path) => { if (input.failUnlinkOf && path.endsWith(input.failUnlinkOf)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); unlinkSync(path) },
      rmdir: path => rmdirSync(path),
      pause: async () => {},
    }
  }

  it('copies across devices, then removes the source', async () => {
    const { root, paths } = folder()
    mkdirSync(join(root, 'other'))
    writeFileSync(join(root, 'a.md'), 'across')
    const input = moveInput.parse({ from: 'a.md', to: 'other/b.md' })
    expect(await moveEntry(input, { paths, io: acrossDevices({ from: 'a.md' }) }, settleMove(input, { paths }))).toMatchObject({ copied: true, replaced: false })
    expect(readFileSync(join(root, 'other/b.md'), 'utf8')).toBe('across')
    expect(existsSync(join(root, 'a.md'))).toBe(false)
  })

  it('leaves the source in place and removes the copy where its removal fails after the copy', async () => {
    const { root, paths } = folder()
    mkdirSync(join(root, 'other'))
    writeFileSync(join(root, 'a.md'), 'stays')
    writeFileSync(join(root, 'other/b.md'), 'replaced?')
    const input = moveInput.parse({ from: 'a.md', to: 'other/b.md', replace: true })
    await expect(moveEntry(input, { paths, io: acrossDevices({ from: 'a.md', failUnlinkOf: 'a.md' }) }, settleMove(input, { paths }))).rejects.toThrow('could not be moved to the other device (EACCES)')
    expect(readFileSync(join(root, 'a.md'), 'utf8')).toBe('stays')
    expect(readFileSync(join(root, 'other/b.md'), 'utf8')).toBe('replaced?')
    expect(readdirSync(join(root, 'other'))).toEqual(['b.md'])
  })

  it('copies a folder across devices whole, links as links', async () => {
    const { root, paths } = folder()
    mkdirSync(join(root, 'src/deep'), { recursive: true })
    mkdirSync(join(root, 'other'))
    writeFileSync(join(root, 'src/deep/a.ts'), 'a')
    symlinkSync('deep/a.ts', join(root, 'src/link.ts'))
    const input = moveInput.parse({ from: 'src', to: 'other' })
    expect(await moveEntry(input, { paths, io: acrossDevices({ from: 'src' }) }, settleMove(input, { paths }))).toMatchObject({ copied: true, to: 'other/src' })
    expect(readFileSync(join(root, 'other/src/deep/a.ts'), 'utf8')).toBe('a')
    expect(readlinkSync(join(root, 'other/src/link.ts'))).toBe('deep/a.ts')
    expect(existsSync(join(root, 'src'))).toBe(false)
  })

  it('refuses a source whose folder was swapped for a link after its check, as its new landing was never judged, and moves nothing', async () => {
    const { root, paths } = folder()
    mkdirSync(join(root, 'real'))
    mkdirSync(join(root, 'elsewhere'))
    writeFileSync(join(root, 'real/a.md'), 'judged')
    writeFileSync(join(root, 'elsewhere/a.md'), 'not judged')
    const input = moveInput.parse({ from: 'real/a.md', to: 'b.md' })
    const judged = settleMove(input, { paths })
    renameSync(join(root, 'real'), join(root, 'real-moved'))
    symlinkSync(join(root, 'elsewhere'), join(root, 'real'))
    // As the invoker hands it: only the entries the permission check judged may be removed and written.
    const context = { paths, authorizeDelete: (target: string) => target === judged.from.path, authorizeWrite: (target: string) => target === judged.target.path }
    await expect(moveEntry(input, context, judged)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(readFileSync(join(root, 'elsewhere/a.md'), 'utf8')).toBe('not judged')
    expect(existsSync(join(root, 'b.md'))).toBe(false)
  })

  it('refuses a landing taken after its check without replace', async () => {
    const { root, paths } = folder()
    writeFileSync(join(root, 'a.md'), 'a')
    const input = moveInput.parse({ from: 'a.md', to: 'b.md' })
    const judged = settleMove(input, { paths })
    writeFileSync(join(root, 'b.md'), 'arrived meanwhile')
    await expect(moveEntry(input, { paths }, judged)).rejects.toMatchObject({ code: 'TARGET_EXISTS' })
    expect(readFileSync(join(root, 'b.md'), 'utf8')).toBe('arrived meanwhile')
  })
})
