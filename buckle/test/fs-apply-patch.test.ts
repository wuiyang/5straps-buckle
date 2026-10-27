import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse, JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { actionPhrase } from '../common/domain/action-phrase.js'
import { applyHunks, parseUnifiedDiff } from '../common/services/packs/fs/unified-diff.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'

// fs_apply_patch (the fs-verbs brief): a unified diff over several files, all or nothing, written as fs_write writes,
// with the whole diff in the ask.

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function node(): Promise<{ workspace: string; runtime: BuckleRuntime }> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-apply-patch-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '1' })
  const runtime = await createRuntime({ config })
  runtimes.push(runtime)
  await runtime.grants.grant({ sessionId: 'agent', rule: 'write_scope', subject: runtime.paths().root, scope: 'session' })
  return { workspace, runtime }
}

let sequence = 0
function call(runtime: BuckleRuntime, tool: string, args: JsonObject, input: { requestId?: string; tokens?: string[] } = {}): Promise<InvokeResponse> {
  return runtime.invoke({ request: { requestId: input.requestId ?? `patch-${++sequence}`, tool, args, approvalTokens: input.tokens ?? [] }, sessionId: 'agent' })
}

const errorOf = (response: InvokeResponse) => (response.outcome === 'error' ? response.error : null)

const TWO_FILES = [
  'diff --git a/a.txt b/a.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '--- a/sub/b.txt',
  '+++ b/sub/b.txt',
  '@@ -1,2 +1,3 @@',
  ' alpha',
  '+inserted',
  ' beta',
  '',
].join('\n')

const apply = (patch: string, current: Record<string, string | Buffer>) => parseUnifiedDiff(patch).map(change => ({ path: change.path, kind: change.kind, content: applyHunks(change, change.kind === 'create' ? null : Buffer.from(current[change.path]!)).toString('utf8') }))

describe('the unified diff', () => {
  it('reads several files with a/ and b/ prefixes, and without them', () => {
    expect(apply(TWO_FILES, { 'a.txt': 'one\ntwo\nthree\n', 'sub/b.txt': 'alpha\nbeta\n' })).toEqual([
      { path: 'a.txt', kind: 'modify', content: 'one\nTWO\nthree\n' },
      { path: 'sub/b.txt', kind: 'modify', content: 'alpha\ninserted\nbeta\n' },
    ])
    const bare = '--- notes.md\t2026-10-28 10:00:00\n+++ notes.md\t2026-10-28 10:01:00\n@@ -1 +1 @@\n-old\n+new\n'
    expect(apply(bare, { 'notes.md': 'old\n' })).toEqual([{ path: 'notes.md', kind: 'modify', content: 'new\n' }])
  })

  it('creates a file from /dev/null and deletes one to /dev/null', () => {
    const patch = '--- /dev/null\n+++ b/new/file.txt\n@@ -0,0 +1,2 @@\n+first\n+second\n--- a/gone.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n'
    expect(apply(patch, { 'gone.txt': 'x\ny\n' })).toEqual([
      { path: 'new/file.txt', kind: 'create', content: 'first\nsecond\n' },
      { path: 'gone.txt', kind: 'delete', content: '' },
    ])
  })

  it('keeps CRLF as found: the file\'s own lines, and an added line as the patch or the file ends it', () => {
    const patch = '--- a/w.txt\r\n+++ b/w.txt\r\n@@ -1,2 +1,3 @@\r\n one\r\n+added\r\n two\r\n'
    expect(apply(patch, { 'w.txt': 'one\r\ntwo\r\n' })[0]!.content).toBe('one\r\nadded\r\ntwo\r\n')
    expect(apply('--- a/w.txt\n+++ b/w.txt\n@@ -1 +1,2 @@\n one\n+lf in the patch\n', { 'w.txt': 'one\r\n' })[0]!.content).toBe('one\r\nlf in the patch\r\n')
  })

  it('reads \\ No newline at end of file on either side', () => {
    const add = '--- a/n.txt\n+++ b/n.txt\n@@ -1 +1,2 @@\n-last\n\\ No newline at end of file\n+last\n+more\n'
    expect(apply(add, { 'n.txt': 'last' })[0]!.content).toBe('last\nmore\n')
    const drop = '--- a/n.txt\n+++ b/n.txt\n@@ -1,2 +1,2 @@\n first\n-second\n+second\n\\ No newline at end of file\n'
    expect(apply(drop, { 'n.txt': 'first\nsecond\n' })[0]!.content).toBe('first\nsecond')
    expect(() => apply(add, { 'n.txt': 'last\n' })).toThrow('Hunk 1 of n.txt (@@ -1 +1,2 @@) does not match the file')
  })

  it('finds a hunk whose line numbers are off, its context exact, and refuses one whose context is not', () => {
    const patch = '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n c\n-d\n+D\n'
    expect(apply(patch, { 'f.txt': 'a\nb\nc\nd\n' })[0]!.content).toBe('a\nb\nc\nD\n')
    expect(() => apply(patch, { 'f.txt': 'a\nb\nc \nd\n' })).toThrow('Hunk 1 of f.txt (@@ -1,2 +1,2 @@) does not match the file')
  })

  it('reads a name git quoted', () => {
    const patch = '--- "a/caf\\303\\251 menu.txt"\n+++ "b/caf\\303\\251 menu.txt"\n@@ -1 +1 @@\n-x\n+y\n'
    expect(parseUnifiedDiff(patch)[0]!.path).toBe('café menu.txt')
  })

  it.each([
    ['a rename', 'diff --git a/x b/y\nsimilarity index 90%\nrename from x\nrename to y\n', 'renames or copies'],
    ['a binary change', 'diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n', 'binary change'],
    ['no diff at all', 'just some words\n', 'holds no unified diff'],
    ['a hunk whose counts are off', '--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n', 'other line counts than its header says'],
    ['two names on one file', '--- a/x\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n', 'renames x to y'],
  ])('refuses %s', (_name, patch, words) => {
    expect(() => parseUnifiedDiff(patch)).toThrow(words)
  })
})

