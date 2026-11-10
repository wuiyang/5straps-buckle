import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy, type JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { compileCommandGlob } from '../common/domain/command-glob.js'
import type { DeletePolicy } from '../common/domain/delete-policy.js'
import type { ResolvedEffect, TreeCount } from '../common/domain/effect.js'
import { createPathView } from '../common/domain/path-view.js'
import { ask, commandMarks, PLAIN_MARKS, type AskMarks, type PermissionDecision } from '../common/domain/permission/decision.js'
import { createDestructiveCommandRule } from '../common/domain/permission/rules/destructive-command-rule.js'
import { createDestructivePathRule } from '../common/domain/permission/rules/destructive-path-rule.js'
import { isFloorSubject } from '../common/domain/permission/subjects.js'
import { createWriteScopeRule } from '../common/domain/permission/rules/write-scope-rule.js'
import { approvalsPath } from '../common/runtime/config.js'
import { ActionTooLargeError } from '../common/services/approvals/approval-errors.js'
import { createApprovalRegistry, MAX_ASK_BYTES } from '../common/services/approvals/approval-registry.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { Judge } from '../common/types/ports/judge.js'
import type { QuickJudge } from '../common/types/ports/quick-judge.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { settleAuditLogs } from './support/action-log-writer.js'

// The floor and destructive marks the permission rules set on their asks, kept with each ask in the ledger (the approval
// backend design, slice 3). Nothing reads them yet: they are stored for the decision guard's later checks.

type Ask = Extract<PermissionDecision, { kind: 'ask' }>

const WORKSPACE = '/work/project'
const NO_GRANTS = { subjectsFor: () => [] }
const paths = createPathView({ root: WORKSPACE, mount: null })
const ASK: DeletePolicy = { inWorkspace: 'ask', massLimit: 2 }
const ALLOW: DeletePolicy = { inWorkspace: 'allow', massLimit: 2 }

const counted = (files: number, folders: number): TreeCount => ({ counted: true, files, folders, more: false })
const removed = (path: string, input: { tree?: TreeCount; moved?: true } = {}): ResolvedEffect => ({ kind: 'delete_path', path, directory: path.slice(0, path.lastIndexOf('/')) || '/', floor: true, ...(input.tree ? { tree: input.tree } : {}), ...(input.moved ? { moved: true } : {}) } as ResolvedEffect)

function fileFloor(effect: ResolvedEffect, input: { effects?: ResolvedEffect[]; deletes?: DeletePolicy } = {}) {
  return createDestructivePathRule({ paths, strict: false, deletes: input.deletes ?? ASK, home: '/home/owner' }).evaluate({ tool: 'fs_delete', effect, effects: input.effects ?? [effect], grants: NO_GRANTS })
}

function command(name: string, args: string[], added: string[] = []) {
  return createDestructiveCommandRule({ added: added.map(compileCommandGlob) }).evaluate({ tool: 'shell_exec', effect: { kind: 'exec', command: name, args }, grants: NO_GRANTS })
}

describe('a file floor ask', () => {
  const asks: Array<[string, ResolvedEffect, { effects?: ResolvedEffect[]; deletes?: DeletePolicy }]> = [
    ['a delete', removed(`${WORKSPACE}/src/a.ts`), {}],
    ['a delete outside the workspace', removed('/elsewhere/a.ts'), {}],
    ['a folder removed whole', removed(`${WORKSPACE}/src/build`, { tree: counted(3, 1) }), {}],
    ['a folder moved whole', removed(`${WORKSPACE}/src`, { tree: counted(3, 1), moved: true }), {}],
    ['a large folder the workspace lets go', removed(`${WORKSPACE}/src/big`, { tree: counted(10, 0) }), { deletes: ALLOW }],
    ['a batch of deletes the workspace lets go', removed(`${WORKSPACE}/src/a`), { effects: [removed(`${WORKSPACE}/src/a`), removed(`${WORKSPACE}/src/b`), removed(`${WORKSPACE}/src/c`)], deletes: ALLOW }],
    ['an overwrite of a file never read', { kind: 'unread_shrink', path: `${WORKSPACE}/a.txt`, empties: true }, {}],
    ['a batch of rewrites', { kind: 'many_rewrites', files: 30 }, {}],
    ['a restore', { kind: 'restore_checkpoint', checkpoint: 'change-1', head: 'change-2', undoes: 2 }, {}],
  ]

  it.each(asks)('%s is marked floor and destructive, as its reason says a person decides', (_name, effect, input) => {
    const decision = fileFloor(effect, input)
    expect(decision).toMatchObject({ kind: 'ask', rule: 'write_scope', floor: true, destructive: true })
    if (decision?.kind !== 'ask') return
    expect(isFloorSubject(decision.subject)).toBe(true)
    expect(decision.reason).toMatch(/a person decides|asks a person/)
  })

  it('covers every subject the floor asks under', () => {
    const prefixes = asks.map(([, effect, input]) => fileFloor(effect, input)).map(decision => (decision?.kind === 'ask' ? decision.subject.slice(0, decision.subject.indexOf(':') + 1) : null))
    expect(new Set(prefixes)).toEqual(new Set(['delete:', 'delete-tree:', 'move-tree:', 'delete-batch:', 'overwrite:', 'rewrite-batch:', 'restore:']))
  })

  it('leaves a write the folder grant does not cover unmarked', () => {
    const decision = createWriteScopeRule({ paths, strict: false, deletes: ASK }).evaluate({ tool: 'fs_write', effect: { kind: 'write_path', path: `${WORKSPACE}/a.md`, directory: WORKSPACE }, grants: NO_GRANTS })
    expect(decision).toMatchObject({ kind: 'ask', rule: 'write_scope', floor: false, destructive: false })
  })

  it('cannot be made without both marks', () => {
    // @ts-expect-error every ask says whether it is the floor and whether it is destructive
    const unmarked: Ask = { kind: 'ask', rule: 'write_scope', subject: WORKSPACE, reason: 'outside', offeredScopes: ['once'] }
    expect(unmarked).not.toHaveProperty('floor')
    expectTypeOf(ask).parameter(0).toHaveProperty('marks').toEqualTypeOf<Readonly<AskMarks>>()
  })
})

