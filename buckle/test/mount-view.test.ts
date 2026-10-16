import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonValue } from '@5straps/protocol'
import { createBubblewrapSandbox } from '../common/adapters/sandbox/bubblewrap-sandbox.js'
import { createPathView, OUTSIDE_PATH } from '../common/domain/path-view.js'
import { createReadScopeRule } from '../common/domain/permission/rules/read-scope-rule.js'
import { createWriteScopeRule } from '../common/domain/permission/rules/write-scope-rule.js'
import { loadConfig } from '../common/runtime/config.js'
import { openChangeHistory } from '../common/services/history/journal.js'
import { createShellPack } from '../common/services/packs/shell/index.js'
import { withOwnerMounts } from '../common/services/workspaces/workspace-settings.js'
import type { ProcessRequest } from '../common/types/ports/process-runner.js'
import { byName, idOf, registerWorkspace, workspacesOf } from './support/workspaces.js'

// Phase 2 item 2 of the workspace-model brief: the file, git, code, and browser tools resolve every mount of the table;
// history and the execution lock cover the writable ones; shell isolation copies the folder alone and binds a writable
// mount read-only, saying so (Q6).

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-mount-view-')))
  roots.push(root)
  return root
}

const ROOT = '/work/project'
const DATA = '/home/me/data'
const DOCS = '/home/me/docs'
const SCRATCH = '/tmp/scratch'
const table = [
  { source: DATA, target: '/data', access: 'rw' as const },
  { source: DOCS, target: '/srv/docs', access: 'ro' as const },
  { source: SCRATCH, target: SCRATCH, access: 'rw' as const, scratch: true as const },
]

describe('a mounted view over the mount table', () => {
  const view = createPathView({ root: ROOT, mount: '/workspace', mounts: table })

  it('names the folder, each mount at its target, and each scratch root as it really is', () => {
    expect(view.displayRoots).toEqual(['/workspace', '/data', '/srv/docs', SCRATCH])
    expect(view.reachableRoots).toEqual([ROOT, DATA, DOCS, SCRATCH])
    expect(view.scratchRoots).toEqual([SCRATCH])
  })

  it('resolves a mount\'s target, and a real spelling inside its source, to the source', () => {
    expect(view.resolve('/data/a.txt')).toBe(`${DATA}/a.txt`)
    expect(view.resolve('/data')).toBe(DATA)
    expect(view.resolve('/srv/docs/guide/intro.md')).toBe(`${DOCS}/guide/intro.md`)
    expect(view.resolve(`${DATA}/b.txt`)).toBe(`${DATA}/b.txt`)
    expect(view.resolve('/data/../workspace/src/app.ts')).toBe(`${ROOT}/src/app.ts`)
  })

  it('refuses a climb out of a mount and a sibling of its target, naming no host path', () => {
    expect(() => view.resolve('/data/../../etc/passwd')).toThrow(/outside the mounted workspace/)
    expect(() => view.resolve('/datum/a.txt')).toThrow(/outside the mounted workspace/)
    expect(() => view.resolve('/srv/other')).toThrow(/Reachable: \/workspace, \/data, \/srv\/docs/)
    expect(() => view.resolve('/home/me')).toThrow(/outside the mounted workspace/)
  })

  it('shows a real path inside a mount by its target, never by its source', () => {
    expect(view.toVirtual(`${DATA}/a/b.txt`)).toBe('/data/a/b.txt')
    expect(view.toVirtual(DOCS)).toBe('/srv/docs')
    expect(view.display(`${DATA}/a.txt`)).toBe('/data/a.txt')
    expect(view.display('/home/me/elsewhere')).toBe(OUTSIDE_PATH)
    expect(view.toVirtual(`${SCRATCH}/x`)).toBe(`${SCRATCH}/x`)
  })

  it('tells which mount holds a real path, and which strings name the sandbox\'s own paths', () => {
    expect(view.mountOf(`${DOCS}/x`)).toMatchObject({ target: '/srv/docs', access: 'ro' })
    expect(view.mountOf(`${ROOT}/x`)).toBeNull()
    expect(view.namesVirtual('/data/a.png')).toBe(true)
    expect(view.namesVirtual('/workspace/a.png')).toBe(true)
    expect(view.namesVirtual('/database/a.png')).toBe(false)
  })
})

