import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessManifestSchema, type InvokeResponse, type JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { SOURCES } from '../common/types/ports/approval-source.js'

// Slice F2, item 1: a file tool's checkpoint records only the paths its effects name, before the call and after it. No
// walk of the workspace and no git: host git is off here, and the folder holds what a walk would trip on (a FIFO, a hard
// link outside node_modules, a dependency tree), yet every write is recorded and restored.

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { runtime.closeWatchers(); await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function node(): Promise<{ workspace: string; runtime: BuckleRuntime }> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-scoped-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, 'node_modules', 'pkg'), { recursive: true })
  for (let index = 0; index < 50; index++) writeFileSync(join(workspace, 'node_modules', 'pkg', `file-${index}.js`), `module.exports = ${index}\n`)
  writeFileSync(join(workspace, 'shared.txt'), 'linked')
  linkSync(join(workspace, 'shared.txt'), join(workspace, 'shared-link.txt'))
  if (process.platform !== 'win32') execFileSync('mkfifo', [join(workspace, 'pipe')])
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_ALLOW_HOST_GIT: 'false', BUCKLE_PACKS: 'fs,history', BUCKLE_APPROVAL_TIMEOUT_MS: '1', BUCKLE_DELETE_IN_WORKSPACE: 'allow' })
  const runtime = await createRuntime({ config })
  runtimes.push(runtime)
  await runtime.grants.grant({ sessionId: 'agent', rule: 'write_scope', subject: runtime.paths().root, scope: 'session' })
  return { workspace, runtime }
}

function call(runtime: BuckleRuntime, requestId: string, tool: string, args: JsonObject): Promise<InvokeResponse> {
  return runtime.invoke({ request: { requestId, tool, args, approvalTokens: [] }, sessionId: 'agent' })
}

async function newest(runtime: BuckleRuntime) { return (await runtime.history.list()).at(-1)! }

