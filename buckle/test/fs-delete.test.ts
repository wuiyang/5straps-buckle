import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse, JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { describeCall } from '../common/domain/describe-call.js'
import { actionPhrase } from '../common/domain/action-phrase.js'
import { createPathView } from '../common/domain/path-view.js'
import { deletePaths, settleDelete } from '../common/services/packs/fs/delete.js'
import { deleteInput } from '../common/services/packs/fs/schemas.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'

// fs_delete (the fs-verbs brief): every delete asks at the destructive floor, even inside a folder whose writes are
// granted; a link goes and its target stays; the change history brings every file back. The workspace here sets
// files.deleteInWorkspace ask, which keeps the floor inside its own folder (the delete policy brief; delete-policy.test.ts).

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function node(extra: Record<string, string> = {}): Promise<{ root: string; workspace: string; state: string; runtime: BuckleRuntime }> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-fs-delete-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const state = join(root, 'state')
  mkdirSync(workspace)
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: state, BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '1', BUCKLE_DELETE_IN_WORKSPACE: 'ask', ...extra })
  const runtime = await createRuntime({ config })
  runtimes.push(runtime)
  // Writes anywhere in the folder are granted for the session, as a person's session grant would; deletes still ask.
  await runtime.grants.grant({ sessionId: 'agent', rule: 'write_scope', subject: runtime.paths().root, scope: 'session' })
  return { root, workspace, state, runtime }
}

let sequence = 0
function call(runtime: BuckleRuntime, tool: string, args: JsonObject, input: { requestId?: string; tokens?: string[] } = {}): Promise<InvokeResponse> {
  return runtime.invoke({ request: { requestId: input.requestId ?? `delete-${++sequence}`, tool, args, approvalTokens: input.tokens ?? [] }, sessionId: 'agent' })
}

/** The call asks; a person approves every ask once; the same call sent again runs. */
async function approved(runtime: BuckleRuntime, tool: string, args: JsonObject): Promise<InvokeResponse> {
  const requestId = `approved-${++sequence}`
  const asked = await call(runtime, tool, args, { requestId })
  expect(asked.outcome).toBe('approval_required')
  const tokens = asked.outcome === 'approval_required' ? asked.approvals.map(approval => approval.token) : []
  for (const token of tokens) expect((await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, authority: 'admin' })).ok).toBe(true)
  return call(runtime, tool, args, { requestId, tokens })
}

const errorOf = (response: InvokeResponse) => (response.outcome === 'error' ? response.error : null)

describe('fs_delete asks at the destructive floor', () => {
  it('asks for a file inside a folder whose writes are granted, and removes it once a person approves', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'notes.txt'), 'keep me safe')
    const asked = await call(runtime, 'fs_delete', { paths: ['notes.txt'] })
    expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ rule: 'write_scope', subject: `delete:${runtime.paths().root}`, offeredScopes: ['once', 'session', 'always'] }] })
    expect(existsSync(join(workspace, 'notes.txt'))).toBe(true)
    const ask = runtime.approvalService.waiting().find(item => item.request.tool === 'fs_delete')
    expect(ask?.call?.description).toBe(`Delete 1 file: "notes.txt" in ${JSON.stringify(runtime.paths().displayRoot)}`)
    expect(ask?.call?.effects).toEqual([`delete ${join(runtime.paths().root, 'notes.txt')}`])
    expect(actionPhrase('fs_delete')).toBe('delete files')

    const response = await approved(runtime, 'fs_delete', { paths: ['notes.txt'] })
    expect(response).toMatchObject({ outcome: 'ok', output: { removed: 1, results: [{ path: 'notes.txt', removed: true }] } })
    expect(existsSync(join(workspace, 'notes.txt'))).toBe(false)
  })

  it('runs without asking once a person granted deletes in that folder for the session', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'a.txt'), 'a')
    await runtime.grants.grant({ sessionId: 'agent', rule: 'write_scope', subject: `delete:${runtime.paths().root}`, scope: 'session' })
    expect(await call(runtime, 'fs_delete', { paths: ['a.txt'] })).toMatchObject({ outcome: 'ok', output: { removed: 1 } })
  })

  it('checkpoints every file it removes, and buckle history restore brings them back', async () => {
    const { runtime, workspace } = await node()
    mkdirSync(join(workspace, 'build/deep'), { recursive: true })
    writeFileSync(join(workspace, 'build/out.js'), 'console.log(1)')
    writeFileSync(join(workspace, 'build/deep/map.json'), '{}')
    writeFileSync(join(workspace, 'top.txt'), 'top')
    expect(await approved(runtime, 'fs_delete', { paths: ['build', 'top.txt'], recursive: true })).toMatchObject({ outcome: 'ok', output: { removed: 2 } })
    expect(existsSync(join(workspace, 'build'))).toBe(false)
    const [checkpoint] = (await runtime.history.list()).filter(item => item.tool === 'fs_delete')
    expect(checkpoint?.changes).toEqual(expect.arrayContaining([{ path: join(runtime.paths().root, 'build/out.js'), kind: 'deleted' }, { path: join(runtime.paths().root, 'top.txt'), kind: 'deleted' }]))
    await runtime.history.restore(checkpoint!.id)
    expect(readFileSync(join(workspace, 'build/out.js'), 'utf8')).toBe('console.log(1)')
    expect(readFileSync(join(workspace, 'build/deep/map.json'), 'utf8')).toBe('{}')
    expect(readFileSync(join(workspace, 'top.txt'), 'utf8')).toBe('top')
  })

  it('keeps every path in its audit entry, credentials hidden', async () => {
    const { runtime, workspace } = await node()
    mkdirSync(join(workspace, 'token=synthetic-value'))
    writeFileSync(join(workspace, 'token=synthetic-value/a.txt'), 'a')
    writeFileSync(join(workspace, 'b.txt'), 'b')
    await approved(runtime, 'fs_delete', { paths: ['token=synthetic-value/a.txt', 'b.txt'] })
    const result = runtime.actions.read(20).filter(entry => entry.tool === 'fs_delete' && entry.event === 'result').at(-1)
    expect(result).toMatchObject({ outcome: 'ok', effects: ['delete_path'], args: { paths: ['token=[redacted]', 'b.txt'] } })
    expect(JSON.stringify(runtime.actions.read(50))).not.toContain('synthetic-value')
  })
})