describe('a view showing the folder\'s real path', () => {
  it('reaches its scratch roots and leaves the owner\'s other mounts to the shell, as the explicit mounts were', () => {
    const view = createPathView({ root: ROOT, mount: null, mounts: table })
    expect(view.mounts.map(mount => mount.source)).toEqual([SCRATCH])
    expect(view.resolve('/data/a.txt')).toBe('/data/a.txt')
  })
})

describe('the scope rules over the mounts', () => {
  const view = createPathView({ root: ROOT, mount: '/workspace', mounts: table })
  const grants = { subjectsFor: () => [], patternsFor: () => [] }
  const read = createReadScopeRule({ paths: view })
  const write = createWriteScopeRule({ paths: view, strict: false })

  it('let a read inside any mount the owner shares through without asking', () => {
    for (const path of [`${DATA}/a.txt`, `${DOCS}/b.md`]) expect(read.evaluate({ tool: 'fs_read', effect: { kind: 'read_path', path, directory: path }, grants })).toEqual({ kind: 'allow' })
  })

  it('refuse a write into a read-only mount, naming it by its target, and ask for one into a writable mount as the workspace does', () => {
    const refused = write.evaluate({ tool: 'fs_write', effect: { kind: 'write_path', path: `${DOCS}/b.md`, directory: DOCS }, grants })
    expect(refused).toMatchObject({ kind: 'deny', reason: '/srv/docs/b.md is in a mount the owner shares read-only, which is a boundary rather than a question: it is refused, not asked' })
    expect(JSON.stringify(refused)).not.toContain('/home/me/docs/b.md is')
    const asked = write.evaluate({ tool: 'fs_write', effect: { kind: 'write_path', path: `${DATA}/a.txt`, directory: DATA }, grants })
    expect(asked).toMatchObject({ kind: 'ask', reason: 'Writing to /data is not yet approved. Writable without asking: /tmp/scratch' })
  })
})

describe('a workspace\'s tools over its mounts', () => {
  async function mountedWorkspace() {
    const root = scratch()
    for (const directory of ['site', 'data', 'docs']) mkdirSync(join(root, directory))
    writeFileSync(join(root, 'data', 'a.txt'), 'shared data')
    writeFileSync(join(root, 'docs', 'guide.md'), 'read only')
    const manager = await workspacesOf(loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_PACKS: 'fs' }))
    await registerWorkspace(manager, { id: 'site', dir: join(root, 'site') })
    await manager.updateSettings(idOf(manager, 'site'), settings => withOwnerMounts(settings, [{ source: join(root, 'data'), target: '/data', access: 'rw' }, { source: join(root, 'docs'), target: '/docs', access: 'ro' }], '/workspace'))
    const { runtime } = await byName(manager, 'site')
    const call = (tool: string, args: Record<string, JsonValue>) => runtime.invoke({ request: { requestId: `${tool}-${Math.random()}`, tool, args, approvalTokens: [] }, sessionId: 'site' })
    return { root, manager, runtime, call }
  }

  it('read a mount by its target, list it, and name it in the manifest', async () => {
    const { manager, runtime, call } = await mountedWorkspace()
    expect(await call('fs_read', { path: '/data/a.txt' })).toMatchObject({ outcome: 'ok', output: { path: '/data/a.txt', content: 'shared data' } })
    expect(await call('fs_list', { path: '/docs' })).toMatchObject({ outcome: 'ok', output: { path: '/docs' } })
    expect(runtime.manifest().workspaceRoots).toEqual(['/workspace', '/data', '/docs'])
    await manager.close()
  })

  it('refuse a write into the read-only mount, and checkpoint a write into the writable one', async () => {
    const { root, manager, runtime, call } = await mountedWorkspace()
    expect(await call('fs_write', { path: '/docs/guide.md', content: 'changed' })).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: '/docs/guide.md is in a mount the owner shares read-only, which is a boundary rather than a question: it is refused, not asked' } })
    expect(readFileSync(join(root, 'docs', 'guide.md'), 'utf8')).toBe('read only')
    expect(await call('fs_write', { path: '/data/b.txt', content: 'written' })).toMatchObject({ outcome: 'approval_required', approvals: [{ rule: 'write_scope', reason: 'Writing to /data is not yet approved' }] })
    // The owner approves writes in the mount for good, as an approval of the ask records it.
    await runtime.grants.grant({ sessionId: 'site', rule: 'write_scope', subject: join(root, 'data'), scope: 'always' })
    expect(await call('fs_write', { path: '/data/b.txt', content: 'written' })).toMatchObject({ outcome: 'ok', output: { path: '/data/b.txt' } })
    expect(readFileSync(join(root, 'data', 'b.txt'), 'utf8')).toBe('written')
    const [checkpoint] = await runtime.history.list()
    expect(checkpoint!.paths).toEqual([join(root, 'data', 'b.txt')])
    await runtime.history.restore(checkpoint!.id)
    expect(() => readFileSync(join(root, 'data', 'b.txt'))).toThrow()
    await manager.close()
  })
})

