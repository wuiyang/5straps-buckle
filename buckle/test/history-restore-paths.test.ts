import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse, JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openChangeHistory, RestoreRefusedError, type ChangeHistory } from '../common/services/history/journal.js'
import { blobId } from '../common/services/history/object-store.js'
import { applySnapshot, SnapshotConflictError } from '../common/services/history/snapshot.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'

// Slice F2, item 2 (A1 of the 2026-11-01 review): a restore touches only the paths its checkpoints recorded, each read
// from the disk now and required to stand as the newest checkpoint left it, or the path is a conflict. Ignore rules never
// decide what a restore writes or removes: a rule added or removed in a checkpoint never makes a file below it "absent".

// A hook run once as a restore reads stored content back: an outside edit made while it waits (X2).
const contentRead = vi.hoisted(() => ({ hook: undefined as (() => void) | undefined }))
vi.mock('../common/services/history/object-store.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../common/services/history/object-store.js')>()
  return { ...actual, openObjectStore: (directory: string) => {
    const store = actual.openObjectStore(directory)
    return { ...store, read: async (id: string) => { const content = await store.read(id); const hook = contentRead.hook; contentRead.hook = undefined; hook?.(); return content } }
  } }
})

const roots: string[] = []
const histories: ChangeHistory[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  contentRead.hook = undefined
  for (const history of histories.splice(0)) await history.close()
  for (const runtime of runtimes.splice(0)) { runtime.closeWatchers(); await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string { const root = mkdtempSync(join(tmpdir(), 'buckle-restore-paths-')); roots.push(root); return root }

/** A command's checkpoint: the workspace captured whole, ignore rules read, as a program's run is. */
async function commandHistory() {
  const root = scratch()
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const history = await openChangeHistory({ directory: join(root, 'history'), excluded: [], maxBytes: 1_000_000 }); histories.push(history)
  const details = { sessionId: 'agent', stageId: 'turn', tool: 'shell_exec', roots: [workspace] }
  return { workspace, history, run: (change: () => void) => history.run(details, async () => change()) }
}

async function node(): Promise<{ workspace: string; runtime: BuckleRuntime }> {
  const root = scratch()
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_ALLOW_HOST_GIT: 'true', BUCKLE_PACKS: 'fs,history', BUCKLE_APPROVAL_TIMEOUT_MS: '1' })
  const runtime = await createRuntime({ config })
  runtimes.push(runtime)
  await runtime.grants.grant({ sessionId: 'agent', rule: 'write_scope', subject: runtime.paths().root, scope: 'session' })
  return { workspace, runtime }
}

function call(runtime: BuckleRuntime, requestId: string, tool: string, args: JsonObject): Promise<InvokeResponse> {
  return runtime.invoke({ request: { requestId, tool, args, approvalTokens: [] }, sessionId: 'agent' })
}

async function newestId(history: Pick<ChangeHistory, 'list'>): Promise<string> { return (await history.list()).at(-1)!.id }

describe('a restore after an ignore rule changed, from a command\'s checkpoint', () => {
  it('leaves a file a data/ rule hid, edited outside since, and restores the rule', async () => {
    const { workspace, history, run } = await commandHistory()
    writeFileSync(join(workspace, '.gitignore'), '')
    mkdirSync(join(workspace, 'data')); writeFileSync(join(workspace, 'data', 'app.db'), 'H1')
    await run(() => appendFileSync(join(workspace, '.gitignore'), 'data/\n'))
    writeFileSync(join(workspace, 'data', 'app.db'), 'H2')
    await history.restore(await newestId(history))
    expect(readFileSync(join(workspace, 'data', 'app.db'), 'utf8')).toBe('H2')
    expect(readFileSync(join(workspace, '.gitignore'), 'utf8')).toBe('')
  })

  it('keeps the files a dist/ rule hid before its removal, and restores the rule', async () => {
    const { workspace, history, run } = await commandHistory()
    writeFileSync(join(workspace, '.gitignore'), 'dist/\n')
    mkdirSync(join(workspace, 'dist')); writeFileSync(join(workspace, 'dist', 'app.js'), 'built')
    await run(() => writeFileSync(join(workspace, '.gitignore'), ''))
    await history.restore(await newestId(history))
    expect(readFileSync(join(workspace, 'dist', 'app.js'), 'utf8')).toBe('built')
    expect(readFileSync(join(workspace, '.gitignore'), 'utf8')).toBe('dist/\n')
  })
})