describe('fs_apply_patch on a node', () => {
  it('applies a patch to several files where writes are granted, and its ask names them all and holds the whole diff', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'a.txt'), 'one\ntwo\nthree\n')
    mkdirSync(join(workspace, 'sub'))
    writeFileSync(join(workspace, 'sub/b.txt'), 'alpha\nbeta\n')
    await call(runtime, 'fs_read_batch', { paths: ['a.txt', 'sub/b.txt'] })
    expect(await call(runtime, 'fs_apply_patch', { patch: TWO_FILES })).toMatchObject({ outcome: 'ok', output: { files: [{ path: 'a.txt', change: 'modified' }, { path: 'sub/b.txt', change: 'modified' }] } })
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('one\nTWO\nthree\n')
    expect(readFileSync(join(workspace, 'sub/b.txt'), 'utf8')).toBe('alpha\ninserted\nbeta\n')
    expect(actionPhrase('fs_apply_patch')).toBe('apply a patch')
    const [checkpoint] = (await runtime.history.list()).filter(item => item.tool === 'fs_apply_patch')
    await runtime.history.restore(checkpoint!.id)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
  })

  it('shows the person every file and the whole diff where it asks', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'a.txt'), 'one\ntwo\nthree\n')
    mkdirSync(join(workspace, 'sub'))
    writeFileSync(join(workspace, 'sub/b.txt'), 'alpha\nbeta\n')
    const other = await runtime.invoke({ request: { requestId: 'ask-1', tool: 'fs_apply_patch', args: { patch: TWO_FILES }, approvalTokens: [] }, sessionId: 'nobody-granted' })
    expect(other.outcome).toBe('approval_required')
    const ask = runtime.approvalService.waiting().find(item => item.request.tool === 'fs_apply_patch')
    expect(ask?.call?.description).toBe(`Apply a patch to 2 files: "a.txt", "sub/b.txt" in ${JSON.stringify(runtime.paths().displayRoot)}`)
    expect(ask?.call?.arguments).toEqual({ patch: TWO_FILES })
    expect(ask?.call?.effects).toEqual([`read ${join(runtime.paths().root, 'a.txt')}`, `write ${join(runtime.paths().root, 'a.txt')}`, `read ${join(runtime.paths().root, 'sub/b.txt')}`, `write ${join(runtime.paths().root, 'sub/b.txt')}`])
  })

  it('writes nothing where one hunk of one file does not match, naming that file and hunk', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'a.txt'), 'one\ntwo\nthree\n')
    mkdirSync(join(workspace, 'sub'))
    writeFileSync(join(workspace, 'sub/b.txt'), 'alpha\nchanged meanwhile\n')
    const response = await call(runtime, 'fs_apply_patch', { patch: TWO_FILES })
    expect(errorOf(response)).toMatchObject({ code: 'PATCH_DOES_NOT_APPLY', message: 'Hunk 1 of sub/b.txt (@@ -1,2 +1,3 @@) does not match the file, so nothing was written' })
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
  })

  it('creates a file and its folders, and deletes one at the destructive floor', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'gone.txt'), 'x\n')
    const patch = '--- /dev/null\n+++ b/new/deep/file.txt\n@@ -0,0 +1 @@\n+made\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n'
    const asked = await call(runtime, 'fs_apply_patch', { patch }, { requestId: 'floor-1' })
    expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ subject: `delete:${runtime.paths().root}` }] })
    const tokens = asked.outcome === 'approval_required' ? asked.approvals.map(item => item.token) : []
    for (const token of tokens) await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, authority: 'admin' })
    expect(await call(runtime, 'fs_apply_patch', { patch }, { requestId: 'floor-1', tokens })).toMatchObject({ outcome: 'ok', output: { files: [{ change: 'created' }, { change: 'deleted' }] } })
    expect(readFileSync(join(workspace, 'new/deep/file.txt'), 'utf8')).toBe('made\n')
    expect(existsSync(join(workspace, 'gone.txt'))).toBe(false)
  })

  it('asks where a hunk cuts a file this session never read to under half', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'long.txt'), 'keep\nline two\nline three\nline four\n')
    const patch = '--- a/long.txt\n+++ b/long.txt\n@@ -1,4 +1,1 @@\n keep\n-line two\n-line three\n-line four\n'
    const response = await call(runtime, 'fs_apply_patch', { patch })
    expect(response.outcome === 'approval_required' ? response.approvals.map(item => item.reason) : []).toEqual([expect.stringContaining('shrinks a file this session never read')])
  })

  it('refuses a file it would leave over 10 MiB, and writes nothing', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'big.txt'), `${'x'.repeat(10 * 1_048_576 - 6)}\nlast\n`)
    await call(runtime, 'fs_read', { path: 'big.txt', limit: 1 })
    const response = await call(runtime, 'fs_apply_patch', { patch: '--- a/big.txt\n+++ b/big.txt\n@@ -2 +2,2 @@\n last\n+one more line\n' })
    expect(errorOf(response)?.message).toContain('more than the 10485760 a file may hold, so nothing was written')
    expect(readFileSync(join(workspace, 'big.txt'), 'utf8').endsWith('\nlast\n')).toBe(true)
  })
})