describe('fs_delete removes each kind of entry as itself', () => {
  it('unlinks a link and leaves its target untouched', async () => {
    const { runtime, workspace, root } = await node()
    writeFileSync(join(root, 'target.txt'), 'outside the workspace')
    symlinkSync(join(root, 'target.txt'), join(workspace, 'link.txt'))
    const asked = await call(runtime, 'fs_delete', { paths: ['link.txt'] })
    expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ subject: `delete:${runtime.paths().root}` }] })
    expect(await approved(runtime, 'fs_delete', { paths: ['link.txt'] })).toMatchObject({ outcome: 'ok', output: { removed: 1 } })
    expect(lstatSync(join(workspace, 'link.txt'), { throwIfNoEntry: false })).toBeUndefined()
    expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('outside the workspace')
  })

  it('removes an empty folder without recursive', async () => {
    const { runtime, workspace } = await node()
    mkdirSync(join(workspace, 'empty'))
    expect(await approved(runtime, 'fs_delete', { paths: ['empty'] })).toMatchObject({ outcome: 'ok', output: { removed: 1 } })
    expect(existsSync(join(workspace, 'empty'))).toBe(false)
  })

  it('refuses a folder that holds entries without recursive before anyone is asked, and counts them in the ask with it', async () => {
    const { runtime, workspace } = await node()
    mkdirSync(join(workspace, 'full/sub'), { recursive: true })
    writeFileSync(join(workspace, 'full/a.txt'), 'a')
    writeFileSync(join(workspace, 'full/sub/b.txt'), 'b')
    expect(errorOf(await call(runtime, 'fs_delete', { paths: ['full'] }))).toMatchObject({ code: 'FOLDER_NOT_EMPTY' })
    expect(runtime.approvalService.waiting()).toEqual([])
    const asked = await call(runtime, 'fs_delete', { paths: ['full'], recursive: true })
    expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ subject: `delete-tree:${join(runtime.paths().root, 'full')}` }] })
    if (asked.outcome !== 'approval_required') return
    expect(asked.approvals[0]!.reason).toContain('and everything in it (2 files and 1 folder)')
    expect(runtime.approvalService.waiting()[0]?.call?.description).toBe(`Delete 1 file: "full", each folder among them with everything in it in ${JSON.stringify(runtime.paths().displayRoot)}`)
    expect(await approved(runtime, 'fs_delete', { paths: ['full'], recursive: true })).toMatchObject({ outcome: 'ok', output: { removed: 1 } })
    expect(existsSync(join(workspace, 'full'))).toBe(false)
  })

  it('reports a missing path without asking, and goes on to the next', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'here.txt'), 'here')
    expect(await call(runtime, 'fs_delete', { paths: ['gone.txt'] })).toMatchObject({ outcome: 'ok', output: { removed: 0, results: [{ path: 'gone.txt', removed: false, missing: true }] } })
    expect(await approved(runtime, 'fs_delete', { paths: ['gone.txt', 'here.txt'] })).toMatchObject({ outcome: 'ok', output: { removed: 1, results: [{ path: 'gone.txt', missing: true }, { path: 'here.txt', removed: true }] } })
  })

  it('names every path in the description, none counted away', () => {
    const paths = Array.from({ length: 8 }, (_, index) => `file-${index}.txt`)
    const description = describeCall({ tool: 'fs_delete', args: { paths }, cwd: '/workspace' })
    for (const path of paths) expect(description).toContain(`"${path}"`)
    expect(description).not.toContain('more')
  })
})