// X1 of the Codex review of 670f1dc2..01d3b0c9: a path a checkpoint recorded without content stays so across a chain of
// checkpoints, so restoring both sides of an ignore toggle, or of a size-cap crossing, never joins the first known state
// to the last and writes over an outside edit made while history could not see the path.
describe('a restore of a chain whose middle state history could not see', () => {
  it('leaves a file an ignore rule hid between two commands, edited outside in between', async () => {
    const { workspace, history, run } = await commandHistory()
    writeFileSync(join(workspace, '.gitignore'), '')
    mkdirSync(join(workspace, 'data')); writeFileSync(join(workspace, 'data', 'app.db'), 'H1')
    await run(() => writeFileSync(join(workspace, '.gitignore'), 'data/\n'))
    writeFileSync(join(workspace, 'data', 'app.db'), 'H2')
    await run(() => writeFileSync(join(workspace, '.gitignore'), ''))
    const plan = await history.plan({ steps: 2 })
    expect(plan.changes).toEqual([])
    await history.rollback({ target: { steps: 2 }, by: { sessionId: 'agent', tool: 'history_restore' } })
    expect(readFileSync(join(workspace, 'data', 'app.db'), 'utf8')).toBe('H2')
    expect(readFileSync(join(workspace, '.gitignore'), 'utf8')).toBe('')
  })

  it('leaves a file that crossed the size cap between two file tool writes, edited outside in between', async () => {
    const root = scratch()
    const workspace = join(root, 'workspace'); mkdirSync(workspace)
    const history = await openChangeHistory({ directory: join(root, 'history'), excluded: [], maxBytes: 1_000_000, maxFileBytes: 64 }); histories.push(history)
    const file = join(workspace, 'a.txt'); writeFileSync(file, 'A')
    const write = (content: string | Buffer) => history.run({ sessionId: 'agent', stageId: 'turn', tool: 'fs_write', roots: [file], scope: [{ path: file }] }, async () => writeFileSync(file, content))
    await write(Buffer.alloc(100, 1))
    writeFileSync(file, Buffer.alloc(120, 2))
    await write('C')
    await history.rollback({ target: { steps: 2 }, by: { sessionId: 'agent', tool: 'history_restore' } }).catch(() => undefined)
    expect(readFileSync(file, 'utf8')).toBe('C')
  })
})

