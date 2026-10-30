import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy, type InvokeResponse, type JsonObject, type PermissionRuleId } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILT_IN_DELETE_POLICY, newDeleteRun, recordRemovals, type DeletePolicy, type DeleteRunView } from '../common/domain/delete-policy.js'
import type { ResolvedEffect, TreeCount } from '../common/domain/effect.js'
import { createFilesystemPolicyRule } from '../common/domain/filesystem-policy.js'
import type { GrantLookup } from '../common/domain/permission/decision.js'
import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { withDangerouslyAllow } from '../common/domain/permission/rules/dangerously-allow.js'
import { createDestructivePathRule } from '../common/domain/permission/rules/destructive-path-rule.js'
import { createSensitivePathRule } from '../common/domain/permission/rules/sensitive-path-rule.js'
import { createWriteScopeRule } from '../common/domain/permission/rules/write-scope-rule.js'
import { createPathView, type PathView } from '../common/domain/path-view.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The delete policy brief, items 1 and 2 (the owner's ruling of 2026-10-28): under files.deleteInWorkspace allow, the
// default, a delete inside the workspace's own folder runs under the ordinary write gate, as removing old code is part of
// a coding task; one call that deletes more than files.massDeleteLimit entries (100), or a folder at the top of the
// folder, still asks at the floor. Under ask, the floor stands, as delete-floor.test.ts pins.

const WORKSPACE = '/work/project'
const STATE = '/work/project/.state'
const SCRATCH = '/scratch'

function lookup(granted: Partial<Record<PermissionRuleId, string[]>> = {}): GrantLookup {
  return { subjectsFor: rule => granted[rule] ?? [] }
}

function engine(input: { deletes?: DeletePolicy; rules?: Array<{ path: string; write?: 'deny' | 'ask' }>; paths?: PathView } = {}) {
  const paths = input.paths ?? createPathView({ root: WORKSPACE, mount: null, scratchRoots: [SCRATCH] })
  const deletes = input.deletes ?? BUILT_IN_DELETE_POLICY
  return createPermissionEngine([
    createSensitivePathRule({ protectedRoots: [STATE] }),
    createDestructivePathRule({ paths, strict: false, deletes }),
    createFilesystemPolicyRule({ root: WORKSPACE, policy: { ...emptyWorkspacePolicy(), filesystem: { rules: input.rules ?? [] } } }),
    createWriteScopeRule({ paths, strict: false, deletes }),
  ])
}

const counted = (files: number, folders: number, more = false): TreeCount => ({ counted: true, files, folders, more })
const removed = (path: string, input: { floor?: boolean; tree?: TreeCount; moved?: true } = {}): ResolvedEffect => ({ kind: 'delete_path', path, directory: path.slice(0, path.lastIndexOf('/')) || '/', floor: input.floor ?? true, ...(input.tree ? { tree: input.tree } : {}), ...(input.moved ? { moved: true as const } : {}) })
const files = (count: number, folder = `${WORKSPACE}/src`) => Array.from({ length: count }, (_, index) => removed(`${folder}/file-${index}.ts`))
// A call carries 100 paths at most, so what takes one past the limit is folders removed whole: a folder of `entries` is itself and what it holds.
const folder = (name: string, entries: number) => removed(`${WORKSPACE}/src/${name}`, { tree: counted(entries - 1, 0) })
const folders = (count: number, entries: number) => Array.from({ length: count }, (_, index) => folder(`dir-${index}`, entries))

function evaluate(effects: ResolvedEffect[], granted?: Partial<Record<PermissionRuleId, string[]>>, input?: Parameters<typeof engine>[0]) {
  return engine(input).evaluate({ tool: 'fs_delete', effects, grants: lookup(granted) })
}
const subjects = (outcome: ReturnType<typeof evaluate>) => (outcome.kind === 'ask' ? outcome.asks.map(item => item.subject) : [])