describe('the checkpoint of a delete outside the workspace', () => {
  it('covers the entry alone, so a hard-linked pair beside it does not stop an approved delete, and a restore brings it back', async () => {
    const { runtime, workspace, root } = await node()
    mkdirSync(join(root, 'outside'))
    writeFileSync(join(root, 'outside/x.txt'), 'outside content')
    writeFileSync(join(root, 'outside/h1'), 'linked')
    linkSync(join(root, 'outside/h1'), join(root, 'outside/h2'))
    expect(await approved(runtime, 'fs_delete', { paths: ['../outside/x.txt'] })).toMatchObject({ outcome: 'ok', output: { removed: 1 } })
    expect(existsSync(join(root, 'outside/x.txt'))).toBe(false)
    const [checkpoint] = (await runtime.history.list()).filter(item => item.tool === 'fs_delete')
    await runtime.history.restore(checkpoint!.id)
    expect(readFileSync(join(root, 'outside/x.txt'), 'utf8')).toBe('outside content')
    expect(existsSync(workspace)).toBe(true)
  })

  it('records a link as a link and never follows it', async () => {
    const { runtime, root } = await node()
    mkdirSync(join(root, 'outside'))
    writeFileSync(join(root, 'outside/target.txt'), 'target')
    symlinkSync('target.txt', join(root, 'outside/link.txt'))
    expect(await approved(runtime, 'fs_delete', { paths: ['../outside/link.txt'] })).toMatchObject({ outcome: 'ok' })
    const [checkpoint] = (await runtime.history.list()).filter(item => item.tool === 'fs_delete')
    await runtime.history.restore(checkpoint!.id)
    expect(readlinkSync(join(root, 'outside/link.txt'))).toBe('target.txt')
    expect(readFileSync(join(root, 'outside/target.txt'), 'utf8')).toBe('target')
  })
})

describe('fs_delete is refused where a write is', () => {
  it('in Buckle\'s own state', async () => {
    const { runtime, state } = await node()
    expect(errorOf(await call(runtime, 'fs_delete', { paths: [join(state, 'workspaces')], recursive: true }))?.code).toBe('PERMISSION_DENIED')
    expect(existsSync(join(state, 'workspaces'))).toBe(true)
  })

  it('beyond a mounted workspace\'s folders, and for the workspace\'s own folder', async () => {
    const { runtime, workspace, root } = await node({ BUCKLE_WORKSPACE_MOUNT: '/workspace' })
    writeFileSync(join(root, 'outside.txt'), 'outside')
    expect(errorOf(await call(runtime, 'fs_delete', { paths: ['/workspace/../outside.txt'] }))).not.toBeNull()
    expect(errorOf(await call(runtime, 'fs_delete', { paths: [join(root, 'outside.txt')] }))).not.toBeNull()
    expect(readFileSync(join(root, 'outside.txt'), 'utf8')).toBe('outside')
    writeFileSync(join(workspace, 'a.txt'), 'a')
    expect(errorOf(await call(runtime, 'fs_delete', { paths: ['/workspace'], recursive: true }))?.code).toBe('PERMISSION_DENIED')
    expect(existsSync(join(workspace, 'a.txt'))).toBe(true)
  })
})