describe('a restore of a file tool\'s checkpoint', () => {
  it('restores only .gitignore after a data/ rule was added through fs_write, the file below it edited outside', async () => {
    const { workspace, runtime } = await node()
    writeFileSync(join(workspace, '.gitignore'), '')
    mkdirSync(join(workspace, 'data')); writeFileSync(join(workspace, 'data', 'app.db'), 'H1')
    expect(await call(runtime, 'w-1', 'fs_write', { path: '.gitignore', content: 'data/\n' })).toMatchObject({ outcome: 'ok' })
    writeFileSync(join(workspace, 'data', 'app.db'), 'H2')
    expect((await runtime.history.list()).at(-1)!.changes).toEqual([{ path: join(workspace, '.gitignore'), kind: 'modified' }])
    await runtime.history.restore(await newestId(runtime.history))
    expect(readFileSync(join(workspace, 'data', 'app.db'), 'utf8')).toBe('H2')
    expect(readFileSync(join(workspace, '.gitignore'), 'utf8')).toBe('')
  })

  it('restores only .gitignore after a dist/ rule was removed through fs_write, keeping every built file', async () => {
    const { workspace, runtime } = await node()
    writeFileSync(join(workspace, '.gitignore'), 'dist/\n')
    mkdirSync(join(workspace, 'dist')); writeFileSync(join(workspace, 'dist', 'app.js'), 'built')
    expect(await call(runtime, 'w-1', 'fs_write', { path: '.gitignore', content: '# no rules\n' })).toMatchObject({ outcome: 'ok' })
    await runtime.history.restore(await newestId(runtime.history))
    expect(readFileSync(join(workspace, 'dist', 'app.js'), 'utf8')).toBe('built')
    expect(readFileSync(join(workspace, '.gitignore'), 'utf8')).toBe('dist/\n')
  })

  it('refuses, in the plan, a path edited outside since, naming it, and changes nothing', async () => {
    const { workspace, runtime } = await node()
    expect(await call(runtime, 'w-1', 'fs_write', { path: 'a.txt', content: 'one' })).toMatchObject({ outcome: 'ok' })
    expect(await call(runtime, 'w-2', 'fs_write', { path: 'b.txt', content: 'two' })).toMatchObject({ outcome: 'ok' })
    writeFileSync(join(workspace, 'a.txt'), 'owner')
    const refused = await call(runtime, 'r-1', 'history_restore', { steps: 2 })
    expect(refused).toMatchObject({ outcome: 'error', error: { code: 'RESTORE_REFUSED' } })
    expect(refused.outcome === 'error' ? refused.error.message : '').toContain('a.txt')
    expect(runtime.approvals.pending()).toEqual([])
    const owner = await runtime.history.restoreStage((await runtime.history.list())[0]!.stageId, 'agent').catch((error: unknown) => error)
    expect(owner).toBeInstanceOf(Error)
    const single = await runtime.history.restore((await runtime.history.list())[0]!.id).catch((error: unknown) => error)
    expect(single).toBeInstanceOf(RestoreRefusedError)
    expect((single as RestoreRefusedError).path).toBe(join(workspace, 'a.txt'))
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('owner')
    expect(existsSync(join(workspace, 'b.txt'))).toBe(true)
  })

  it('refuses to remove a folder that holds an entry no checkpoint names, an ignored one included', async () => {
    const { workspace, runtime } = await node()
    writeFileSync(join(workspace, '.gitignore'), '*.o\n')
    expect(await call(runtime, 'w-1', 'fs_write', { path: 'build/main.c', content: 'int main;', createParents: true })).toMatchObject({ outcome: 'ok' })
    writeFileSync(join(workspace, 'build', 'main.o'), 'object')
    const refused = await runtime.history.restore(await newestId(runtime.history)).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(RestoreRefusedError)
    expect((refused as RestoreRefusedError).path).toBe(join(workspace, 'build', 'main.o'))
    expect(readFileSync(join(workspace, 'build', 'main.o'), 'utf8')).toBe('object')
    expect(readFileSync(join(workspace, 'build', 'main.c'), 'utf8')).toBe('int main;')
  })

  it('records the restore as a checkpoint of its own, which undoes it', async () => {
    const { workspace, runtime } = await node()
    expect(await call(runtime, 'w-1', 'fs_write', { path: 'a.txt', content: 'one' })).toMatchObject({ outcome: 'ok' })
    expect(await call(runtime, 'w-2', 'fs_write', { path: 'a.txt', content: 'two' })).toMatchObject({ outcome: 'ok' })
    const restored = await runtime.history.restore(await newestId(runtime.history))
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('one')
    expect(restored).toMatchObject({ tool: 'owner_restore', restorable: true, changes: [{ path: join(workspace, 'a.txt'), kind: 'modified' }] })
    await runtime.history.restore(restored.id)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('two')
  })
})