describe('a delete inside the workspace\'s folder under allow', () => {
  it('runs where the folder\'s writes are granted, relying on that grant, and the floor asks nothing', () => {
    expect(evaluate([removed(`${WORKSPACE}/src/old.ts`)], { write_scope: [WORKSPACE] })).toEqual({ kind: 'allow', allowedBy: [`write_scope:${WORKSPACE}`] })
  })

  it('asks as the first write into its folder asks, for the folder, and a grant of it covers deletes and writes there', () => {
    const outcome = evaluate([removed(`${WORKSPACE}/src/old.ts`)])
    expect(outcome).toMatchObject({ kind: 'ask', asks: [{ rule: 'write_scope', subject: `${WORKSPACE}/src`, offeredScopes: ['once', 'session', 'always'] }] })
    if (outcome.kind === 'ask') expect(outcome.asks[0]!.reason).toBe(`Writing to ${WORKSPACE}/src is not yet approved. Writable without asking: ${SCRATCH}`)
    expect(evaluate([removed(`${WORKSPACE}/src/deep/old.ts`)], { write_scope: [`${WORKSPACE}/src`] }).kind).toBe('allow')
  })

  it('takes a folder removed whole, a replacing move\'s two removals, and a patch\'s deleted file the same way', () => {
    const granted = { write_scope: [WORKSPACE] }
    expect(evaluate([removed(`${WORKSPACE}/src/legacy`, { tree: counted(12, 2) })], granted).kind).toBe('allow')
    const move: ResolvedEffect[] = [
      { kind: 'read_path', path: `${WORKSPACE}/a.txt`, directory: WORKSPACE }, removed(`${WORKSPACE}/a.txt`),
      { kind: 'write_path', path: `${WORKSPACE}/docs/b.txt`, directory: `${WORKSPACE}/docs`, entry: true }, removed(`${WORKSPACE}/docs/b.txt`),
    ]
    expect(engine().evaluate({ tool: 'fs_move', effects: move, grants: lookup(granted) }).kind).toBe('allow')
    expect(engine().evaluate({ tool: 'fs_apply_patch', effects: [removed(`${WORKSPACE}/src/gone.ts`)], grants: lookup(granted) }).kind).toBe('allow')
  })

  it('is refused where a write is: Buckle\'s state, a workspace policy deny, and the workspace\'s own folder', () => {
    expect(evaluate([removed(`${STATE}/grants.json`)], { write_scope: [WORKSPACE] })).toMatchObject({ kind: 'deny', denial: { rule: 'sensitive_path' } })
    expect(evaluate([removed(`${WORKSPACE}/secrets/a.txt`)], { write_scope: [WORKSPACE] }, { rules: [{ path: 'secrets', write: 'deny' }] })).toMatchObject({ kind: 'deny', denial: { rule: 'filesystem_policy' } })
    expect(evaluate([removed(WORKSPACE, { tree: counted(1, 0) })], { write_scope: [WORKSPACE] })).toMatchObject({ kind: 'deny' })
    expect(evaluate([removed('/work', { tree: counted(1, 1) })], { write_scope: [WORKSPACE] }).kind).toBe('deny')
  })

  it('still asks at the floor in a scratch root, which is a mount and not the workspace\'s folder', () => {
    expect(subjects(evaluate([removed(`${SCRATCH}/tmp.txt`)]))).toEqual([`delete:${SCRATCH}`])
  })

  it('stays at the floor under ask, as before the ruling', () => {
    expect(subjects(evaluate([removed(`${WORKSPACE}/src/old.ts`)], { write_scope: [WORKSPACE] }, { deletes: { inWorkspace: 'ask', massLimit: 100 } }))).toEqual([`delete:${WORKSPACE}/src`])
  })
})

describe('a delete in a scratch root or a writable mount that lies inside the workspace\'s folder', () => {
  const granted = { write_scope: [WORKSPACE] }
  const views: Array<[string, PathView]> = [
    ['scratch root', createPathView({ root: WORKSPACE, mount: null, scratchRoots: [`${WORKSPACE}/tmp`] })],
    ['writable mount', createPathView({ root: WORKSPACE, mount: '/workspace', mounts: [{ source: `${WORKSPACE}/tmp`, target: '/tmp-data', access: 'rw' }] })],
  ]

  it.each(views)('is outside the folder for a %s: it asks at the floor and offers its folder, whatever the write grant says', (_name, paths) => {
    expect(evaluate([removed(`${WORKSPACE}/tmp/x.txt`)], granted, { paths })).toMatchObject({ kind: 'ask', asks: [{ rule: 'write_scope', subject: `delete:${WORKSPACE}/tmp`, widerSubject: `delete-below:${WORKSPACE}/tmp` }] })
    expect(evaluate([removed(`${WORKSPACE}/tmp/cache`, { tree: counted(3, 0) })], granted, { paths })).toMatchObject({ kind: 'ask', asks: [{ subject: `delete-tree:${WORKSPACE}/tmp/cache` }] })
  })

  it.each(views)('leaves the rest of the folder beside a %s under the write gate', (_name, paths) => {
    expect(evaluate([removed(`${WORKSPACE}/src/x.txt`)], granted, { paths }).kind).toBe('allow')
  })

  it.each(views)('counts nothing a %s holds toward the mass-delete guard', (_name, paths) => {
    expect(subjects(evaluate([...folders(2, 50), removed(`${WORKSPACE}/tmp/x.txt`)], granted, { paths }))).toEqual([`delete:${WORKSPACE}/tmp`])
  })
})

