import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse, JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { summarizeEffect } from '../common/domain/effect.js'
import type { FileChannel } from '../common/domain/tool.js'
import { BATCH_REWRITE_LIMIT, SHRINK_RATIO } from '../common/services/invocation/destructive-writes.js'
import { createSessionReads, MAX_KNOWN_PATHS, MAX_KNOWN_SESSIONS, READ_WINDOW_MS } from '../common/services/invocation/session-reads.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The destructive-write check (the fs-verbs brief): a write that empties a file, or leaves it under half its size, where
// the session never read it lately, and one call that rewrites more than ten existing files, ask at the destructive
// floor whatever the folder's write grant says.

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function node(root = mkdtempSync(join(tmpdir(), 'buckle-destructive-write-'))): Promise<{ root: string; workspace: string; runtime: BuckleRuntime }> {
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '1' })
  const runtime = await createRuntime({ config })
  runtimes.push(runtime)
  for (const sessionId of ['agent', 'other']) await runtime.grants.grant({ sessionId, rule: 'write_scope', subject: runtime.paths().root, scope: 'session' })
  return { root, workspace, runtime }
}

let sequence = 0
function call(runtime: BuckleRuntime, tool: string, args: JsonObject, input: { sessionId?: string; file?: FileChannel } = {}): Promise<InvokeResponse> {
  return runtime.invoke({ request: { requestId: `write-${++sequence}`, tool, args, approvalTokens: [] }, sessionId: input.sessionId ?? 'agent', ...(input.file ? { file: input.file } : {}) })
}

const reasons = (response: InvokeResponse) => (response.outcome === 'approval_required' ? response.approvals.map(approval => approval.reason) : [])