describe('fs_delete of a folder the workspace shows', () => {
  // The 0.1.8 publish test: the folder first answered FOLDER_NOT_EMPTY and told the agent to send recursive: true, which was then refused.
  it('is refused once, with the reason and no hint to send recursive, whether or not recursive is sent', async () => {
    const { runtime, workspace } = await node({ BUCKLE_WORKSPACE_MOUNT: '/workspace' })
    writeFileSync(join(workspace, 'a.txt'), 'a')
    const attempts: JsonObject[] = [{ paths: ['/workspace'] }, { paths: ['/workspace'], recursive: false }, { paths: ['/workspace'], recursive: true }, { paths: ['.'] }]
    for (const args of attempts) {
      const error = errorOf(await call(runtime, 'fs_delete', args))
      expect(error, JSON.stringify(args)).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('a folder the workspace shows or a read-only mount, which no tool removes or moves') })
      expect(error?.message).not.toContain('recursive')
    }
    expect(runtime.approvalService.waiting()).toEqual([])
    expect(existsSync(join(workspace, 'a.txt'))).toBe(true)
  })

  it('does not count what a folder it is refused for holds, so a workspace of any size gets the same refusal', async () => {
    const { paths, root } = (() => {
      const dir = mkdtempSync(join(tmpdir(), 'buckle-fs-delete-root-'))
      roots.push(dir)
      return { root: dir, paths: createPathView({ root: dir, mount: null }) }
    })()
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'a.txt'), 'a')
    for (const recursive of [false, true]) expect(() => settleDelete(deleteInput.parse({ paths: ['.'], recursive }), { paths })).not.toThrow()
  })

  it('still tells the agent to send recursive for a folder inside it that holds entries', async () => {
    const { runtime, workspace } = await node({ BUCKLE_WORKSPACE_MOUNT: '/workspace' })
    mkdirSync(join(workspace, 'full'))
    writeFileSync(join(workspace, 'full', 'a.txt'), 'a')
    expect(errorOf(await call(runtime, 'fs_delete', { paths: ['/workspace/full'] }))).toMatchObject({ code: 'FOLDER_NOT_EMPTY', message: expect.stringContaining('send recursive: true') })
  })
})

describe('the path fs_delete answers', () => {
  it('is relative to the workspace folder, as the other tools answer it, whether it was sent absolute or relative', async () => {
    const { runtime, workspace } = await node({ BUCKLE_WORKSPACE_MOUNT: '/workspace' })
    mkdirSync(join(workspace, 'sub'))
    for (const name of ['renamed.txt', 'sub/b.txt', 'c.txt']) writeFileSync(join(workspace, name), name)
    const response = await approved(runtime, 'fs_delete', { paths: ['/workspace/renamed.txt', './sub/b.txt', '/workspace/gone.txt', 'c.txt'] })
    expect(response).toMatchObject({ outcome: 'ok', output: { removed: 3, results: [
      { path: 'renamed.txt', removed: true },
      { path: 'sub/b.txt', removed: true },
      { path: 'gone.txt', removed: false, missing: true },
      { path: 'c.txt', removed: true },
    ] } })
  })

  it('is relative on a refusal and on the paths not attempted after it, and the refusal still names the path as it was sent', async () => {
    const { root, paths } = (() => {
      const dir = mkdtempSync(join(tmpdir(), 'buckle-fs-delete-shown-'))
      roots.push(dir)
      return { root: dir, paths: createPathView({ root: dir, mount: '/workspace' }) }
    })()
    for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(root, name), name)
    const input = deleteInput.parse({ paths: ['/workspace/a.txt', '/workspace/b.txt', '/workspace/c.txt'] })
    const io = { unlink: (path: string) => { if (path.endsWith('b.txt')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); rmSync(path) }, rmdir: () => {}, pause: async () => {} }
    expect(await deletePaths(input, { paths, io }, settleDelete(input, { paths }))).toEqual({ removed: 1, results: [
      { path: 'a.txt', removed: true },
      { path: 'b.txt', removed: false, refused: '/workspace/b.txt could not be removed (EACCES)', code: 'PERMISSION_DENIED' },
      { path: 'c.txt', removed: false, notAttempted: true },
    ] })
  })
})