describe('the mass-delete guard', () => {
  const granted = { write_scope: [WORKSPACE] }

  it('asks once, under delete-batch, for one call whose folders and files together pass 100 entries, and lets 100 through', () => {
    const outcome = evaluate(folders(3, 40), granted)
    expect(outcome).toMatchObject({ kind: 'ask', asks: [{ rule: 'write_scope', subject: `delete-batch:${WORKSPACE}`, offeredScopes: ['once', 'session', 'always'] }] })
    if (outcome.kind === 'ask') expect(outcome.asks[0]!.reason).toBe('This call deletes 120 entries in the workspace at once, more than 100, so a person decides, though the workspace allows deletes in its folder')
    expect(evaluate(folders(2, 50), granted).kind).toBe('allow')
    expect(evaluate([...folders(2, 50), removed(`${WORKSPACE}/src/one.ts`)], granted).kind).toBe('ask')
    expect(evaluate(files(100), granted).kind).toBe('allow')
    expect(evaluate([...files(100), folder('small', 2)], granted).kind).toBe('ask')
    expect(evaluate(folders(3, 40), { write_scope: [WORKSPACE, `delete-batch:${WORKSPACE}`] })).toMatchObject({ kind: 'allow', allowedBy: expect.arrayContaining([`write_scope:delete-batch:${WORKSPACE}`]) })
  })

  it('counts a folder as itself and all it holds, not as one entry', () => {
    expect(evaluate([folder('a', 60), folder('b', 40)], granted).kind).toBe('allow')
    expect(evaluate([folder('a', 60), folder('b', 41)], granted).kind).toBe('ask')
    expect(evaluate([folder('a', 1), folder('b', 1), folder('c', 1)], granted).kind).toBe('allow')
  })

  it('counts a folder removed whole with everything it holds, under its own delete-tree subject', () => {
    const outcome = evaluate([removed(`${WORKSPACE}/src/generated`, { tree: counted(140, 10) })], granted)
    expect(subjects(outcome)).toEqual([`delete-tree:${WORKSPACE}/src/generated`])
    if (outcome.kind === 'ask') expect(outcome.asks[0]!.reason).toBe(`Deleting the folder ${WORKSPACE}/src/generated and everything in it (140 files and 10 folders) removes more than 100 entries at once, so a person decides, though the workspace allows deletes in its folder`)
    // The folder itself counts: 99 entries inside it are 100 removed.
    expect(evaluate([removed(`${WORKSPACE}/src/generated`, { tree: counted(90, 9) })], granted).kind).toBe('allow')
    expect(evaluate([removed(`${WORKSPACE}/src/generated`, { tree: counted(90, 10) })], granted).kind).toBe('ask')
    expect(subjects(evaluate([removed(`${WORKSPACE}/src/huge`, { tree: counted(10_000, 0, true) })], granted))).toEqual([`delete-tree:${WORKSPACE}/src/huge`])
  })

  it('asks for a folder at the top of the workspace\'s folder that holds anything, whatever its size', () => {
    const outcome = evaluate([removed(`${WORKSPACE}/src`, { tree: counted(3, 1) })], granted)
    expect(subjects(outcome)).toEqual([`delete-tree:${WORKSPACE}/src`])
    if (outcome.kind === 'ask') expect(outcome.asks[0]!.reason).toBe(`Deleting the folder ${WORKSPACE}/src and everything in it (3 files and 1 folder), at the top of the workspace, asks a person, though the workspace allows deletes in its folder`)
    expect(evaluate([removed(`${WORKSPACE}/src`, { tree: counted(3, 1) })], { write_scope: [WORKSPACE, `delete-tree:${WORKSPACE}/src`] }).kind).toBe('allow')
    // An empty folder holds nothing to lose; a file at the top is one entry.
    expect(evaluate([removed(`${WORKSPACE}/empty`, { tree: counted(0, 0) })], granted).kind).toBe('allow')
    expect(evaluate([removed(`${WORKSPACE}/README.md`)], granted).kind).toBe('allow')
  })

  it('asks about a large folder by itself and counts the rest of the call apart from it', () => {
    expect(subjects(evaluate([removed(`${WORKSPACE}/src/generated`, { tree: counted(150, 0) }), ...files(99)], granted))).toEqual([`delete-tree:${WORKSPACE}/src/generated`])
    expect(subjects(evaluate([removed(`${WORKSPACE}/src/generated`, { tree: counted(150, 0) }), ...folders(3, 40)], granted)).sort()).toEqual([`delete-batch:${WORKSPACE}`, `delete-tree:${WORKSPACE}/src/generated`])
  })

  it('asks about a folder moved whole without counting it as a mass deletion', () => {
    expect(evaluate([removed(`${WORKSPACE}/src`, { tree: counted(500, 20), moved: true })], granted)).toMatchObject({ kind: 'ask', asks: [{ subject: `delete-tree:${WORKSPACE}/src`, severity: 'warn' }] })
  })

  it('is off at a limit of 0', () => {
    const off = { deletes: { inWorkspace: 'allow' as const, massLimit: 0 } }
    expect(evaluate(folders(6, 100), granted, off).kind).toBe('allow')
    expect(evaluate([removed(`${WORKSPACE}/src`, { tree: counted(5_000, 50) })], granted, off).kind).toBe('allow')
  })

  it('is answered by the dangerously-allow switch, as every ask inside the workspace is', () => {
    const allowed = withDangerouslyAllow(engine(), { level: () => 'command', root: () => WORKSPACE })
    expect(allowed.evaluate({ tool: 'fs_delete', effects: folders(3, 40), grants: lookup(granted) })).toMatchObject({ kind: 'allow', allowedBy: [`dangerously_allow:command:write_scope:delete-batch:${WORKSPACE}`] })
  })
})

