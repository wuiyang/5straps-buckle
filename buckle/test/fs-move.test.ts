import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy, WorkspacePolicySchema, type InvokeResponse, type JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { actionPhrase } from '../common/domain/action-phrase.js'
import { createPathView } from '../common/domain/path-view.js'
import { moveEntry, settleMove, standingAt, type MoveIo } from '../common/services/packs/fs/move.js'
import { moveInput } from '../common/services/packs/fs/schemas.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'

// fs_move (the fs-verbs brief): safe by default, `replace` to replace a file, into a folder by name, no folder made, a
// rename beneath parents reached without following a link, and a copy then a removal across devices. The workspace here
// sets files.deleteInWorkspace ask, which keeps the floor inside its own folder (the delete policy brief).

// The bound a folder is counted to before a person is asked (MAX_COUNTED_ENTRIES), which a test lowers rather than
// build 10,001 entries on a slow disk; the count and the refusal it feeds are the real ones.
const counting = vi.hoisted(() => ({ limit: 10_000 }))
vi.mock('../common/domain/effect.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../common/domain/effect.js')>()
  return Object.defineProperty({ ...actual }, 'MAX_COUNTED_ENTRIES', { get: () => counting.limit, enumerable: true })
})

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  counting.limit = 10_000
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function node(): Promise<{ root: string; workspace: string; runtime: BuckleRuntime }> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-fs-move-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_HOST_GIT: 'true', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '1', BUCKLE_DELETE_IN_WORKSPACE: 'ask' })
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

  it('refuses a case-only name for a second hard link of one file on a volume that keeps case, which a rename would leave both of', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'a.txt'), 'one file')
    linkSync(join(workspace, 'a.txt'), join(workspace, 'A.txt'))
    expect(errorOf(await call(runtime, { from: 'a.txt', to: 'A.txt' }))?.message).toBe('a.txt and A.txt name the same file, so nothing was moved')
    expect(readdirSync(workspace).sort()).toEqual(['A.txt', 'a.txt'])
  })

  it('keeps both paths in its audit entry', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'a.md'), 'a')
    await call(runtime, { from: 'a.md', to: 'b.md' })
    expect(runtime.actions.read(10).filter(entry => entry.tool === 'fs_move' && entry.event === 'result').at(-1)).toMatchObject({ outcome: 'ok', args: { from: 'a.md', to: 'b.md' } })
  })
})