describe('a file tool\'s checkpoint', () => {
  it('records only the file an fs_write writes, and restores it without host git or a walk of the workspace', async () => {
    const { workspace, runtime } = await node()
    expect(await call(runtime, 'w-1', 'fs_write', { path: 'a.txt', content: 'one' })).toMatchObject({ outcome: 'ok' })
    expect(await newest(runtime)).toMatchObject({ tool: 'fs_write', restorable: true, status: 'complete', changes: [{ path: join(workspace, 'a.txt'), kind: 'created' }], notRestorable: [] })
    expect(await call(runtime, 'w-2', 'fs_write', { path: 'a.txt', content: 'two' })).toMatchObject({ outcome: 'ok', meta: expect.not.objectContaining({ history: expect.anything() }) })
    expect(await newest(runtime)).toMatchObject({ restorable: true, changes: [{ path: join(workspace, 'a.txt'), kind: 'modified' }] })
    await runtime.history.restore((await newest(runtime)).id)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('one')
    expect(runtime.history.capability()).toMatchObject({ engine: 'hashes' })
    // M4: the manifest says a file tool's checkpoints restore without host git, beside the command engine's own fields.
    expect(HarnessManifestSchema.parse(runtime.manifest()).history).toMatchObject({ engine: 'hashes', restorable: false, fileToolsRestorable: true })
  })

  it('records a path .gitignore ignores, and the folders a write makes for it', async () => {
    const { workspace, runtime } = await node()
    writeFileSync(join(workspace, '.gitignore'), 'secret/\n*.log\n')
    expect(await call(runtime, 'w-1', 'fs_write', { path: 'secret/deep/run.log', content: 'token-free log', createParents: true })).toMatchObject({ outcome: 'ok' })
    const checkpoint = await newest(runtime)
    expect(checkpoint).toMatchObject({ restorable: true, notRestorable: [] })
    expect(checkpoint.changes).toEqual([
      { path: join(workspace, 'secret'), kind: 'created' },
      { path: join(workspace, 'secret', 'deep'), kind: 'created' },
      { path: join(workspace, 'secret', 'deep', 'run.log'), kind: 'created' },
    ])
    await runtime.history.restore(checkpoint.id)
    expect(existsSync(join(workspace, 'secret'))).toBe(false)
  })

  it('records the files under a folder an fs_delete removes, and puts them back with their modes', async () => {
    const { workspace, runtime } = await node()
    mkdirSync(join(workspace, 'src', 'old', 'inner'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'old', 'one.txt'), 'one')
    writeFileSync(join(workspace, 'src', 'old', 'inner', 'run.sh'), '#!/bin/sh\n')
    chmodSync(join(workspace, 'src', 'old', 'inner', 'run.sh'), 0o755)
    expect(await call(runtime, 'd-1', 'fs_delete', { paths: ['src/old'], recursive: true })).toMatchObject({ outcome: 'ok' })
    expect(existsSync(join(workspace, 'src', 'old'))).toBe(false)
    const checkpoint = await newest(runtime)
    expect(checkpoint).toMatchObject({ tool: 'fs_delete', restorable: true })
    expect(checkpoint.changes.map(change => [change.path, change.kind])).toEqual([
      [join(workspace, 'src', 'old'), 'deleted'], [join(workspace, 'src', 'old', 'inner'), 'deleted'], [join(workspace, 'src', 'old', 'inner', 'run.sh'), 'deleted'], [join(workspace, 'src', 'old', 'one.txt'), 'deleted'],
    ])
    await runtime.history.restore(checkpoint.id)
    expect(readFileSync(join(workspace, 'src', 'old', 'one.txt'), 'utf8')).toBe('one')
    if (process.platform !== 'win32') expect(statSync(join(workspace, 'src', 'old', 'inner', 'run.sh')).mode & 0o777).toBe(0o755)
  })

  it('records a folder an fs_move moves at both ends, and moves it back', async () => {
    const { workspace, runtime } = await node()
    mkdirSync(join(workspace, 'from'))
    writeFileSync(join(workspace, 'from', 'x.txt'), 'x')
    const moved = await call(runtime, 'm-1', 'fs_move', { from: 'from', to: 'to' })
    const tokens = moved.outcome === 'approval_required' ? moved.approvals.map(approval => approval.token) : []
    for (const token of tokens) expect((await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, source: SOURCES.cli })).ok).toBe(true)
    if (tokens.length) expect(await runtime.invoke({ request: { requestId: 'm-1', tool: 'fs_move', args: { from: 'from', to: 'to' }, approvalTokens: tokens }, sessionId: 'agent' })).toMatchObject({ outcome: 'ok' })
    else expect(moved).toMatchObject({ outcome: 'ok' })
    expect(readFileSync(join(workspace, 'to', 'x.txt'), 'utf8')).toBe('x')
    const checkpoint = await newest(runtime)
    expect(checkpoint.changes.map(change => [change.path, change.kind])).toEqual([
      [join(workspace, 'from'), 'deleted'], [join(workspace, 'from', 'x.txt'), 'deleted'], [join(workspace, 'to'), 'created'], [join(workspace, 'to', 'x.txt'), 'created'],
    ])
    await runtime.history.restore(checkpoint.id)
    expect(readFileSync(join(workspace, 'from', 'x.txt'), 'utf8')).toBe('x')
    expect(existsSync(join(workspace, 'to'))).toBe(false)
  })

  it('records a file over the content cap without content and never refuses the write', async () => {
    const { workspace, runtime } = await node()
    runtime.history.configure({ maxFileBytes: 4 })
    writeFileSync(join(workspace, 'big.txt'), 'larger than four bytes')
    const written = await call(runtime, 'w-1', 'fs_write', { path: 'big.txt', content: 'still much larger than four bytes' })
    expect(written).toMatchObject({ outcome: 'ok', meta: { history: { restorable: true, notRestorableCount: 1 } } })
    expect(await newest(runtime)).toMatchObject({ changes: [], notRestorable: [join(workspace, 'big.txt')] })
    expect(readFileSync(join(workspace, 'big.txt'), 'utf8')).toBe('still much larger than four bytes')
  })

  it('keeps one checkpoint per call of fs_write_batch, naming each file', async () => {
    const { workspace, runtime } = await node()
    expect(await call(runtime, 'b-1', 'fs_write_batch', { files: [{ path: 'one.txt', content: '1' }, { path: 'two.txt', content: '2' }] })).toMatchObject({ outcome: 'ok' })
    expect((await newest(runtime)).changes).toEqual([{ path: join(workspace, 'one.txt'), kind: 'created' }, { path: join(workspace, 'two.txt'), kind: 'created' }])
    expect(await runtime.history.list()).toHaveLength(1)
  })
})

// M6 (coordinator, review of 670f1dc2..01d3b0c9): a file over the content cap is compared by its size, mode, and mtime,
// so a same-size rewrite of one is listed as not restorable, from a file tool's checkpoint and from a command's.
describe('a file over the content cap rewritten at the same size', () => {
  for (const kind of ['file tool', 'command'] as const) it(`is listed as not restorable from a ${kind}'s checkpoint`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-scoped-cap-')); roots.push(root)
    const workspace = join(root, 'workspace'); mkdirSync(workspace)
    const big = join(workspace, 'big.bin'); writeFileSync(big, Buffer.alloc(100, 1)); utimesSync(big, 1_000, 1_000)
    const { openChangeHistory } = await import('../common/services/history/journal.js')
    const history = await openChangeHistory({ directory: join(root, 'history'), excluded: [], maxBytes: 1_000_000, maxFileBytes: 64 })
    try {
      await history.run({ sessionId: 's', stageId: 'one', tool: kind === 'file tool' ? 'fs_write' : 'shell_exec', roots: [workspace], ...(kind === 'file tool' ? { scope: [{ path: big }] } : {}) }, async () => { writeFileSync(big, Buffer.alloc(100, 2)); utimesSync(big, 2_000, 2_000) })
      expect((await history.list()).at(-1)).toMatchObject({ status: 'complete', notRestorable: [big], changes: [] })
    } finally { await history.close() }
  })
})