describe('deletePaths', () => {
  const workspaceOf = () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-fs-delete-unit-'))
    roots.push(root)
    return { root, paths: createPathView({ root, mount: null }) }
  }

  it('tries a removal Windows refuses as held again, then names the file as held, and stops the batch there', async () => {
    const { root, paths } = workspaceOf()
    for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(root, name), name)
    const input = deleteInput.parse({ paths: ['a.txt', 'b.txt', 'c.txt'] })
    const judged = settleDelete(input, { paths })
    const pauses: number[] = []
    const held = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    const io = { unlink: (path: string) => { if (path.endsWith('b.txt')) throw held; rmSync(path) }, rmdir: (path: string) => rmSync(path, { recursive: false }), pause: async (ms: number) => { pauses.push(ms) } }
    const output = await deletePaths(input, { paths, io, platform: 'win32' }, judged)
    expect(output).toEqual({ removed: 1, results: [
      { path: 'a.txt', removed: true },
      { path: 'b.txt', removed: false, refused: 'b.txt is held open by another program, or Windows keeps it read-only, so it was not removed; close it and send the call again', code: 'ENTRY_HELD' },
      { path: 'c.txt', removed: false, notAttempted: true },
    ] })
    expect(pauses).toEqual([20, 40, 60, 80])
    expect(existsSync(join(root, 'b.txt'))).toBe(true)
    expect(existsSync(join(root, 'c.txt'))).toBe(true)
  })

  it('reports a removal the system refuses as that path\'s refusal, keeping the paths removed before it, and stops there', async () => {
    const { root, paths } = workspaceOf()
    mkdirSync(join(root, 'locked'))
    for (const name of ['a.txt', 'locked/b.txt', 'c.txt']) writeFileSync(join(root, name), name)
    const input = deleteInput.parse({ paths: ['a.txt', 'locked/b.txt', 'c.txt'] })
    const refuse = (code: string) => Object.assign(new Error(`${code}: permission denied`), { code })
    const io = { unlink: (path: string) => { if (path.endsWith('b.txt')) throw refuse('EACCES'); rmSync(path) }, rmdir: () => {}, pause: async () => {} }
    expect(await deletePaths(input, { paths, io }, settleDelete(input, { paths }))).toEqual({ removed: 1, results: [
      { path: 'a.txt', removed: true },
      { path: 'locked/b.txt', removed: false, refused: 'locked/b.txt could not be removed (EACCES)', code: 'PERMISSION_DENIED' },
      { path: 'c.txt', removed: false, notAttempted: true },
    ] })
    expect(existsSync(join(root, 'a.txt'))).toBe(false)
    expect(existsSync(join(root, 'c.txt'))).toBe(true)
    // A folder removed whole that stops part way says it may be gone in part, and a code other than a refusal keeps its own.
    mkdirSync(join(root, 'tree'))
    writeFileSync(join(root, 'tree/x.txt'), 'x')
    const whole = deleteInput.parse({ paths: ['tree'], recursive: true })
    const failing = { unlink: () => { throw refuse('EIO') }, rmdir: () => {}, pause: async () => {} }
    expect(await deletePaths(whole, { paths, io: failing }, settleDelete(whole, { paths }))).toEqual({ removed: 0, results: [
      { path: 'tree', removed: false, refused: 'tree could not be removed (EIO), so what it holds may be removed only in part', code: 'REMOVAL_FAILED' },
    ] })
  })

  it.skipIf(process.platform === 'win32')('refuses a folder holding an entry it cannot remove by name before removing anything', async () => {
    const { runtime, workspace } = await node()
    mkdirSync(join(workspace, 'build'))
    for (const name of ['a.js', 'b.js', 'c\\d.js', 'z.js']) writeFileSync(join(workspace, 'build', name), name)
    const response = await call(runtime, 'fs_delete', { paths: ['build'], recursive: true })
    expect(errorOf(response)).toMatchObject({ code: 'FOLDER_NOT_REMOVABLE', message: 'build/c\\d.js has a name Buckle would read as another path, so it cannot be removed by name and nothing was removed: remove that entry another way first' })
    expect(runtime.approvalService.waiting()).toEqual([])
    expect(readFileSync(join(workspace, 'build/a.js'), 'utf8')).toBe('a.js')
    expect(readFileSync(join(workspace, 'build/z.js'), 'utf8')).toBe('z.js')
  })

  it('removes a file Windows held for a moment once it lets go', async () => {
    const { root, paths } = workspaceOf()
    writeFileSync(join(root, 'a.txt'), 'a')
    const input = deleteInput.parse({ paths: ['a.txt'] })
    let refusals = 2
    const io = { unlink: (path: string) => { if (refusals-- > 0) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); rmSync(path) }, rmdir: () => {}, pause: async () => {} }
    expect(await deletePaths(input, { paths, io, platform: 'win32' }, settleDelete(input, { paths }))).toMatchObject({ removed: 1 })
  })

  it('refuses an entry that is another kind now than its check saw, and a link swapped in for a folder', async () => {
    const { root, paths } = workspaceOf()
    mkdirSync(join(root, 'was-folder'))
    writeFileSync(join(root, 'target.txt'), 'kept')
    const input = deleteInput.parse({ paths: ['was-folder'], recursive: true })
    const judged = settleDelete(input, { paths })
    rmSync(join(root, 'was-folder'), { recursive: true })
    symlinkSync(join(root, 'target.txt'), join(root, 'was-folder'))
    expect(await deletePaths(input, { paths }, judged)).toMatchObject({ removed: 0, results: [{ path: 'was-folder', removed: false, code: 'PERMISSION_DENIED' }] })
    expect(readlinkSync(join(root, 'was-folder'))).toBe(join(root, 'target.txt'))
  })
})
