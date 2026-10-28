import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse, JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'

// A path a file tool is sent that stands on nothing answers FILE_NOT_FOUND (a missing folder for a write, PARENT_MISSING),
// in the words the agent sent, as fs_move and fs_search_content did. It once answered "Tool invocation failed", and only
// the node's log said why (the 0.1.8 publish test, B1).

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function node(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-missing-path-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'notes.txt'), 'notes\n')
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '1', ...extra })
  const runtime = await createRuntime({ config })
  runtimes.push(runtime)
  await runtime.grants.grant({ sessionId: 'agent', rule: 'write_scope', subject: runtime.paths().root, scope: 'session' })
  return { root, workspace, runtime }
}

let sequence = 0
function call(runtime: BuckleRuntime, tool: string, args: JsonObject): Promise<InvokeResponse> {
  return runtime.invoke({ request: { requestId: `missing-${++sequence}`, tool, args, approvalTokens: [] }, sessionId: 'agent' })
}

const errorOf = (response: InvokeResponse) => (response.outcome === 'error' ? response.error : null)

/** What an agent reads must name nothing of the host: not the folder the workspace is, and not the descriptor path a pinned open went through. */
function expectNoHostPath(message: string, hostFolders: string[]): void {
  expect(message).not.toContain('/proc/self/fd')
  expect(message).not.toMatch(/ENOENT|ENOTDIR/)
  for (const folder of hostFolders) expect(message).not.toContain(folder)
}