describe('a destructive command ask', () => {
  it.each([
    ['rm', ['-rf', 'build'], [], 'floor'],
    ['sudo', ['ls'], [], 'floor'],
    ['bash', ['-c', 'eval "$x"'], [], 'floor'],
    ['python3', ['job.py'], ['python3 *'], 'destructive-list'],
    ['terraform', ['destroy', 'x'], ['terraform destroy *'], 'destructive-list'],
  ])('%s %j at the built-in floor or the destructive list is marked floor and destructive', (name, args, added, cause) => {
    expect(command(name, args, added)).toMatchObject({ kind: 'ask', rule: 'destructive_command', cause, floor: true, destructive: true })
  })

  it('about an interpreter the policy does not allow is destructive and not the floor', () => {
    const decision = command('python3', ['job.py'])
    expect(decision).toMatchObject({ kind: 'ask', rule: 'destructive_command', cause: 'interpreter', floor: false, destructive: true })
  })

  it('marks every cause destructive, and the built-in floor and the destructive list alone as the floor', () => {
    expect(commandMarks('floor')).toEqual({ floor: true, destructive: true })
    expect(commandMarks('destructive-list')).toEqual({ floor: true, destructive: true })
    expect(commandMarks('interpreter')).toEqual({ floor: false, destructive: true })
    expect(commandMarks('judge')).toEqual({ floor: false, destructive: true })
  })
})

describe('the ask record', () => {
  const roots: string[] = []
  afterEach(async () => { await settleAuditLogs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
  function ledger() {
    const root = mkdtempSync(join(tmpdir(), 'buckle-marks-'))
    roots.push(root)
    const file = join(root, 'approvals.json')
    return { file, registry: createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: '/workspace' }), file) }
  }
  const call = { arguments: { paths: ['a.txt'] }, cwd: '/workspace', description: null, effects: [], complete: true as const }

  it('keeps each ask\'s marks beside its request', async () => {
    const { file, registry } = ledger()
    await registry.ask({ tool: 'fs_delete', sessionId: 's', call, asks: [
      { kind: 'ask', rule: 'write_scope', subject: 'delete:/workspace', reason: 'Deleting /workspace/a.txt asks a person', offeredScopes: ['once', 'session', 'always'], floor: true, destructive: true },
      { kind: 'ask', rule: 'write_scope', subject: '/workspace', reason: 'outside', offeredScopes: ['once', 'session', 'always'], ...PLAIN_MARKS },
    ] })
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { pending: Array<{ floor?: boolean; destructive?: boolean }> }
    expect(stored.pending.map(entry => [entry.floor, entry.destructive])).toEqual([[true, true], [false, false]])
    expect(registry.waiting().map(ask => [ask.request.subject, ask.floor, ask.destructive])).toEqual([['delete:/workspace', true, true], ['/workspace', false, false]])
  })

  it('leaves the marks out of the bytes an ask counts against what a person is shown whole', async () => {
    const { file, registry } = ledger()
    const asks = [{ kind: 'ask' as const, rule: 'write_scope' as const, subject: '/workspace', reason: 'outside', offeredScopes: ['once' as const], ...PLAIN_MARKS }]
    const write = (sessionId: string, content: string) => registry.ask({ tool: 'fs_write', sessionId, asks, call: { arguments: { content }, cwd: '/workspace', description: null, effects: [], complete: true } })
    await write('one', '')
    const [probe] = (JSON.parse(readFileSync(file, 'utf8')) as { pending: Array<{ floor: boolean; destructive: boolean; callFile: { bytes: number } }> }).pending
    const { floor: _floor, destructive: _destructive, ...counted } = probe!
    // The ask's record names its call file's size, so its length grows by that number's added digits.
    const digits = (bytes: number) => String(bytes).length
    const fixed = Buffer.byteLength(JSON.stringify(counted)) - digits(probe!.callFile.bytes) + probe!.callFile.bytes
    const fits = MAX_ASK_BYTES - fixed - digits(MAX_ASK_BYTES)
    await expect(write('two', 'x'.repeat(fits + 1))).rejects.toThrow(ActionTooLargeError)
    expect((await write('two', 'x'.repeat(fits))).requests).toHaveLength(1)
  })

  it('reads an ask recorded before the marks as both floor and destructive', () => {
    const { file, registry } = ledger()
    const request = { token: '00000000-0000-4000-8000-000000000001', rule: 'write_scope', subject: '/workspace', reason: 'outside', tool: 'fs_write', offeredScopes: ['once', 'session', 'always'], expiresAt: new Date(Date.now() + 600_000).toISOString() }
    writeFileSync(file, JSON.stringify({ version: 1, pending: [{ request, sessionId: 's', workspace: '/workspace' }], once: [], resolved: [], outbox: [] }))
    expect(registry.waiting().map(ask => [ask.floor, ask.destructive])).toEqual([[true, true]])
  })
})