// The delete policy review, R1: within one script, what its earlier calls removed counts toward the limit, and a
// top-level folder they took entries out of asks when it is removed itself.
describe('the mass-delete guard over one script', () => {
  const granted = { write_scope: [WORKSPACE] }
  const during = (effects: ResolvedEffect[], run: DeleteRunView, input: Parameters<typeof engine>[0] = {}) => engine(input).evaluate({ tool: 'fs_delete', effects, grants: lookup(granted), run })

  it('adds what the script removed before the call to the call\'s own deletes', () => {
    expect(during([removed(`${WORKSPACE}/src/a.ts`)], { removed: 99, tops: [] }).kind).toBe('allow')
    const outcome = during([removed(`${WORKSPACE}/src/a.ts`)], { removed: 100, tops: [] })
    expect(subjects(outcome)).toEqual([`delete-batch:${WORKSPACE}`])
    if (outcome.kind === 'ask') expect(outcome.asks[0]!.reason).toBe('This script has deleted 101 entries in the workspace so far, more than 100, so a person decides, though the workspace allows deletes in its folder')
    expect(during(folders(2, 30), { removed: 41, tops: [] }).kind).toBe('ask')
    expect(during([removed(`${WORKSPACE}/src/a.ts`)], { removed: 5_000, tops: [] }, { deletes: { inWorkspace: 'allow', massLimit: 0 } }).kind).toBe('allow')
  })

  it('asks about a top-level folder the script took entries out of, though it holds nothing now', () => {
    const top = `${WORKSPACE}/src`
    for (const effect of [removed(top), removed(top, { tree: counted(0, 0) })]) {
      const outcome = during([effect], { removed: 3, tops: [top] })
      expect(subjects(outcome)).toEqual([`delete-tree:${top}`])
      if (outcome.kind === 'ask') expect(outcome.asks[0]!.reason).toContain(`Deleting the folder ${top}`)
      if (outcome.kind === 'ask') expect(outcome.asks[0]!.reason).toContain('at the top of the workspace and emptied by this script, asks a person')
    }
    expect(during([removed(`${WORKSPACE}/lib`)], { removed: 3, tops: [top] }).kind).toBe('allow')
    expect(during([removed(top)], { removed: 0, tops: [] }).kind).toBe('allow')
  })
})

