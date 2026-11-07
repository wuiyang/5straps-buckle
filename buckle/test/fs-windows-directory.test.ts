import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import type { JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LinkAppearedError, openRealDirectory } from '../common/adapters/beneath.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'

// Load the adapter with its unpinned Windows walk while the rest of the test uses the host platform.
vi.mock('../common/adapters/beneath.js', async (importOriginal) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try { return await importOriginal<typeof import('../common/adapters/beneath.js')>() }
  finally { Object.defineProperty(process, 'platform', descriptor) }
})

const roots: string[] = []
const runtimes: CoreRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('unpinned directory walk', () => {
  it('continues to refuse a symbolic link as a directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-windows-link-'))
    roots.push(root)
    mkdirSync(join(root, 'folder'))
    symlinkSync(join(root, 'folder'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => openRealDirectory(join(root, 'link'))).toThrow(LinkAppearedError)
  })

  it.each([
    ['fs_list', { path: 'notes.txt' }, 'nothing was listed'],
    ['fs_find_names', { path: 'notes.txt', pattern: '*' }, 'nothing was searched'],
  ] as const)('%s refuses a file as the search folder', async (tool, args, outcome) => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-windows-folder-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'notes.txt'), 'notes')
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' })
    const runtime = await createRuntime({ config })
    runtimes.push(runtime)
    const response = await runtime.invoke({ request: { requestId: 'windows-folder', tool, args: args as JsonObject, approvalTokens: [] }, sessionId: 'agent' })
    expect(response).toMatchObject({ outcome: 'error', error: { code: 'SEARCH_ROOT_UNREADABLE', message: `notes.txt is a file, not a folder, so ${outcome}`, retryable: false } })
  })
})