describe('a path that stands on nothing', () => {
  it.each([
    ['fs_read', { path: 'nope.txt' }, 'nope.txt', 'There is no file at nope.txt, so nothing was read'],
    ['fs_read', { path: 'gone/nope.txt' }, 'gone/nope.txt', 'There is no file at gone/nope.txt, so nothing was read'],
    ['fs_read_batch', { paths: ['notes.txt', 'gone/nope.txt'] }, 'gone/nope.txt', 'There is no file at gone/nope.txt, so nothing was read'],
    ['fs_list', { path: 'gone' }, 'gone', 'There is no folder at gone, so nothing was listed'],
    ['fs_find_names', { path: 'gone', pattern: '*' }, 'gone', 'There is no folder at gone, so nothing was searched'],
    ['fs_patch', { path: 'nope.txt', edits: [{ oldText: 'a', newText: 'b' }] }, 'nope.txt', 'There is no file at nope.txt, so nothing was patched'],
    ['fs_patch', { path: 'gone/nope.txt', edits: [{ oldText: 'a', newText: 'b' }] }, 'gone/nope.txt', 'There is no file at gone/nope.txt, so nothing was patched'],
  ] as const)('%s %j answers FILE_NOT_FOUND naming %s', async (tool, args, named, message) => {
    const { runtime, workspace, root } = await node()
    const error = errorOf(await call(runtime, tool, args as JsonObject))
    expect(error).toEqual({ code: 'FILE_NOT_FOUND', message, retryable: false })
    expect(error?.message).toContain(named)
    expectNoHostPath(error?.message ?? '', [workspace, root])
  })

  it('answers FILE_NOT_FOUND for a path that goes through a file, in the words that were sent', async () => {
    const { runtime, workspace, root } = await node()
    for (const [tool, args] of [['fs_read', { path: 'notes.txt/inner.txt' }], ['fs_patch', { path: 'notes.txt/inner.txt', edits: [{ oldText: 'a', newText: 'b' }] }]] as const) {
      const error = errorOf(await call(runtime, tool, args as JsonObject))
      expect(error).toMatchObject({ code: 'FILE_NOT_FOUND', retryable: false })
      expect(error?.message).toContain('notes.txt/inner.txt')
      expectNoHostPath(error?.message ?? '', [workspace, root])
    }
  })

  it.each([
    ['fs_list', { path: 'notes.txt' }, 'nothing was listed'],
    ['fs_find_names', { path: 'notes.txt', pattern: '*' }, 'nothing was searched'],
  ] as const)('answers %s for a file named as the folder in the code and words fs_search_content uses, not as a path that is missing', async (tool, args, outcome) => {
    const { runtime, workspace, root } = await node()
    const error = errorOf(await call(runtime, tool, args as JsonObject))
    expect(error).toEqual({ code: 'SEARCH_ROOT_UNREADABLE', message: `notes.txt is a file, not a folder, so ${outcome}`, retryable: false })
    expectNoHostPath(error?.message ?? '', [workspace, root])
  })

  it('names the file as the agent sent it where the workspace is mounted, when it is named as the folder', async () => {
    const { runtime, workspace, root } = await node({ BUCKLE_WORKSPACE_MOUNT: '/workspace' })
    const error = errorOf(await call(runtime, 'fs_list', { path: '/workspace/notes.txt' }))
    expect(error).toEqual({ code: 'SEARCH_ROOT_UNREADABLE', message: '/workspace/notes.txt is a file, not a folder, so nothing was listed', retryable: false })
    expectNoHostPath(error?.message ?? '', [workspace, root])
  })

  it('keeps a part of the path that is a file, above the folder named, as a path that goes through a file', async () => {
    const { runtime } = await node()
    for (const [tool, args] of [['fs_list', { path: 'notes.txt/inner' }], ['fs_find_names', { path: 'notes.txt/inner', pattern: '*' }]] as const) {
      const error = errorOf(await call(runtime, tool, args as JsonObject))
      expect(error).toMatchObject({ code: 'FILE_NOT_FOUND', retryable: false })
      expect(error?.message).toContain('A part of the path notes.txt/inner is a file')
    }
  })

  it('answers an fs_write into a folder that does not exist PARENT_MISSING, and writes nothing', async () => {
    const { runtime, workspace, root } = await node()
    const error = errorOf(await call(runtime, 'fs_write', { path: 'gone/deeper/new.txt', content: 'x' }))
    expect(error).toEqual({ code: 'PARENT_MISSING', message: 'The folder gone/deeper does not exist, and a write makes no folder unless createParents is true: create it first, or send createParents: true', retryable: false })
    expectNoHostPath(error?.message ?? '', [workspace, root])
  })

  it('answers an fs_write under a file PARENT_MISSING, in the words that were sent', async () => {
    const { runtime, workspace, root } = await node()
    const error = errorOf(await call(runtime, 'fs_write', { path: 'notes.txt/inner.txt', content: 'x' }))
    expect(error).toMatchObject({ code: 'PARENT_MISSING', retryable: false })
    expect(error?.message).toContain('notes.txt/inner.txt')
    expectNoHostPath(error?.message ?? '', [workspace, root])
  })

  it('answers each file of an fs_write_batch whose folder is missing the same way', async () => {
    const { runtime } = await node()
    const error = errorOf(await call(runtime, 'fs_write_batch', { files: [{ path: 'gone/a.txt', content: 'x' }] }))
    expect(error).toMatchObject({ code: 'PARENT_MISSING' })
    expect(error?.message).toContain('gone')
  })

  it('still creates the folders when createParents is sent', async () => {
    const { runtime } = await node()
    expect(await call(runtime, 'fs_write', { path: 'gone/deeper/new.txt', content: 'x', createParents: true })).toMatchObject({ outcome: 'ok' })
  })

  it('names the path the agent sent where the workspace is mounted, and nothing of the host folder', async () => {
    const { runtime, workspace, root } = await node({ BUCKLE_WORKSPACE_MOUNT: '/workspace' })
    for (const [tool, args, named] of [
      ['fs_read', { path: '/workspace/gone/nope.txt' }, '/workspace/gone/nope.txt'],
      ['fs_list', { path: '/workspace/gone' }, '/workspace/gone'],
      ['fs_patch', { path: '/workspace/nope.txt', edits: [{ oldText: 'a', newText: 'b' }] }, '/workspace/nope.txt'],
      ['fs_write', { path: '/workspace/gone/new.txt', content: 'x' }, '/workspace/gone'],
    ] as const) {
      const error = errorOf(await call(runtime, tool, args as JsonObject))
      expect(error?.code).toMatch(/^(FILE_NOT_FOUND|PARENT_MISSING)$/)
      expect(error?.message).toContain(named)
      expectNoHostPath(error?.message ?? '', [workspace, root])
    }
  })

  it('records the code in the audit entry, and no host path', async () => {
    const { runtime, workspace, root } = await node()
    await call(runtime, 'fs_read', { path: 'gone/nope.txt' })
    const entries = runtime.actions.read(10).filter(entry => entry.event === 'result' && entry.tool === 'fs_read')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ outcome: 'error', detail: 'FILE_NOT_FOUND' })
    const text = JSON.stringify(entries)
    expect(text).not.toContain('/proc/self/fd')
    expect(text).not.toContain(workspace)
    expect(text).not.toContain(root)
  })
})