describe('fs_move\'s replace flag states what the caller expects to stand at the destination', () => {
  const asks = (response: InvokeResponse) => (response.outcome === 'approval_required' ? response.approvals : [])

  it('refuses replace where nothing stands at to, naming the path, before anyone is asked, and moves nothing', async () => {
    const { runtime, workspace } = await node()
    mkdirSync(join(workspace, 'docs'))
    writeFileSync(join(workspace, 'a.md'), 'a')
    expect(errorOf(await call(runtime, { from: 'a.md', to: 'b.md', replace: true }))).toMatchObject({ code: 'NOTHING_TO_REPLACE', message: 'Nothing stands at b.md, so replace: true has nothing to replace and nothing was moved: send replace: false to move there' })
    // Into a folder, the check is on the joined path: a folder `to`, or a trailing separator, names `to/<the source's name>`.
    expect(errorOf(await call(runtime, { from: 'a.md', to: 'docs', replace: true }))).toMatchObject({ code: 'NOTHING_TO_REPLACE', message: expect.stringContaining('Nothing stands at docs/a.md,') })
    expect(errorOf(await call(runtime, { from: 'a.md', to: 'docs/', replace: true }))).toMatchObject({ code: 'NOTHING_TO_REPLACE', message: expect.stringContaining('Nothing stands at docs/a.md,') })
    expect(runtime.approvalService.waiting()).toEqual([])
    expect(readFileSync(join(workspace, 'a.md'), 'utf8')).toBe('a')
    expect(readdirSync(workspace).sort()).toEqual(['a.md', 'docs'])
    expect(readdirSync(join(workspace, 'docs'))).toEqual([])
  })

  it('refuses a folder moved with replace where nothing stands at its landing, before anyone is asked', async () => {
    const { runtime, workspace } = await node()
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src/a.ts'), 'a')
    expect(errorOf(await call(runtime, { from: 'src', to: 'app', replace: true }))).toMatchObject({ code: 'NOTHING_TO_REPLACE' })
    expect(runtime.approvalService.waiting()).toEqual([])
    expect(readFileSync(join(workspace, 'src/a.ts'), 'utf8')).toBe('a')
  })

  it('refuses replace outside the workspace\'s folders only once a person allowed the call, and still moves nothing', async () => {
    const { runtime, workspace, root } = await node()
    mkdirSync(join(root, 'outside'))
    writeFileSync(join(workspace, 'a.md'), 'a')
    const args = { from: 'a.md', to: '../outside/b.md', replace: true }
    expect(asks(await call(runtime, args)).length).toBeGreaterThan(0)
    expect(errorOf(await approved(runtime, args))).toMatchObject({ code: 'NOTHING_TO_REPLACE', message: expect.stringContaining('../outside/b.md') })
    expect(readFileSync(join(workspace, 'a.md'), 'utf8')).toBe('a')
    expect(readdirSync(join(root, 'outside'))).toEqual([])
  })

  it('still refuses without replace whatever stands at the landing: a file, a link, a link that points nowhere, or a folder', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'one'), 'one')
    writeFileSync(join(workspace, 'file'), 'f')
    symlinkSync('file', join(workspace, 'link'))
    symlinkSync('nowhere', join(workspace, 'dangling'))
    mkdirSync(join(workspace, 'dest/one'), { recursive: true })
    writeFileSync(join(workspace, 'dest/one/old'), 'old')
    for (const to of ['file', 'link', 'dangling']) {
      for (const args of [{ from: 'one', to }, { from: 'one', to, replace: false }] as JsonObject[]) expect(errorOf(await call(runtime, args))).toMatchObject({ code: 'TARGET_EXISTS' })
    }
    for (const to of ['dest', 'dest/']) {
      expect(errorOf(await call(runtime, { from: 'one', to }))).toMatchObject({ code: 'TARGET_EXISTS', message: 'Something already stands at dest/one: send replace: true to replace it, or move to a name that is free' })
    }
    expect(runtime.approvalService.waiting()).toEqual([])
    expect(readFileSync(join(workspace, 'dest/one/old'), 'utf8')).toBe('old')
    expect(readFileSync(join(workspace, 'one'), 'utf8')).toBe('one')
    expect(readFileSync(join(workspace, 'file'), 'utf8')).toBe('f')
  })

  it('counts a link as standing there, even one that points nowhere, and replaces the link itself', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'a.md'), 'a')
    symlinkSync('nowhere', join(workspace, 'dangling'))
    expect(await approved(runtime, { from: 'a.md', to: 'dangling', replace: true })).toMatchObject({ outcome: 'ok', output: { replaced: true } })
    expect(lstatSync(join(workspace, 'dangling')).isFile()).toBe(true)
    expect(readFileSync(join(workspace, 'dangling'), 'utf8')).toBe('a')
  })
})