describe('the shell under isolation', () => {
  it('binds a writable mount read-only, as it copies the folder alone, and its result says so', async () => {
    const root = scratch()
    const sourceRoot = join(root, 'source')
    mkdirSync(sourceRoot)
    const state = join(root, 'state')
    const history = await openChangeHistory({ directory: join(state, 'history'), excluded: [state], maxBytes: 1_000_000, retentionDays: 30 })
    const data = join(root, 'data')
    mkdirSync(data)
    const calls: ProcessRequest[] = []
    const pack = createShellPack({
      paths: createPathView({ root: sourceRoot, mount: '/workspace' }), isolation: { directory: join(state, 'shell'), maxBytes: 1_000_000, history },
      sandbox: createBubblewrapSandbox('/usr/bin/bwrap'), writableRoots: [sourceRoot], hiddenPaths: [state], readOnlyPaths: [], unavailableReason: null,
      mounts: [{ source: data, target: '/data', readOnly: false }],
      runProcess: async (request) => { calls.push(request); return { exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false } },
    })
    const output = await pack.tools[0]!.prepare({ command: 'true' }).execute({ requestId: 'isolated', sessionId: 'caller', stageId: 'message', timeoutMs: 1000, signal: new AbortController().signal })
    const args = calls[0]!.args
    const bound = args.indexOf(data)
    expect(args.slice(bound - 1, bound + 2)).toEqual(['--ro-bind', data, '/data'])
    expect(output).toMatchObject({ readOnlyMounts: ['/data'], note: expect.stringContaining('read-only to this command: /data') })
    await history.close()
  })

  /** An isolated shell whose node names a scratch root outside the folder, and the arguments its one call ran. */
  async function isolatedBeside(input: { scratchRoot: string; hidden: string[] }) {
    const root = scratch()
    const sourceRoot = join(root, 'source')
    mkdirSync(sourceRoot)
    const state = join(root, 'state')
    const history = await openChangeHistory({ directory: join(state, 'history'), excluded: [state], maxBytes: 1_000_000, retentionDays: 30 })
    const calls: ProcessRequest[] = []
    const pack = createShellPack({
      paths: createPathView({ root: sourceRoot, mount: '/workspace', scratchRoots: [input.scratchRoot] }), isolation: { directory: join(state, 'shell'), maxBytes: 1_000_000, history },
      sandbox: createBubblewrapSandbox('/usr/bin/bwrap'), writableRoots: [sourceRoot, input.scratchRoot], hiddenPaths: [state, ...input.hidden], readOnlyPaths: [], unavailableReason: null,
      runProcess: async (request) => { calls.push(request); return { exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false } },
    })
    try {
      const output = await pack.tools[0]!.prepare({ command: 'cat', args: ['.env'] }).execute({ requestId: 'isolated', sessionId: 'caller', stageId: 'message', timeoutMs: 1000, signal: new AbortController().signal })
      return { output, args: calls[0]?.args ?? [] }
    } finally { await history.close() }
  }

  it('masks the credential files of a scratch root outside the folder, which it binds read-only', async () => {
    const outside = join(scratch(), 'scratch')
    mkdirSync(join(outside, '.ssh'), { recursive: true })
    writeFileSync(join(outside, '.env'), 'SCRATCH_SECRET=hunter2')
    writeFileSync(join(outside, '.ssh', 'id_ed25519'), 'PRIVATE KEY')
    const { output, args } = await isolatedBeside({ scratchRoot: outside, hidden: [] })
    const bound = args.findIndex((argument, index) => argument === '--ro-bind' && args[index + 1] === outside && args[index + 2] === outside)
    expect(bound).toBeGreaterThan(-1)
    for (const file of ['.env', '.ssh/id_ed25519']) {
      const mask = args.findIndex((argument, index) => argument === '--ro-bind' && args[index + 1] === '/dev/null' && args[index + 2] === join(outside, file))
      expect(mask).toBeGreaterThan(bound)
    }
    expect(output).toMatchObject({ readOnlyMounts: [outside] })
  })

  it('refuses a scratch root outside the folder that holds Buckle\'s state, or sits inside it, and runs nothing', async () => {
    const home = join(scratch(), 'home')
    const state = join(home, '.5straps', 'buckle')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'buckle.env'), 'BUCKLE_ADMIN_TOKEN=admin-secret')
    for (const scratchRoot of [home, state]) {
      await expect(isolatedBeside({ scratchRoot, hidden: [join(home, '.5straps')] })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: `The mount at ${scratchRoot} overlaps the workspace's folder or Buckle's protected state, so Buckle binds nothing there; the owner narrows it` })
    }
  })

  it('binds a writable mount writable where the shell shares the folder', async () => {
    const root = scratch()
    const calls: ProcessRequest[] = []
    const pack = createShellPack({
      paths: createPathView({ root, mount: '/workspace' }), sandbox: createBubblewrapSandbox('/usr/bin/bwrap'), writableRoots: [root], hiddenPaths: [], readOnlyPaths: [], unavailableReason: null,
      mounts: [{ source: '/srv', target: '/data', readOnly: false }],
      runProcess: async (request) => { calls.push(request); return { exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false } },
    })
    const output = await pack.tools[0]!.prepare({ command: 'true' }).execute({ requestId: 'shared', sessionId: 'caller', timeoutMs: 1000, signal: new AbortController().signal })
    const args = calls[0]!.args
    expect(args.slice(args.indexOf('/srv') - 1, args.indexOf('/srv') + 2)).toEqual(['--bind', '/srv', '/data'])
    expect(output).not.toHaveProperty('note')
  })
})