describe('a write that empties or halves a file the session never read', () => {
  it('asks when it empties one, inside a folder whose writes are granted, and writes nothing until a person answers', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'notes.md'), 'a long note the agent never looked at')
    const response = await call(runtime, 'fs_write', { path: 'notes.md', content: '' })
    expect(response).toMatchObject({ outcome: 'approval_required', approvals: [{ rule: 'write_scope', subject: `overwrite:${join(runtime.paths().root, 'notes.md')}`, offeredScopes: ['once', 'session', 'always'] }] })
    expect(reasons(response)[0]).toBe(`[danger] Writing ${join(runtime.paths().root, 'notes.md')} empties a file this session never read, so a person decides, whatever the folder's write grant says`)
    expect(runtime.approvalService.waiting()[0]?.call?.effects).toEqual([`write ${join(runtime.paths().root, 'notes.md')}`, `empties ${join(runtime.paths().root, 'notes.md')}, a file this session never read`])
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('a long note the agent never looked at')
  })

  it('asks when it leaves under half the bytes, and lets half or more through', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'a.md'), '0123456789')
    expect(reasons(await call(runtime, 'fs_write', { path: 'a.md', content: '0123' }))).toEqual([`[danger] Writing ${join(runtime.paths().root, 'a.md')} shrinks a file this session never read to under half its size, so a person decides, whatever the folder's write grant says`])
    expect(await call(runtime, 'fs_write', { path: 'a.md', content: '01234' })).toMatchObject({ outcome: 'ok' })
    expect(SHRINK_RATIO).toBe(0.5)
  })

  it('lets a write through once the session read the file, by fs_read or fs_read_batch, and never on another session\'s read', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'a.md'), 'read first')
    writeFileSync(join(workspace, 'b.md'), 'read in a batch')
    expect(await call(runtime, 'fs_read', { path: 'a.md' }, { sessionId: 'other' })).toMatchObject({ outcome: 'ok' })
    expect((await call(runtime, 'fs_write', { path: 'a.md', content: '' })).outcome).toBe('approval_required')
    expect(await call(runtime, 'fs_read', { path: 'a.md' })).toMatchObject({ outcome: 'ok' })
    expect(await call(runtime, 'fs_write', { path: 'a.md', content: '' })).toMatchObject({ outcome: 'ok' })
    await call(runtime, 'fs_read_batch', { paths: ['b.md'] })
    expect(await call(runtime, 'fs_write', { path: 'b.md', content: 'x' })).toMatchObject({ outcome: 'ok' })
  })

  it('lets the session empty a file it wrote itself', async () => {
    const { runtime } = await node()
    expect(await call(runtime, 'fs_write', { path: 'own.md', content: 'written by this session' })).toMatchObject({ outcome: 'ok' })
    expect(await call(runtime, 'fs_write', { path: 'own.md', content: '' })).toMatchObject({ outcome: 'ok' })
  })

  it('asks for fs_patch as for a write, working out what it leaves from the file', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'a.ts'), 'export const long = "a value that the patch removes"\n')
    const edits = [{ oldText: 'export const long = "a value that the patch removes"', newText: 'x' }]
    expect(reasons(await call(runtime, 'fs_patch', { path: 'a.ts', edits }))[0]).toContain('shrinks a file this session never read')
    await call(runtime, 'fs_read', { path: 'a.ts' })
    expect(await call(runtime, 'fs_patch', { path: 'a.ts', edits })).toMatchObject({ outcome: 'ok' })
  })

  it('asks for a copy fs_receive lands over an existing file, by the digest\'s byte count', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'big.bin'), 'x'.repeat(100))
    const bytes = Buffer.from('tiny')
    const file: FileChannel = { kind: 'receive', body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }) }
    const response = await call(runtime, 'fs_receive', { path: 'big.bin', bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }, { file })
    expect(reasons(response)[0]).toContain('shrinks a file this session never read')
    expect(readFileSync(join(workspace, 'big.bin'), 'utf8')).toBe('x'.repeat(100))
  })

  it('sizes a base64 write by the bytes it decodes to, not the length of its text', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'data.bin'), 'x'.repeat(5_000))
    // Eight thousand characters that are no base64 decode to nothing, which Buffer.byteLength reads as six thousand bytes.
    const response = await call(runtime, 'fs_write', { path: 'data.bin', content: '%'.repeat(8_000), encoding: 'base64' })
    expect(reasons(response)[0]).toContain('empties a file this session never read')
    expect(readFileSync(join(workspace, 'data.bin'), 'utf8')).toBe('x'.repeat(5_000))
    const batch = await call(runtime, 'fs_write_batch', { files: [{ path: 'data.bin', content: '%'.repeat(8_000), encoding: 'base64' }] })
    expect(reasons(batch)[0]).toContain('empties a file this session never read')
    expect(await call(runtime, 'fs_write', { path: 'data.bin', content: Buffer.from('y'.repeat(4_000)).toString('base64'), encoding: 'base64' })).toMatchObject({ outcome: 'ok' })
  })

  it('refuses fs_patch on a file over the size fs_read reads, which the check could not size', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'huge.txt'), 'a'.repeat(10 * 1_048_576 + 1))
    const response = await call(runtime, 'fs_patch', { path: 'huge.txt', edits: [{ oldText: 'a', newText: '', replaceAll: true }] })
    expect(response).toMatchObject({ outcome: 'error', error: { message: expect.stringContaining('exceeds 10485760 bytes, so nothing was patched') } })
    expect(readFileSync(join(workspace, 'huge.txt'), 'utf8').length).toBe(10 * 1_048_576 + 1)
  })

  it('does not count a file moved onto a path the session read as read, and follows a read file to where it moves', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'a.txt'), 'four')
    writeFileSync(join(workspace, 'big.txt'), 'x'.repeat(90_000))
    await call(runtime, 'fs_read', { path: 'a.txt' })
    expect(await call(runtime, 'fs_move', { from: 'a.txt', to: 'old.txt' })).toMatchObject({ outcome: 'ok' })
    expect(await call(runtime, 'fs_move', { from: 'big.txt', to: 'a.txt' })).toMatchObject({ outcome: 'ok' })
    expect(reasons(await call(runtime, 'fs_write', { path: 'a.txt', content: '' }))[0]).toContain('empties a file this session never read')
    // What was read stands at old.txt now, and the session still knows it.
    expect(await call(runtime, 'fs_write', { path: 'old.txt', content: '' })).toMatchObject({ outcome: 'ok' })
  })

  it('forgets a file the session read once it is deleted, so one created there by another hand is not known', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'a.txt'), 'read')
    await call(runtime, 'fs_read', { path: 'a.txt' })
    // Inside the workspace's folder, where writes are granted, a delete runs with no ask (the delete policy's default).
    expect(await call(runtime, 'fs_delete', { paths: ['a.txt'] })).toMatchObject({ outcome: 'ok', output: { removed: 1 } })
    expect(existsSync(join(workspace, 'a.txt'))).toBe(false)
    writeFileSync(join(workspace, 'a.txt'), 'x'.repeat(5_000))
    expect(reasons(await call(runtime, 'fs_write', { path: 'a.txt', content: '' }))[0]).toContain('empties a file this session never read')
  })

  it('forgets every read when the node restarts, so the first such write after it asks', async () => {
    const first = await node()
    writeFileSync(join(first.workspace, 'a.md'), 'remembered until a restart')
    await call(first.runtime, 'fs_read', { path: 'a.md' })
    await first.runtime.approvalService.close()
    await first.runtime.history.close()
    runtimes.splice(runtimes.indexOf(first.runtime), 1)
    const second = await node(first.root)
    expect((await call(second.runtime, 'fs_write', { path: 'a.md', content: '' })).outcome).toBe('approval_required')
  })
})

