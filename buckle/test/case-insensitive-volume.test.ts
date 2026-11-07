import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy, WorkspacePolicySchema, type InvokeResponse, type JsonValue } from '@5straps/protocol'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { configFromEnvironment } from './support/workspace-config.js'
import { resolveTarget } from '../common/services/invocation/real-path.js'
import { byName, workspacesOf } from './support/workspaces.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { SOURCES } from '../common/types/ports/approval-source.js'

// Review H2 and M1 of the second proof-of-possession re-review, on an emulated macOS volume: the platform
// reads as darwin, and lstat and the C library's realpath find a path in any case and name it in the
// case the disk stores, as APFS does. Every other file operation keeps Linux's exact names, so a file
// opens only where Buckle judged it. Nothing here runs on macOS itself.

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  const { join: joinPath } = await import('node:path')
  /** Each existing component as the disk stores it, found in any case; null once a component is missing. */
  const onDisk = (path: string): string | null => {
    let current = '/'
    for (const part of path.split('/').filter(Boolean)) {
      const exact = joinPath(current, part)
      if (original.lstatSync(exact, { throwIfNoEntry: false })) { current = exact; continue }
      let entries: string[]
      try { entries = original.readdirSync(current) } catch { return null }
      const match = entries.find(entry => entry.toLowerCase() === part.toLowerCase())
      if (match === undefined) return null
      current = joinPath(current, match)
    }
    return current
  }
  const lstatSync = ((path: string, options?: object) => original.lstatSync(onDisk(String(path)) ?? path, options)) as typeof original.lstatSync
  const realpathSync = Object.assign((path: string, options?: object) => original.realpathSync(path, options as never), {
    native: (path: string, options?: object) => original.realpathSync.native(onDisk(String(path)) ?? path, options as never),
  }) as typeof original.realpathSync
  return { ...original, lstatSync, realpathSync, default: { ...original, lstatSync, realpathSync } }
})

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeAll(() => { Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' }) })
afterAll(() => { Object.defineProperty(process, 'platform', platform) })

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.history.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A workspace the disk stores as .../code/proj, holding secrets/, .git/hooks/, notes.txt and secret.txt. */
function volume() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-case-'))
  roots.push(root)
  const workspace = join(root, 'code', 'proj')
  mkdirSync(join(workspace, 'secrets'), { recursive: true })
  mkdirSync(join(workspace, '.git', 'hooks'), { recursive: true })
  writeFileSync(join(workspace, 'notes.txt'), 'notes')
  writeFileSync(join(workspace, 'secret.txt'), 'owner secret')
  return { root, workspace, state: join(root, 'state') }
}

async function runtimeFor(input: { root: string; typed: string; state: string; rules?: unknown[] }): Promise<BuckleRuntime> {
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: input.typed, BUCKLE_STATE_DIR: input.state, BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '1' })
  const runtime = await createRuntime({ config })
  runtimes.push(runtime)
  if (input.rules) await runtime.policy.apply(WorkspacePolicySchema.parse({ ...emptyWorkspacePolicy(), filesystem: { rules: input.rules } }))
  return runtime
}

function call(runtime: BuckleRuntime, tool: string, args: Record<string, JsonValue>): Promise<InvokeResponse> {
  return runtime.invoke({ request: { requestId: `case-${Math.random()}`, approvalTokens: [], tool, args }, sessionId: 'case-session', approvalWait: { mode: 'none' } })
}