// Finding 41 of the third re-check: git status and git diff refresh .git/index (and take index.lock) whatever the
// read-only bind says, as the git pack runs host git; in a mount the owner shares read-only they now write nothing.
describe.runIf(spawnSync('git', ['--version']).status === 0)('the git tools in a mount the owner shares read-only', () => {
  it('answer git_status and git_diff, and leave the repository\'s index as it was, bytes and time', async () => {
    const root = scratch()
    const docs = join(root, 'docs')
    mkdirSync(docs)
    mkdirSync(join(root, 'site'))
    const git = (...args: string[]) => execFileSync('git', ['-C', docs, '-c', 'user.name=t', '-c', 'user.email=t@e.com', ...args], { encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(docs, 'a.txt'), 'shared\n')
    git('add', 'a.txt')
    git('commit', '-q', '-m', 'first')
    // The file's time moves, its content does not: a refresh would rewrite the index's stat for it.
    utimesSync(join(docs, 'a.txt'), new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'))
    const index = join(docs, '.git', 'index')
    const before = { bytes: readFileSync(index), mtime: statSync(index).mtimeMs }
    const manager = await workspacesOf(loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_PACKS: 'fs,git', BUCKLE_ALLOW_HOST_GIT: 'true' }))
    await registerWorkspace(manager, { id: 'site', dir: join(root, 'site') })
    await manager.updateSettings(idOf(manager, 'site'), settings => withOwnerMounts(settings, [{ source: docs, target: '/docs', access: 'ro' }], '/workspace'))
    const { runtime } = await byName(manager, 'site')
    const call = (tool: string) => runtime.invoke({ request: { requestId: `${tool}-${Math.random()}`, tool, args: { repo: '/docs' }, approvalTokens: [] }, sessionId: 'site' })
    expect(await call('git_status')).toMatchObject({ outcome: 'ok', output: { entries: [] } })
    expect(await call('git_diff')).toMatchObject({ outcome: 'ok', output: { diff: '' } })
    expect(readFileSync(index).equals(before.bytes)).toBe(true)
    expect(statSync(index).mtimeMs).toBe(before.mtime)
    expect(existsSync(join(docs, '.git', 'index.lock'))).toBe(false)
    // The private copy is gone once each call ends.
    const copies = join(root, 'state', 'workspaces', idOf(manager, 'site'), 'git-index')
    expect(existsSync(copies) ? readdirSync(copies) : []).toEqual([])
    await manager.close()
  }, 30_000)
})