// X2 of the Codex review of 670f1dc2..01d3b0c9: the check a restore makes holds until each path is changed. The content is
// read before the current state is, and each entry a restore changes is moved aside and checked again before anything is
// written, so an outside edit made after the check is never written over or removed.
describe('an outside edit after a restore checked the path', () => {
  it('is never written over when it lands while the restore reads stored content', async () => {
    const { workspace, runtime } = await node()
    const file = join(workspace, 'a.txt')
    expect(await call(runtime, 'w-1', 'fs_write', { path: 'a.txt', content: 'A' })).toMatchObject({ outcome: 'ok' })
    expect(await call(runtime, 'w-2', 'fs_write', { path: 'a.txt', content: 'B' })).toMatchObject({ outcome: 'ok' })
    contentRead.hook = () => writeFileSync(file, 'C')
    const refused = await runtime.history.restore(await newestId(runtime.history)).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(RestoreRefusedError)
    expect(readFileSync(file, 'utf8')).toBe('C')
  })

  for (const change of ['rewrite', 'delete'] as const) it(`stops a ${change} before anything changes, leaving it in place`, () => {
    const root = scratch()
    const [first, second] = [join(root, 'first.txt'), join(root, 'second.txt')]
    writeFileSync(first, 'checked'); writeFileSync(second, 'outside')
    const entry = (content: string) => ({ kind: 'file' as const, mode: 0o644, hash: blobId(Buffer.from(content)) })
    const current = { [first]: entry('checked'), [second]: entry('checked') }
    const target = change === 'rewrite' ? { [first]: entry('A'), [second]: entry('A') } : {}
    const applied = (() => { try { applySnapshot({ current, target, paths: [first, second], content: () => Buffer.from('A'), roots: [root] }) } catch (error) { return error } })()
    expect(applied).toBeInstanceOf(SnapshotConflictError)
    expect((applied as SnapshotConflictError).path).toBe(second)
    expect([readFileSync(first, 'utf8'), readFileSync(second, 'utf8')]).toEqual(['checked', 'outside'])
    expect(readdirSync(root).sort()).toEqual(['first.txt', 'second.txt'])
  })

  // R1.2 of the Codex recheck: the file a checkpoint made in a folder it made leaves before that folder does.
  it('removes a folder a checkpoint made with the file it made inside, and leaves nothing aside', async () => {
    const { workspace, runtime } = await node()
    expect(await call(runtime, 'w-1', 'fs_write', { path: 'made/deep/f.txt', content: 'A', createParents: true })).toMatchObject({ outcome: 'ok' })
    await runtime.history.restore(await newestId(runtime.history))
    expect(readdirSync(workspace)).toEqual([])
    const command = await commandHistory()
    await command.run(() => { mkdirSync(join(command.workspace, 'built', 'out'), { recursive: true }); writeFileSync(join(command.workspace, 'built', 'out', 'f.txt'), 'A') })
    await command.history.restore(await newestId(command.history))
    expect(readdirSync(command.workspace)).toEqual([])
    const root = scratch()
    const [folder, file] = [join(root, 'd'), join(root, 'd', 'f.txt')]
    mkdirSync(folder); writeFileSync(file, 'A')
    applySnapshot({ current: { [folder]: { kind: 'directory', mode: 0o755 }, [file]: { kind: 'file', mode: 0o644, hash: blobId(Buffer.from('A')) } }, target: {}, paths: [folder, file], content: () => Buffer.alloc(0), roots: [root] })
    expect(readdirSync(root)).toEqual([])
  })

  it('stops, with nothing changed, where a folder above a path is gone since the check', () => {
    const root = scratch()
    const [kept, gone] = [join(root, 'kept.txt'), join(root, 'gone', 'file.txt')]
    writeFileSync(kept, 'checked')
    const entry = (content: string) => ({ kind: 'file' as const, mode: 0o644, hash: blobId(Buffer.from(content)) })
    const applied = (() => { try { applySnapshot({ current: { [kept]: entry('checked'), [gone]: entry('checked') }, target: {}, paths: [kept, gone], content: () => Buffer.alloc(0), roots: [root] }) } catch (error) { return error } })()
    expect(applied).toBeInstanceOf(SnapshotConflictError)
    expect((applied as SnapshotConflictError).path).toBe(gone)
    expect(readdirSync(root)).toEqual(['kept.txt'])
  })
})