describe('an ask the invoker records', () => {
  const roots: string[] = []
  const runtimes: CoreRuntime[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
    await settleAuditLogs()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  async function node(input: { environment?: Record<string, string>; judges?: { judge: Judge; quickJudge: QuickJudge } } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'buckle-marks-invoker-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(join(workspace, 'one'), { recursive: true })
    writeFileSync(join(workspace, 'one', 'a.txt'), 'a')
    const config = configFromEnvironment({
      BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false',
      BUCKLE_PACKS: 'fs,shell', BUCKLE_DELETE_IN_WORKSPACE: 'ask', BUCKLE_APPROVAL_TIMEOUT_MS: '60000', ...input.environment,
    })
    const runtime = await createRuntime({ config, ...input.judges })
    runtimes.push(runtime)
    // Each ask the call made, as the ledger on disk holds it: rule, subject, and both marks.
    const recorded = async (tool: string, args: JsonObject) => {
      const response = await runtime.invoke({ request: { requestId: randomUUID(), tool, args, approvalTokens: [] }, sessionId: 's', approvalWait: { mode: 'none' } })
      if (response.outcome !== 'approval_required') throw new Error(`expected an ask, got ${response.outcome}`)
      const tokens = new Set(response.approvals.map(approval => approval.token))
      const ledger = JSON.parse(readFileSync(approvalsPath(config), 'utf8')) as { pending: Array<{ request: { token: string; rule: string; subject: string }; floor: boolean; destructive: boolean }> }
      return ledger.pending.filter(entry => tokens.has(entry.request.token)).map(entry => ({ rule: entry.request.rule, subject: entry.request.subject, floor: entry.floor, destructive: entry.destructive }))
    }
    return { runtime, recorded, folder: join(runtime.paths().root, 'one') }
  }

  it('lands a delete at the file floor as floor and destructive', async () => {
    const { recorded, folder } = await node()
    expect(await recorded('fs_delete', { paths: ['one/a.txt'] })).toEqual([{ rule: 'write_scope', subject: `delete:${folder}`, floor: true, destructive: true }])
  })

  it('lands a recursive delete command as floor and destructive beside its plain write ask, and an interpreter the policy does not allow as destructive alone', async () => {
    const { runtime, recorded } = await node()
    expect(await recorded('shell_exec', { command: 'rm', args: ['-rf', 'build'] })).toEqual(expect.arrayContaining([
      { rule: 'destructive_command', subject: expect.stringMatching(/^rm -rf build /), floor: true, destructive: true },
      { rule: 'write_scope', subject: runtime.paths().root, floor: false, destructive: false },
    ]))
    expect(await recorded('shell_exec', { command: 'python3', args: ['job.py'] })).toContainEqual({ rule: 'destructive_command', subject: expect.stringMatching(/^python3 job\.py /), floor: false, destructive: true })
  })

  it('lands an allowed command the quick stage rated danger as destructive alone', async () => {
    const quickJudge: QuickJudge = { quick: vi.fn(async () => ({ kind: 'verdict' as const, level: 'danger' as const, confidence: 0.95, probabilities: { safe: 0.025, warning: 0.025, danger: 0.95 }, model: 'jev-test', latencyMs: 1 })) }
    const judge: Judge = { judge: vi.fn(async () => ({ kind: 'unavailable' as const, reason: 'not asked here' })) }
    const { runtime, recorded } = await node({ environment: { BUCKLE_APPROVAL_JUDGE: 'automated', BUCKLE_APPROVAL_QUICK_JUDGE: 'all' }, judges: { judge, quickJudge } })
    await runtime.policy.apply({ ...emptyWorkspacePolicy(), commands: { allow: ['cat *'], deny: [] } })
    vi.spyOn(runtime.registry().get('shell_exec'), 'prepare').mockReturnValue({ effects: [{ kind: 'exec', command: 'cat', args: ['notes.txt'] }], execute: vi.fn(async () => 'executed') })
    expect(await recorded('shell_exec', {})).toEqual([{ rule: 'destructive_command', subject: expect.stringMatching(/^cat notes\.txt /), floor: false, destructive: true }])
  })
})