describe('a new file under a case variant of an owner-denied directory (review H2)', () => {
  it('judges a missing file beneath the existing prefix as the disk names it', () => {
    const { workspace } = volume()
    expect(resolveTarget(join(workspace, 'SECRETS', 'new.json'))).toBe(join(workspace, 'secrets', 'new.json'))
    expect(resolveTarget(join(workspace, '.GIT', 'HOOKS', 'pre-commit'))).toBe(join(workspace, '.git', 'hooks', 'pre-commit'))
  })

  it.each([false, true])('refuses SECRETS/new.json and .GIT/hooks/pre-commit under secrets and .git denies (switch on: %s), and writes nothing', async (switchOn) => {
    const { root, workspace, state } = volume()
    const runtime = await runtimeFor({ root, typed: workspace, state, rules: [{ path: 'secrets', write: 'deny' }, { path: '.git', write: 'deny' }] })
    if (switchOn) await runtime.policy.setDangerouslyAllow(true)
    for (const path of ['SECRETS/new.json', 'Secrets/new.json', '.GIT/hooks/pre-commit', '.git/HOOKS/pre-commit']) {
      const result = await call(runtime, 'fs_write', { path, content: 'planted', createParents: true })
      expect({ path, result }).toMatchObject({ path, result: { outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Workspace policy denies write access') } } })
    }
    expect(readdirSync(join(workspace, 'secrets'))).toEqual([])
    expect(readdirSync(join(workspace, '.git', 'hooks'))).toEqual([])
  })
})

describe('a workspace root typed in another case than the disk\'s (review M1)', () => {
  it('names the configured root as the disk does, so in-root files stay in the root and an owner deny stays a deny', async () => {
    const { root, workspace, state } = volume()
    const typed = join(root, 'CODE', 'Proj')
    const runtime = await runtimeFor({ root, typed, state, rules: [{ path: 'secret.txt', read: 'deny' }] })
    expect(runtime.paths().root).toBe(workspace)
    expect(await call(runtime, 'fs_read', { path: 'notes.txt' })).toMatchObject({ outcome: 'ok', output: { content: 'notes' } })
    expect(await call(runtime, 'fs_list', { path: '.' })).toMatchObject({ outcome: 'ok', output: { entries: expect.arrayContaining([expect.objectContaining({ path: 'notes.txt' })]) } })
    const denied = await call(runtime, 'fs_read', { path: 'secret.txt' })
    expect(denied).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
    expect(JSON.stringify(denied)).not.toContain('owner secret')
  })

  it('registers a workspace typed in another case under the disk\'s name, and loads it', async () => {
    const { root, state } = volume()
    const other = join(root, 'code', 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'readme.md'), 'other')
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'code', 'proj'), BUCKLE_STATE_DIR: state, BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' })
    const manager = await workspacesOf(config)
    runtimes.push((await byName(manager, 'proj')).runtime)
    const { workspace: registered } = await manager.create({ id: 'other', name: 'Other', dir: join(root, 'Code', 'OTHER'), policy: emptyWorkspacePolicy() })
    expect(registered.dir).toBe(other)
    const opened = await byName(manager, 'other')
    runtimes.push(opened.runtime)
    expect(opened.config.cwd).toBe(other)
    expect(await call(opened.runtime, 'fs_read', { path: '/workspace/readme.md' })).toMatchObject({ outcome: 'ok', output: { content: 'other' } })
    expect(existsSync(join(root, 'Code'))).toBe(false)
  })
})

// GPT review of c71dee5 (conditional P2, case-insensitive denial): a remembered deny for a missing sensitive
// file was compared by exact spelling, so `.ENV` became a new ask, and the dangerously-allow switch allowed it.
describe('a remembered deny for a missing sensitive file, met by a case variant', () => {
  it.each([false, true])('refuses .ENV and .Env after the owner always-denied .env (switch on: %s), and writes nothing', async (switchOn) => {
    const { root, workspace, state } = volume()
    const runtime = await runtimeFor({ root, typed: workspace, state })
    const asked = await call(runtime, 'fs_write', { path: '.env', content: 'x' })
    if (asked.outcome !== 'approval_required') throw new Error(`expected an ask, got ${asked.outcome}`)
    const token = asked.approvals.find(approval => approval.rule === 'sensitive_path')!.token
    expect((await runtime.approvalService.answer({ decision: { token, approved: false, scope: 'always' }, source: SOURCES.cli })).ok).toBe(true)
    if (switchOn) await runtime.policy.setDangerouslyAllow(true)
    for (const path of ['.ENV', '.Env', '.env']) {
      const result = await call(runtime, 'fs_write', { path, content: 'planted' })
      expect({ path, result }).toMatchObject({ path, result: { outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('The owner denied this sensitive file') } } })
    }
    expect(readdirSync(workspace).filter(name => name.toLowerCase() === '.env')).toEqual([])
  })
})