describe('a batch that rewrites many existing files', () => {
  async function batchOf(count: number) {
    const { runtime, workspace } = await node()
    const files = Array.from({ length: count }, (_, index) => ({ path: `f${index}.md`, content: `new ${index}` }))
    for (const file of files) writeFileSync(join(workspace, file.path), `old ${file.path}`)
    return { runtime, response: await call(runtime, 'fs_write_batch', { files }) }
  }

  it('asks for more than ten, naming how many', async () => {
    const { runtime, response } = await batchOf(BATCH_REWRITE_LIMIT + 1)
    expect(response).toMatchObject({ outcome: 'approval_required', approvals: [{ subject: `rewrite-batch:${runtime.paths().root}` }] })
    expect(reasons(response)).toEqual(['[danger] This call rewrites 11 existing files at once, so a person decides, whatever the folder\'s write grant says'])
    expect(summarizeEffect({ kind: 'many_rewrites', files: 11 })).toBe('rewrites 11 existing files at once')
  })

  it('lets ten through, and counts no new file', async () => {
    expect((await batchOf(BATCH_REWRITE_LIMIT)).response).toMatchObject({ outcome: 'ok' })
    const { runtime, workspace } = await node()
    for (let index = 0; index < 10; index++) writeFileSync(join(workspace, `f${index}.md`), 'old')
    const files = Array.from({ length: 15 }, (_, index) => ({ path: `f${index}.md`, content: 'new' }))
    expect(await call(runtime, 'fs_write_batch', { files })).toMatchObject({ outcome: 'ok' })
  })
})

describe('the session read set', () => {
  it('carries a sighting to where its file moves, forgets what stood at the landing, and forgets a deleted file, for every session', () => {
    const reads = createSessionReads()
    reads.note('s', '/w/dir/a', 0)
    reads.note('s', '/w/dir/sub/b', 0)
    reads.note('t', '/w/dir/a', 0)
    reads.note('s', '/w/new/old', 0)
    reads.relocate('/w/dir', '/w/new')
    expect(reads.knows('s', '/w/new/a', 0)).toBe(true)
    expect(reads.knows('s', '/w/new/sub/b', 0)).toBe(true)
    expect(reads.knows('t', '/w/new/a', 0)).toBe(true)
    expect(reads.knows('s', '/w/dir/a', 0)).toBe(false)
    expect(reads.knows('s', '/w/new/old', 0)).toBe(false)
    reads.relocate('/w/new/a', null)
    expect(reads.knows('s', '/w/new/a', 0)).toBe(false)
    expect(reads.knows('s', '/w/new/sub/b', 0)).toBe(true)
    reads.relocate('/w/new/s', '/w/new/z')
    expect(reads.knows('s', '/w/new/sub/b', 0)).toBe(true)
  })

  it('counts a read for an hour, then forgets it', () => {
    const reads = createSessionReads()
    reads.note('s', '/w/a', 0)
    expect(reads.knows('s', '/w/a', READ_WINDOW_MS)).toBe(true)
    expect(reads.knows('s', '/w/a', READ_WINDOW_MS + 1)).toBe(false)
    expect(reads.knows('t', '/w/a', 0)).toBe(false)
  })

  it('keeps the last 10,000 paths of a session and the last 1,000 sessions', () => {
    const reads = createSessionReads()
    for (let index = 0; index <= MAX_KNOWN_PATHS; index++) reads.note('s', `/w/${index}`, 0)
    expect(reads.knows('s', '/w/0', 0)).toBe(false)
    expect(reads.knows('s', `/w/${MAX_KNOWN_PATHS}`, 0)).toBe(true)
    for (let index = 0; index < MAX_KNOWN_SESSIONS; index++) reads.note(`session-${index}`, '/w/a', 0)
    expect(reads.knows('s', `/w/${MAX_KNOWN_PATHS}`, 0)).toBe(false)
    expect(reads.knows('session-1', '/w/a', 0)).toBe(true)
  })
})