describe('fs_move replaces a folder when replace is true and a folder stands at the landing', () => {
  const asks = (response: InvokeResponse) => (response.outcome === 'approval_required' ? response.approvals : [])
  /** archive/notes holds a.txt and deep/b.txt: two files and one folder, three entries in all. */
  function archive(workspace: string) {
    mkdirSync(join(workspace, 'archive/notes/deep'), { recursive: true })
    writeFileSync(join(workspace, 'archive/notes/a.txt'), 'a')
    writeFileSync(join(workspace, 'archive/notes/deep/b.txt'), 'b')
  }

  it('replaces a folder with a file: the ask is the delete-tree floor for that folder, with its count, and the history brings it back', async () => {
    const { runtime, workspace } = await node()
    archive(workspace)
    writeFileSync(join(workspace, 'notes'), 'the new file')
    const args = { from: 'notes', to: 'archive', replace: true }
    const asked = await call(runtime, args)
    const landing = join(runtime.paths().root, 'archive/notes')
    const replaced = asks(asked).find(ask => ask.subject === `delete-tree:${landing}`)
    expect(replaced).toMatchObject({ rule: 'write_scope' })
    expect(replaced?.reason).toContain('and everything in it (2 files and 1 folder)')
    const ask = runtime.approvalService.waiting().find(item => item.request.tool === 'fs_move')
    expect(ask?.call?.description).toBe(`Move "notes" to "archive" as "archive/notes", replacing the folder there, 3 entries in ${JSON.stringify(runtime.paths().displayRoot)}`)
    expect(await approved(runtime, args)).toMatchObject({ outcome: 'ok', output: { replaced: true } })
    expect(readFileSync(join(workspace, 'archive/notes'), 'utf8')).toBe('the new file')
    expect(readdirSync(join(workspace, 'archive'))).toEqual(['notes'])
    expect(existsSync(join(workspace, 'notes'))).toBe(false)
    const [checkpoint] = (await runtime.history.list()).filter(item => item.tool === 'fs_move')
    await runtime.history.restore(checkpoint!.id)
    expect(readFileSync(join(workspace, 'notes'), 'utf8')).toBe('the new file')
    expect(readFileSync(join(workspace, 'archive/notes/a.txt'), 'utf8')).toBe('a')
    expect(readFileSync(join(workspace, 'archive/notes/deep/b.txt'), 'utf8')).toBe('b')
  })

  it('replaces a folder with a folder: each asks under its own delete-tree subject, the old one goes whole, and the history brings both back', async () => {
    const { runtime, workspace } = await node()
    mkdirSync(join(workspace, 'src/lib'), { recursive: true })
    writeFileSync(join(workspace, 'src/lib/new.ts'), 'new')
    mkdirSync(join(workspace, 'app/src/deep'), { recursive: true })
    writeFileSync(join(workspace, 'app/src/old.ts'), 'old')
    writeFileSync(join(workspace, 'app/src/deep/b.ts'), 'b')
    const args = { from: 'src', to: 'app', replace: true }
    const root = runtime.paths().root
    const subjects = asks(await call(runtime, args)).map(ask => ask.subject)
    expect(subjects).toEqual(expect.arrayContaining([`delete-tree:${join(root, 'src')}`, `delete-tree:${join(root, 'app/src')}`]))
    expect(await approved(runtime, args)).toMatchObject({ outcome: 'ok', output: { replaced: true } })
    expect(readFileSync(join(workspace, 'app/src/lib/new.ts'), 'utf8')).toBe('new')
    expect(existsSync(join(workspace, 'app/src/old.ts'))).toBe(false)
    expect(existsSync(join(workspace, 'app/src/deep'))).toBe(false)
    expect(existsSync(join(workspace, 'src'))).toBe(false)
    expect(readdirSync(join(workspace, 'app'))).toEqual(['src'])
    const [checkpoint] = (await runtime.history.list()).filter(item => item.tool === 'fs_move')
    await runtime.history.restore(checkpoint!.id)
    expect(readFileSync(join(workspace, 'src/lib/new.ts'), 'utf8')).toBe('new')
    expect(readFileSync(join(workspace, 'app/src/old.ts'), 'utf8')).toBe('old')
    expect(readFileSync(join(workspace, 'app/src/deep/b.ts'), 'utf8')).toBe('b')
    expect(existsSync(join(workspace, 'app/src/lib'))).toBe(false)
  })

  it('refuses a folder past the entries one checkpoint covers before anyone is asked, as fs_delete does, and replaces nothing', async () => {
    const { runtime, workspace } = await node()
    archive(workspace)
    writeFileSync(join(workspace, 'notes'), 'the new file')
    counting.limit = 2
    expect(errorOf(await call(runtime, { from: 'notes', to: 'archive', replace: true }))).toMatchObject({ code: 'FOLDER_TOO_LARGE', message: 'archive/notes holds more than 10000 entries, more than one checkpoint covers: delete the folder in parts first, then move' })
    expect(runtime.approvalService.waiting()).toEqual([])
    expect(readFileSync(join(workspace, 'archive/notes/a.txt'), 'utf8')).toBe('a')
    expect(readFileSync(join(workspace, 'notes'), 'utf8')).toBe('the new file')
  })

  it('does not look into a folder outside the workspace\'s folders before a person allows the call, then counts it and replaces it', async () => {
    const { runtime, workspace, root } = await node()
    mkdirSync(join(root, 'outside/notes/deep'), { recursive: true })
    writeFileSync(join(root, 'outside/notes/deep/b.txt'), 'b')
    writeFileSync(join(workspace, 'notes'), 'the new file')
    const args = { from: 'notes', to: '../outside', replace: true }
    const asked = await call(runtime, args)
    expect(asks(asked).find(ask => ask.subject === `delete-tree:${join(root, 'outside/notes')}`)?.reason).toContain('not counted')
    expect(runtime.approvalService.waiting().find(item => item.request.tool === 'fs_move')?.call?.description).toMatch(/, replacing the folder there in /)
    counting.limit = 1
    expect(errorOf(await approved(runtime, args))).toMatchObject({ code: 'FOLDER_TOO_LARGE' })
    expect(readFileSync(join(root, 'outside/notes/deep/b.txt'), 'utf8')).toBe('b')
    counting.limit = 10_000
    expect(await approved(runtime, args)).toMatchObject({ outcome: 'ok', output: { replaced: true } })
    expect(readFileSync(join(root, 'outside/notes'), 'utf8')).toBe('the new file')
  })

  it('refuses a landing folder that holds the source, as replacing it would remove what is being moved', async () => {
    const { runtime, workspace } = await node()
    mkdirSync(join(workspace, 'x/y'), { recursive: true })
    writeFileSync(join(workspace, 'x/y/x'), 'inner')
    expect(errorOf(await call(runtime, { from: 'x/y/x', to: '.', replace: true }))?.message).toBe('./x is a folder that holds x/y/x, so replacing it would remove what is being moved')
    expect(runtime.approvalService.waiting()).toEqual([])
    expect(readFileSync(join(workspace, 'x/y/x'), 'utf8')).toBe('inner')
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

  /** The system's own operations, with the one rename of `name` onto a path of that name answered EXDEV, and the first removal of `name` failed if asked. */
  function acrossDevicesToTheSameName(input: { name: string; failFirstUnlink?: boolean }): MoveIo {
    let crossed = false
    let failed = false
    return {
      rename: (from, to) => { if (!crossed && from.endsWith(`/${input.name}`) && to.endsWith(`/${input.name}`)) { crossed = true; throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }) } renameSync(from, to) },
      unlink: (path) => { if (input.failFirstUnlink && !failed && path.endsWith(`/${input.name}`)) { failed = true; throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) } unlinkSync(path) },
      rmdir: path => rmdirSync(path),
      pause: async () => {},
    }
  }

  it('replaces a folder across devices: the copy lands, the source goes, and the old folder is removed whole', async () => {
    const { root, paths } = folder()
    mkdirSync(join(root, 'other/a.md/deep'), { recursive: true })
    writeFileSync(join(root, 'other/a.md/old.txt'), 'old')
    writeFileSync(join(root, 'other/a.md/deep/o.txt'), 'o')
    writeFileSync(join(root, 'a.md'), 'source')
    const input = moveInput.parse({ from: 'a.md', to: 'other', replace: true })
    expect(await moveEntry(input, { paths, io: acrossDevicesToTheSameName({ name: 'a.md' }) }, settleMove(input, { paths }))).toMatchObject({ copied: true, replaced: true, to: 'other/a.md' })
    expect(readFileSync(join(root, 'other/a.md'), 'utf8')).toBe('source')
    expect(existsSync(join(root, 'a.md'))).toBe(false)
    expect(readdirSync(join(root, 'other'))).toEqual(['a.md'])
  })

  it('puts the old folder back where a move across devices fails after the copy, and leaves the source where it was', async () => {
    const { root, paths } = folder()
    mkdirSync(join(root, 'other/a.md/deep'), { recursive: true })
    writeFileSync(join(root, 'other/a.md/old.txt'), 'old')
    writeFileSync(join(root, 'other/a.md/deep/o.txt'), 'o')
    writeFileSync(join(root, 'a.md'), 'source')
    const input = moveInput.parse({ from: 'a.md', to: 'other', replace: true })
    await expect(moveEntry(input, { paths, io: acrossDevicesToTheSameName({ name: 'a.md', failFirstUnlink: true }) }, settleMove(input, { paths }))).rejects.toThrow('could not be moved to the other device (EACCES)')
    expect(readFileSync(join(root, 'a.md'), 'utf8')).toBe('source')
    expect(readFileSync(join(root, 'other/a.md/old.txt'), 'utf8')).toBe('old')
    expect(readFileSync(join(root, 'other/a.md/deep/o.txt'), 'utf8')).toBe('o')
    expect(readdirSync(join(root, 'other'))).toEqual(['a.md'])
  })

  it('answers ok with the old folder\'s name where its removal stops part way, as the move has landed', async () => {
    const { root, paths } = folder()
    mkdirSync(join(root, 'other/a.md'), { recursive: true })
    writeFileSync(join(root, 'other/a.md/old.txt'), 'old')
    writeFileSync(join(root, 'a.md'), 'source')
    const input = moveInput.parse({ from: 'a.md', to: 'other', replace: true })
    const io: MoveIo = { rename: renameSync, unlink: (path) => { if (path.endsWith('/old.txt')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); unlinkSync(path) }, rmdir: rmdirSync, pause: async () => {} }
    const answer = await moveEntry(input, { paths, io }, settleMove(input, { paths }))
    expect(answer).toMatchObject({ replaced: true, to: 'other/a.md', leftOver: expect.stringMatching(/^other\/\.buckle-aside-/) })
    expect(readFileSync(join(root, 'other/a.md'), 'utf8')).toBe('source')
    expect(readdirSync(join(root, 'other')).filter(name => name !== 'a.md')).toHaveLength(1)
  })

  it('refuses a landing that was a file at its check and is a folder now, and one that was taken away', async () => {
    const { root, paths } = folder()
    writeFileSync(join(root, 'a.md'), 'source')
    writeFileSync(join(root, 'b.md'), 'file at the check')
    const input = moveInput.parse({ from: 'a.md', to: 'b.md', replace: true })
    const judged = settleMove(input, { paths })
    rmSync(join(root, 'b.md'))
    await expect(moveEntry(input, { paths }, judged)).rejects.toMatchObject({ code: 'NOTHING_TO_REPLACE', message: expect.stringContaining('b.md') })
    mkdirSync(join(root, 'b.md'))
    writeFileSync(join(root, 'b.md/inner'), 'a folder arrived meanwhile')
    await expect(moveEntry(input, { paths }, judged)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(readFileSync(join(root, 'b.md/inner'), 'utf8')).toBe('a folder arrived meanwhile')
    expect(readFileSync(join(root, 'a.md'), 'utf8')).toBe('source')
  })

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

  it('says the landing, not the source, where it was taken while the copy across devices ran', async () => {
    const { root, paths } = folder()
    mkdirSync(join(root, 'other'))
    writeFileSync(join(root, 'a.md'), 'source')
    const input = moveInput.parse({ from: 'a.md', to: 'other/b.md' })
    const judged = settleMove(input, { paths })
    const io = acrossDevices({ from: 'a.md' })
    const crossing: MoveIo = { ...io, rename: (from, to) => { try { io.rename(from, to) } catch (error) { writeFileSync(join(root, 'other/b.md'), 'arrived meanwhile'); throw error } } }
    await expect(moveEntry(input, { paths, io: crossing }, judged)).rejects.toMatchObject({ code: 'TARGET_EXISTS', message: 'Something already stands at other/b.md: send replace: true to replace it, or move to a name that is free' })
    expect(readFileSync(join(root, 'other/b.md'), 'utf8')).toBe('arrived meanwhile')
    expect(readFileSync(join(root, 'a.md'), 'utf8')).toBe('source')
    expect(readdirSync(join(root, 'other'))).toEqual(['b.md'])
  })

  it('puts the replaced file back even where the copy cannot be removed, and keeps nothing hidden beside it', async () => {
    const { root, paths } = folder()
    mkdirSync(join(root, 'other'))
    writeFileSync(join(root, 'a.md'), 'source')
    writeFileSync(join(root, 'other/b.md'), 'replaced file')
    const input = moveInput.parse({ from: 'a.md', to: 'other/b.md', replace: true })
    const base = acrossDevices({ from: 'a.md', failUnlinkOf: 'a.md' })
    // The source cannot be removed, and neither can the copy that was renamed onto the landing.
    const io: MoveIo = { ...base, unlink: (path) => { if (path.endsWith('/b.md')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); base.unlink(path) } }
    await expect(moveEntry(input, { paths, io }, settleMove(input, { paths }))).rejects.toThrow('could not be moved to the other device (EACCES), so what the copy made was removed and a.md is where it was')
    expect(readFileSync(join(root, 'other/b.md'), 'utf8')).toBe('replaced file')
    expect(readFileSync(join(root, 'a.md'), 'utf8')).toBe('source')
    expect(readdirSync(join(root, 'other'))).toEqual(['b.md'])
  })

  it('names what it could not undo where neither the copy nor the replaced file can be put right, and the set-aside file is not one a sweep removes', async () => {
    const { root, paths } = folder()
    mkdirSync(join(root, 'other/sub'), { recursive: true })
    writeFileSync(join(root, 'a.md'), 'source')
    writeFileSync(join(root, 'other/b.md'), 'replaced file')
    const input = moveInput.parse({ from: 'a.md', to: 'other/b.md', replace: true })
    const base = acrossDevices({ from: 'a.md', failUnlinkOf: 'a.md' })
    // The source removal fails; then the copy cannot be removed, and the file set aside cannot be renamed back.
    const io: MoveIo = { ...base, rename: (from, to) => { if (from.includes('.buckle-aside-')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); base.rename(from, to) }, unlink: (path) => { if (path.endsWith('/b.md')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); base.unlink(path) } }
    await expect(moveEntry(input, { paths, io }, settleMove(input, { paths }))).rejects.toThrow(/the copy at other\/b\.md could not be removed \(EBUSY\), and the file it replaces could not be put back \(EBUSY\) and is kept beside it as \.buckle-aside-/)
    const names = readdirSync(join(root, 'other')).filter(name => name !== 'sub' && name !== 'b.md')
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^\.buckle-aside-/)
    expect(readFileSync(join(root, 'other', names[0]!), 'utf8')).toBe('replaced file')
  })

  it('tells the platform\'s refusal of a rename from a program holding the file, and names both ends where a file is replaced', async () => {
    const { root, paths } = folder()
    writeFileSync(join(root, 'a.md'), 'a')
    writeFileSync(join(root, 'b.md'), 'b')
    const refused = (code: string): MoveIo => ({ rename: () => { throw Object.assign(new Error(code), { code }) }, unlink: unlinkSync, rmdir: rmdirSync, pause: async () => {} })
    const input = moveInput.parse({ from: 'a.md', to: 'b.md', replace: true })
    const judged = settleMove(input, { paths })
    await expect(moveEntry(input, { paths, io: refused('EPERM'), platform: 'linux' }, judged)).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: 'a.md could not be moved to b.md (EPERM), so it was not moved' })
    await expect(moveEntry(input, { paths, io: refused('EBUSY'), platform: 'darwin' }, judged)).rejects.toMatchObject({ code: 'MOVE_FAILED', message: 'a.md could not be moved to b.md (EBUSY), so it was not moved' })
    await expect(moveEntry(input, { paths, io: refused('EPERM'), platform: 'win32' }, judged)).rejects.toMatchObject({ code: 'ENTRY_HELD', message: 'a.md or b.md, the file it replaces, is held open by another program, so it was not moved; close it and send the call again' })
    const plain = moveInput.parse({ from: 'a.md', to: 'c.md' })
    await expect(moveEntry(plain, { paths, io: refused('EBUSY'), platform: 'win32' }, settleMove(plain, { paths }))).rejects.toMatchObject({ code: 'ENTRY_HELD', message: 'a.md is held open by another program, so it was not moved; close it and send the call again' })
    expect(readFileSync(join(root, 'a.md'), 'utf8')).toBe('a')
  })

  it('compares files by the whole of their numbers, not as doubles that past 2^53 lose their low bits', () => {
    const info = (ino: bigint, dev = 1n) => ({ ino, dev, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }) as unknown as BigIntStats
    const stats: Record<string, BigIntStats> = { '/w/a': info(9_007_199_254_740_992n), '/w/b': info(9_007_199_254_740_993n), '/w/c': info(9_007_199_254_740_992n) }
    expect(standingAt('/w/a', '/w/b', path => stats[path])).toBe('file')
    expect(standingAt('/w/a', '/w/c', path => stats[path])).toBe('same')
  })

  it('copies a link across devices on Windows as the kind of link it is, and says which link where Windows refuses to make one', async () => {
    const { root, paths } = folder()
    mkdirSync(join(root, 'src/real'), { recursive: true })
    mkdirSync(join(root, 'other'))
    writeFileSync(join(root, 'src/real/f.txt'), 'f')
    symlinkSync(join(root, 'src/real'), join(root, 'src/absolute-folder-link'))
    symlinkSync('real', join(root, 'src/relative-folder-link'))
    symlinkSync('real/f.txt', join(root, 'src/file-link'))
    const made: Array<[string, string | undefined]> = []
    const input = moveInput.parse({ from: 'src', to: 'other' })
    const link = (_target: string, path: string, type?: string) => { made.push([path.slice(path.lastIndexOf('/') + 1), type]); symlinkSync(_target, path) }
    await moveEntry(input, { paths, platform: 'win32', io: { ...acrossDevices({ from: 'src' }), symlink: link } }, settleMove(input, { paths }))
    expect(made.sort()).toEqual([['absolute-folder-link', 'junction'], ['file-link', 'file'], ['relative-folder-link', 'dir']])
    // Where Windows refuses a link, the whole move is refused naming that link, and the source stays whole.
    mkdirSync(join(root, 'src2'))
    symlinkSync('x', join(root, 'src2/dangling'))
    const second = moveInput.parse({ from: 'src2', to: 'other' })
    const refusing = { ...acrossDevices({ from: 'src2' }), symlink: () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }) } }
    await expect(moveEntry(second, { paths, platform: 'win32', io: refusing }, settleMove(second, { paths }))).rejects.toThrow('src2/dangling is a link, and Windows lets only an administrator, or a user with Developer Mode on, make one, so it was not copied')
    expect(readlinkSync(join(root, 'src2/dangling'))).toBe('x')
    expect(existsSync(join(root, 'other/src2'))).toBe(false)
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