describe('what a cleared call adds to its script\'s run', () => {
  const paths = createPathView({ root: WORKSPACE, mount: null, scratchRoots: [SCRATCH] })
  const record = (effects: ResolvedEffect[], policy: DeletePolicy = BUILT_IN_DELETE_POLICY) => {
    const run = newDeleteRun()
    recordRemovals(run, effects, paths, policy)
    return run
  }

  it('counts the entries removed, a folder with all it held, and the top-level folder each came out of', () => {
    const run = record([removed(`${WORKSPACE}/src/a.ts`), removed(`${WORKSPACE}/src/deep/b.ts`), removed(`${WORKSPACE}/lib/old`, { tree: counted(9, 0) }), removed(`${WORKSPACE}/README.md`)])
    expect(run).toEqual({ removed: 13, tops: [`${WORKSPACE}/src`, `${WORKSPACE}/lib`] })
  })

  it('adds up across calls, and names a top-level folder once', () => {
    const run = newDeleteRun()
    for (const name of ['a', 'b', 'c']) recordRemovals(run, [removed(`${WORKSPACE}/src/${name}.ts`)], paths, BUILT_IN_DELETE_POLICY)
    expect(run).toEqual({ removed: 3, tops: [`${WORKSPACE}/src`] })
  })

  it('leaves out a folder the guard asked about, a folder moved whole, a delete outside the folder, a move of a file, and every delete when the guard is off or deletes ask', () => {
    expect(record([removed(`${WORKSPACE}/src/big`, { tree: counted(500, 0) })])).toEqual({ removed: 0, tops: [`${WORKSPACE}/src`] })
    expect(record([removed(`${WORKSPACE}/src/lib`, { tree: counted(30, 2), moved: true })])).toEqual({ removed: 0, tops: [] })
    expect(record([removed(`${SCRATCH}/x.txt`), removed(`${WORKSPACE}/src/keep.ts`, { floor: false })])).toEqual({ removed: 0, tops: [] })
    expect(record([removed(`${WORKSPACE}/src/a.ts`)], { inWorkspace: 'allow', massLimit: 0 })).toEqual({ removed: 0, tops: [] })
    expect(record([removed(`${WORKSPACE}/src/a.ts`)], { inWorkspace: 'ask', massLimit: 100 })).toEqual({ removed: 0, tops: [] })
  })

  it('judges a call\'s own removals against the run as it stood before the call', () => {
    const run = newDeleteRun()
    recordRemovals(run, [removed(`${WORKSPACE}/src/a.ts`), removed(`${WORKSPACE}/src`, { tree: counted(0, 0) })], paths, BUILT_IN_DELETE_POLICY)
    expect(run.removed).toBe(2)
  })
})

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** `scratch`: a folder inside the workspace's own that the node names a scratch root. */
async function node(extra: Record<string, string> = {}, scratch?: string): Promise<{ workspace: string; runtime: BuckleRuntime }> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-delete-policy-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  if (scratch !== undefined) mkdirSync(join(workspace, scratch))
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_HOST_GIT: 'true', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '1', ...(scratch === undefined ? {} : { BUCKLE_SCRATCH_ROOTS: join(workspace, scratch) }), ...extra })
  const runtime = await createRuntime({ config })
  runtimes.push(runtime)
  return { workspace, runtime }
}

let sequence = 0
function call(runtime: BuckleRuntime, tool: string, args: JsonObject, tokens: string[] = [], requestId = `policy-${++sequence}`): Promise<InvokeResponse> {
  return runtime.invoke({ request: { requestId, tool, args, approvalTokens: tokens }, sessionId: 'agent' })
}
const grantWrites = (runtime: BuckleRuntime, subject = runtime.paths().root) => runtime.grants.grant({ sessionId: 'agent', rule: 'write_scope', subject, scope: 'session' })

describe('the fs tools under the default delete policy', () => {
  it('delete a file where writes are granted without asking, and the checkpoint brings it back', async () => {
    const { runtime, workspace } = await node()
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src/old.ts'), 'export const old = 1\n')
    await grantWrites(runtime)
    expect(await call(runtime, 'fs_delete', { paths: ['src/old.ts'] })).toMatchObject({ outcome: 'ok', output: { removed: 1 } })
    expect(existsSync(join(workspace, 'src/old.ts'))).toBe(false)
    const [checkpoint] = (await runtime.history.list()).filter(item => item.tool === 'fs_delete')
    await runtime.history.restore(checkpoint!.id)
    expect(readFileSync(join(workspace, 'src/old.ts'), 'utf8')).toBe('export const old = 1\n')
  })

  it('ask for the folder as a first write does, and a session grant of it lets the next delete there run', async () => {
    const { runtime, workspace } = await node()
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src/a.ts'), 'a')
    writeFileSync(join(workspace, 'src/b.ts'), 'b')
    const asked = await call(runtime, 'fs_delete', { paths: ['src/a.ts'] }, [], 'first-delete')
    expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ rule: 'write_scope', subject: join(runtime.paths().root, 'src') }] })
    const token = asked.outcome === 'approval_required' ? asked.approvals[0]!.token : ''
    expect((await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'session' }, authority: 'admin' })).ok).toBe(true)
    expect(await call(runtime, 'fs_delete', { paths: ['src/a.ts'] }, [token], 'first-delete')).toMatchObject({ outcome: 'ok', output: { removed: 1 } })
    expect(await call(runtime, 'fs_delete', { paths: ['src/b.ts'] })).toMatchObject({ outcome: 'ok', output: { removed: 1 } })
  })

  it('replace a file with fs_move without asking where writes are granted', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'draft.md'), 'new')
    writeFileSync(join(workspace, 'final.md'), 'old')
    await grantWrites(runtime)
    expect(await call(runtime, 'fs_move', { from: 'draft.md', to: 'final.md', replace: true })).toMatchObject({ outcome: 'ok', output: { replaced: true } })
    expect(readFileSync(join(workspace, 'final.md'), 'utf8')).toBe('new')
  })

  it('ask at the floor for a folder at the top of the workspace, and let a call of exactly 100 entries through', async () => {
    const { runtime, workspace } = await node()
    mkdirSync(join(workspace, 'src/nested'), { recursive: true })
    writeFileSync(join(workspace, 'src/nested/a.ts'), 'a')
    await grantWrites(runtime)
    expect(await call(runtime, 'fs_delete', { paths: ['src'], recursive: true })).toMatchObject({ outcome: 'approval_required', approvals: [{ subject: `delete-tree:${join(runtime.paths().root, 'src')}` }] })
    expect(await call(runtime, 'fs_delete', { paths: ['src/nested'], recursive: true })).toMatchObject({ outcome: 'ok', output: { removed: 1 } })
    mkdirSync(join(workspace, 'logs'))
    for (let index = 0; index < 101; index++) writeFileSync(join(workspace, `logs/${index}.log`), '')
    const paths = Array.from({ length: 100 }, (_, index) => `logs/${index}.log`)
    expect(await call(runtime, 'fs_delete', { paths: [...paths] })).toMatchObject({ outcome: 'ok', output: { removed: 100 } })
    writeFileSync(join(workspace, 'logs/0.log'), '')
    expect(await call(runtime, 'fs_delete', { paths: ['logs'], recursive: true })).toMatchObject({ outcome: 'approval_required', approvals: [{ subject: `delete-tree:${join(runtime.paths().root, 'logs')}` }] })
  })

  it('warn and ask before moving a folder whole where writes are granted, then move it once approved', async () => {
    const { runtime, workspace } = await node()
    mkdirSync(join(workspace, 'src/lib'), { recursive: true })
    writeFileSync(join(workspace, 'src/lib/a.ts'), 'a')
    mkdirSync(join(workspace, 'pkg'))
    for (let index = 0; index < 101; index++) writeFileSync(join(workspace, `pkg/${index}.ts`), '')
    await grantWrites(runtime)
    for (const [from, to] of [['src/lib', 'src/old-lib'], ['pkg', 'package']] as const) {
      const args = { from, to }
      const asked = await call(runtime, 'fs_move', args)
      expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ subject: `delete-tree:${join(runtime.paths().root, from)}`, severity: 'warn', reason: expect.stringContaining('[warn] Moving the folder') }] })
      expect(existsSync(join(workspace, from))).toBe(true)
      expect(existsSync(join(workspace, to))).toBe(false)
      if (asked.outcome !== 'approval_required') throw new Error('Expected the folder move to ask before changing anything')
      const tokens = asked.approvals.map(approval => approval.token)
      for (const token of tokens) expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, authority: 'admin' })).toMatchObject({ ok: true })
      expect(await call(runtime, 'fs_move', args, tokens)).toMatchObject({ outcome: 'ok' })
    }
    expect(readFileSync(join(workspace, 'src/old-lib/a.ts'), 'utf8')).toBe('a')
    expect(existsSync(join(workspace, 'package/100.ts'))).toBe(true)
  })

  it('delete a file with a patch without asking where writes are granted', async () => {
    const { runtime, workspace } = await node()
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src/gone.ts'), 'x\ny\n')
    await grantWrites(runtime)
    expect(await call(runtime, 'fs_apply_patch', { patch: '--- a/src/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n' })).toMatchObject({ outcome: 'ok' })
    expect(existsSync(join(workspace, 'src/gone.ts'))).toBe(false)
  })

  it('ask once for several folders whose entries together pass the limit, and run them under a session grant of that ask', async () => {
    const { runtime, workspace } = await node()
    mkdirSync(join(workspace, 'src'))
    for (const name of ['a', 'b', 'c']) {
      mkdirSync(join(workspace, `src/${name}`))
      for (let index = 0; index < 40; index++) writeFileSync(join(workspace, `src/${name}/${index}.ts`), '')
    }
    await grantWrites(runtime)
    const subject = `delete-batch:${runtime.paths().root}`
    const asked = await call(runtime, 'fs_delete', { paths: ['src/a', 'src/b', 'src/c'], recursive: true }, [], 'folders-1')
    expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ rule: 'write_scope', subject }] })
    expect(existsSync(join(workspace, 'src/a'))).toBe(true)
    expect(await call(runtime, 'fs_delete', { paths: ['src/a', 'src/b'], recursive: true })).toMatchObject({ outcome: 'ok', output: { removed: 2 } })
    await runtime.grants.grant({ sessionId: 'agent', rule: 'write_scope', subject, scope: 'session' })
    expect(await call(runtime, 'fs_delete', { paths: ['src/c'], recursive: true })).toMatchObject({ outcome: 'ok', output: { removed: 1 } })
    mkdirSync(join(workspace, 'src/d'))
    mkdirSync(join(workspace, 'src/e'))
    for (let index = 0; index < 60; index++) writeFileSync(join(workspace, `src/d/${index}.ts`), '')
    for (let index = 0; index < 60; index++) writeFileSync(join(workspace, `src/e/${index}.ts`), '')
    expect(await call(runtime, 'fs_delete', { paths: ['src/d', 'src/e'], recursive: true })).toMatchObject({ outcome: 'ok', output: { removed: 2 } })
  })

  it('ask in a scratch root that lies inside the workspace\'s folder, which is outside the folder for deletes', async () => {
    const { runtime, workspace } = await node({}, 'cache')
    writeFileSync(join(workspace, 'cache/x.txt'), 'x')
    writeFileSync(join(workspace, 'y.txt'), 'y')
    await grantWrites(runtime)
    const cache = join(runtime.paths().root, 'cache')
    expect(await call(runtime, 'fs_delete', { paths: ['cache/x.txt'] })).toMatchObject({ outcome: 'approval_required', approvals: [{ subject: `delete:${cache}`, widerSubject: `delete-below:${cache}` }] })
    expect(existsSync(join(workspace, 'cache/x.txt'))).toBe(true)
    expect(await call(runtime, 'fs_delete', { paths: ['y.txt'] })).toMatchObject({ outcome: 'ok', output: { removed: 1 } })
  })

  it('ask at the floor everywhere in the folder under files.deleteInWorkspace ask, and let through more under a higher limit', async () => {
    const asking = await node({ BUCKLE_DELETE_IN_WORKSPACE: 'ask' })
    writeFileSync(join(asking.workspace, 'a.txt'), 'a')
    await grantWrites(asking.runtime)
    expect(await call(asking.runtime, 'fs_delete', { paths: ['a.txt'] })).toMatchObject({ outcome: 'approval_required', approvals: [{ subject: `delete:${asking.runtime.paths().root}` }] })
    const roomy = await node({ BUCKLE_MASS_DELETE_LIMIT: '0' })
    mkdirSync(join(roomy.workspace, 'build'))
    writeFileSync(join(roomy.workspace, 'build/out.js'), '1')
    await grantWrites(roomy.runtime)
    expect(await call(roomy.runtime, 'fs_delete', { paths: ['build'], recursive: true })).toMatchObject({ outcome: 'ok', output: { removed: 1 } })
  })
})
