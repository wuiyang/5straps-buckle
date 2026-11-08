import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RequestCli } from '@5straps/runtime'
import type { InvokeResponse, JsonObject, PermissionRuleId } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import type { DeletePolicy } from '../common/domain/delete-policy.js'
import type { ResolvedEffect, TreeCount } from '../common/domain/effect.js'
import { FILE_FLOOR_MARKS, type GrantLookup, type PermissionDecision } from '../common/domain/permission/decision.js'
import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { createDestructivePathRule, isFloorSubject } from '../common/domain/permission/rules/destructive-path-rule.js'
import { createWriteScopeRule } from '../common/domain/permission/rules/write-scope-rule.js'
import { createPathView } from '../common/domain/path-view.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { deviceDecision } from './support/device-decision.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction, approvalServiceWithTerminal } from './support/interaction.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { SOURCES } from '../common/types/ports/approval-source.js'
import { questionFor } from '../common/adapters/approval/terminal-question.js'
import { settleAuditLogs } from './support/action-log-writer.js'

// The delete policy brief, item 3: a delete outside the workspace's own folder (a writable mount, or a path an approval
// reached) asks at the floor as before, and offers two subjects besides its scopes: the target alone, as before, or its
// folder with its subfolders, `delete-below:<folder>`, which later deletes anywhere inside it match as a write grant
// does. The wider subject rides in an optional field, so a reader pinned to protocol 0.1.7 approves the first unchanged.

const WORKSPACE = '/work/project'
const MOUNT = '/srv/data'

function lookup(granted: Partial<Record<PermissionRuleId, string[]>> = {}): GrantLookup {
  return { subjectsFor: rule => granted[rule] ?? [] }
}

function engine(input: { strict?: boolean; deletes?: DeletePolicy } = {}) {
  const paths = createPathView({ root: WORKSPACE, mount: '/workspace', mounts: [{ source: MOUNT, target: '/data', access: 'rw' }] })
  const deletes = input.deletes ?? { inWorkspace: 'allow', massLimit: 100 }
  return createPermissionEngine([
    createDestructivePathRule({ paths, strict: input.strict ?? false, deletes }),
    createWriteScopeRule({ paths, strict: input.strict ?? false, deletes }),
  ])
}

const counted = (files: number, folders: number): TreeCount => ({ counted: true, files, folders, more: false })
const removed = (path: string, tree?: TreeCount): ResolvedEffect => ({ kind: 'delete_path', path, directory: path.slice(0, path.lastIndexOf('/')) || '/', floor: true, ...(tree ? { tree } : {}) })
const evaluate = (effects: ResolvedEffect[], granted?: Partial<Record<PermissionRuleId, string[]>>, input?: Parameters<typeof engine>[0]) => engine(input).evaluate({ tool: 'fs_delete', effects, grants: lookup(granted) })

describe('a delete outside the workspace\'s folder', () => {
  it('asks at the floor, whatever the folder\'s write grant says, and offers its folder and subfolders beside the entry', () => {
    const outcome = evaluate([removed(`${MOUNT}/reports/old.csv`)], { write_scope: [MOUNT] })
    expect(outcome).toMatchObject({ kind: 'ask', asks: [{ rule: 'write_scope', subject: `delete:${MOUNT}/reports`, widerSubject: `delete-below:${MOUNT}/reports`, offeredScopes: ['once', 'session', 'always'] }] })
    if (outcome.kind === 'ask') expect(outcome.asks[0]!.reason).toBe('Deleting /data/reports/old.csv asks a person, whatever the folder\'s write grant says')
  })

  it('offers, for a folder removed whole, the folder that holds it with its subfolders', () => {
    expect(evaluate([removed(`${MOUNT}/reports/2025`, counted(4, 1))])).toMatchObject({ kind: 'ask', asks: [{ subject: `delete-tree:${MOUNT}/reports/2025`, widerSubject: `delete-below:${MOUNT}/reports` }] })
  })

  it('runs under a delete-below grant anywhere in that folder and its subfolders, relying on that grant, and nowhere beside it', () => {
    const granted = { write_scope: [`delete-below:${MOUNT}/reports`] }
    expect(evaluate([removed(`${MOUNT}/reports/old.csv`)], granted)).toEqual({ kind: 'allow', allowedBy: [`write_scope:delete-below:${MOUNT}/reports`] })
    expect(evaluate([removed(`${MOUNT}/reports/2025/q1/a.csv`), removed(`${MOUNT}/reports/2025/q2`, counted(30, 2))], granted).kind).toBe('allow')
    expect(evaluate([removed(`${MOUNT}/reports`, counted(30, 2))], granted).kind).toBe('allow')
    expect(evaluate([removed(`${MOUNT}/reports-old/a.csv`)], granted).kind).toBe('ask')
    expect(evaluate([removed(`${MOUNT}/a.csv`)], granted).kind).toBe('ask')
  })

  it('still runs under a grant of the entry\'s own subject, as before', () => {
    expect(evaluate([removed(`${MOUNT}/reports/old.csv`)], { write_scope: [`delete:${MOUNT}/reports`] }).kind).toBe('allow')
  })

  it('offers once alone and no wider subject in strict mode', () => {
    const outcome = evaluate([removed(`${MOUNT}/reports/old.csv`)], {}, { strict: true })
    expect(outcome).toMatchObject({ kind: 'ask', asks: [{ offeredScopes: ['once'] }] })
    expect(outcome.kind === 'ask' ? outcome.asks[0] : null).not.toHaveProperty('widerSubject')
  })
})

describe('a delete-below grant', () => {
  it('never covers a delete inside the workspace\'s folder, which its own setting decides, nor reads as a folder grant for a write', () => {
    const ask = { deletes: { inWorkspace: 'ask' as const, massLimit: 100 } }
    expect(evaluate([removed(`${WORKSPACE}/src/a.ts`)], { write_scope: ['delete-below:/work'] }, ask)).toMatchObject({ kind: 'ask', asks: [{ subject: `delete:${WORKSPACE}/src` }] })
    const inside = evaluate([removed(`${WORKSPACE}/src/a.ts`)], {}, ask)
    expect(inside.kind === 'ask' ? inside.asks[0] : {}).not.toHaveProperty('widerSubject')
    const write: ResolvedEffect = { kind: 'write_path', path: `${MOUNT}/reports/new.csv`, directory: `${MOUNT}/reports` }
    expect(evaluate([write], { write_scope: [`delete-below:${MOUNT}`] }).kind).toBe('ask')
    expect(isFloorSubject(`delete-below:${MOUNT}`)).toBe(true)
  })
})

// The delete policy review, R3: a wider subject names a folder, and some folders are too wide to offer. An unmounted view,
// which is the default, reaches any path a read or write approval reached, so the agent's own choice of target must not
// become a grant over its owner's home folder, a folder that holds the workspace's, or the filesystem's root.
describe('the wider subject, where the target\'s folder is too wide to grant', () => {
  const HOME = '/home/me'
  const unmounted = (input: { home?: string } = {}) => {
    const paths = createPathView({ root: WORKSPACE, mount: null, scratchRoots: ['/scratch'] })
    const deletes: DeletePolicy = { inWorkspace: 'allow', massLimit: 100 }
    return createPermissionEngine([
      createDestructivePathRule({ paths, strict: false, deletes, home: input.home ?? HOME }),
      createWriteScopeRule({ paths, strict: false, deletes }),
    ])
  }
  const asked = (path: string, granted: Partial<Record<PermissionRuleId, string[]>> = {}, tree?: TreeCount) => unmounted().evaluate({ tool: 'fs_delete', effects: [removed(path, tree)], grants: lookup(granted) })

  it.each([
    ['a folder that holds the workspace\'s folder', '/work/notes.txt', '/work'],
    ['the filesystem\'s root', '/notes.txt', '/'],
    ['the home folder', `${HOME}/notes.txt`, HOME],
    ['a folder above the home folder', '/home/notes.txt', '/home'],
  ])('offers the target alone for %s', (_name, path, folder) => {
    const outcome = asked(path)
    expect(outcome).toMatchObject({ kind: 'ask', asks: [{ rule: 'write_scope', subject: `delete:${folder}`, offeredScopes: ['once', 'session', 'always'] }] })
    expect(outcome.kind === 'ask' ? outcome.asks[0] : null).not.toHaveProperty('widerSubject')
  })

  it('offers the folder and its subfolders for a folder beside those, below the home folder, or a scratch root itself', () => {
    expect(asked(`${HOME}/Downloads/a.zip`)).toMatchObject({ kind: 'ask', asks: [{ subject: `delete:${HOME}/Downloads`, widerSubject: `delete-below:${HOME}/Downloads` }] })
    expect(asked('/work/other/src/a.ts')).toMatchObject({ kind: 'ask', asks: [{ widerSubject: 'delete-below:/work/other/src' }] })
    expect(asked('/scratch/a.txt')).toMatchObject({ kind: 'ask', asks: [{ widerSubject: 'delete-below:/scratch' }] })
    expect(asked(`${HOME}/Downloads/old`, {}, counted(2, 0))).toMatchObject({ kind: 'ask', asks: [{ subject: `delete-tree:${HOME}/Downloads/old`, widerSubject: `delete-below:${HOME}/Downloads` }] })
  })

  it('does not let a held delete-below grant of such a folder cover a delete beside the workspace, or in the home folder', () => {
    expect(asked('/work/other/src/a.ts', { write_scope: ['delete-below:/work'] }).kind).toBe('ask')
    expect(asked(`${HOME}/Documents/b.txt`, { write_scope: [`delete-below:${HOME}`] }).kind).toBe('ask')
    expect(asked('/etc/b.txt', { write_scope: ['delete-below:/'] }).kind).toBe('ask')
    expect(asked(`${HOME}/Downloads/a.zip`, { write_scope: [`delete-below:${HOME}/Downloads`] }).kind).toBe('allow')
  })
})

const roots: string[] = []
afterEach(async () => { await settleAuditLogs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'buckle-delete-below-'))
  roots.push(root)
  return root
}

const CALL = { arguments: { paths: ['/srv/data/reports/old.csv'] }, cwd: '/workspace', description: 'Delete 1 file', effects: ['delete /srv/data/reports/old.csv'], complete: true as const }
const WIDE: Extract<PermissionDecision, { kind: 'ask' }> = { kind: 'ask', ...FILE_FLOOR_MARKS, rule: 'write_scope', subject: `delete:${MOUNT}/reports`, reason: 'Deleting /data/reports/old.csv asks a person', offeredScopes: ['once', 'session', 'always'], widerSubject: `delete-below:${MOUNT}/reports` }

function queue() {
  const root = scratch()
  const grants = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root })
  return { grants, registry: createApprovalRegistry(grants, join(root, 'approvals.json'), 15_000) }
}

describe('the approval queue', () => {
  it('records the wider subject with the request, and grants it for a decision that names it', async () => {
    const { registry, grants } = queue()
    const [request] = (await registry.ask({ tool: 'fs_delete', sessionId: 's1', asks: [WIDE], call: CALL })).requests
    expect(request).toMatchObject({ subject: `delete:${MOUNT}/reports`, widerSubject: `delete-below:${MOUNT}/reports` })
    expect(registry.pending()[0]).toMatchObject({ widerSubject: `delete-below:${MOUNT}/reports` })
    const decision = { token: request!.token, approved: true, scope: 'session' as const, subject: `delete-below:${MOUNT}/reports` }
    expect(await registry.resolve(decision, SOURCES.cli)).toEqual({ ok: true, asked: { rule: 'write_scope', subject: `delete:${MOUNT}/reports` }, granted: `delete-below:${MOUNT}/reports`, save: 'saved' })
    expect(grants.list()).toMatchObject([{ rule: 'write_scope', subject: `delete-below:${MOUNT}/reports`, scope: 'session', sessionId: 's1' }])
    expect(await registry.resolve(decision, SOURCES.cli)).toMatchObject({ ok: true, repeated: true })
    expect(await registry.resolve({ ...decision, subject: undefined }, SOURCES.cli)).toEqual({ ok: false, code: 'conflicting_decision', reason: 'Approval already has a different decision' })
  })

  it('grants the ask\'s own subject where the decision names none, or names it', async () => {
    const { registry, grants } = queue()
    const requests = (await registry.ask({ tool: 'fs_delete', sessionId: 's1', asks: [WIDE, { ...WIDE, subject: `delete:${MOUNT}/other`, widerSubject: `delete-below:${MOUNT}/other` }], call: CALL })).requests
    expect((await registry.resolve({ token: requests[0]!.token, approved: true, scope: 'always' }, SOURCES.cli)).ok).toBe(true)
    expect((await registry.resolve({ token: requests[1]!.token, approved: true, scope: 'always', subject: `delete:${MOUNT}/other` }, SOURCES.cli)).ok).toBe(true)
    expect(grants.list().map(grant => grant.subject).sort()).toEqual([`delete:${MOUNT}/other`, `delete:${MOUNT}/reports`])
  })

  it.each([
    [{ approved: true, scope: 'once' as const, subject: `delete-below:${MOUNT}/reports` }, 'scope_forbidden', 'A once approval covers the one call that asked; grant the folder and its subfolders for the session or always instead'],
    [{ approved: true, scope: 'session' as const, subject: 'delete-below:/' }, 'scope_not_offered', `This ask grants delete:${MOUNT}/reports or delete-below:${MOUNT}/reports, not delete-below:/`],
    [{ approved: true, scope: 'session' as const, subject: MOUNT }, 'scope_not_offered', `This ask grants delete:${MOUNT}/reports or delete-below:${MOUNT}/reports, not ${MOUNT}`],
    [{ approved: false, scope: 'once' as const, subject: `delete-below:${MOUNT}/reports` }, 'statement_invalid', 'A denial names no subject: it denies the ask\'s own'],
  ] as const)('refuses %o, granting nothing', async (decision, code, reason) => {
    const { registry, grants } = queue()
    const [request] = (await registry.ask({ tool: 'fs_delete', sessionId: 's1', asks: [WIDE], call: CALL })).requests
    expect(await registry.resolve({ token: request!.token, ...decision }, SOURCES.cli)).toEqual({ ok: false, code, reason })
    expect(grants.list()).toEqual([])
    expect(registry.pending()).toHaveLength(1)
  })

  it('refuses a wider subject an ask never offered', async () => {
    const { registry } = queue()
    const { widerSubject: _none, ...narrow } = WIDE
    const [request] = (await registry.ask({ tool: 'fs_delete', sessionId: 's1', asks: [narrow], call: CALL })).requests
    expect(request).not.toHaveProperty('widerSubject')
    expect(await registry.resolve({ token: request!.token, approved: true, scope: 'session', subject: `delete-below:${MOUNT}/reports` }, SOURCES.cli)).toEqual({ ok: false, code: 'scope_not_offered', reason: `This ask grants delete:${MOUNT}/reports, not delete-below:${MOUNT}/reports` })
  })
})

/** A terminal that answers each question with `choice`. */
function answering(choice: string): RequestCli {
  return async request => ({ status: 'answered', requestId: request.id, answer: { choice } })
}

describe('the approval service', () => {
  it('names the wider subject in the question it asks', async () => {
    const { registry } = queue()
    const [approval] = (await registry.ask({ tool: 'fs_delete', sessionId: 's1', asks: [WIDE], call: CALL })).requests
    expect(questionFor({ approval: approval!, workspaceId: 'w1', context: { correlationId: 'c1', sessionId: 's1' } }).action.details).toMatchObject({ subject: `delete:${MOUNT}/reports`, wider: `delete-below:${MOUNT}/reports` })
  })

  it.each([['session_below', 'session'], ['always_below', 'always']] as const)('grants the folder and its subfolders for the choice %s', async (choice, scope) => {
    const { registry, grants } = queue()
    const service = approvalServiceWithTerminal({ registry, workspaceId: 'w1', serverId: 'node', graceMs: 15_000, interaction: fixedInteraction({ requestCli: answering(choice), hold: 'prompt' }) })
    const result = await service.request({ sessionId: 's1', requestId: 'r1', tool: 'fs_delete', asks: [WIDE], call: CALL })
    expect(result.settled).toBe(true)
    expect(grants.list()).toMatchObject([{ subject: `delete-below:${MOUNT}/reports`, scope }])
    await service.close()
  })

  it('denies a wider choice where the ask offers no wider subject', async () => {
    const { registry, grants } = queue()
    const { widerSubject: _none, ...narrow } = WIDE
    const service = approvalServiceWithTerminal({ registry, workspaceId: 'w1', serverId: 'node', graceMs: 15_000, interaction: fixedInteraction({ requestCli: answering('always_below'), hold: 'prompt' }) })
    const result = await service.request({ sessionId: 's1', requestId: 'r1', tool: 'fs_delete', asks: [narrow], call: CALL })
    expect(grants.list()).toEqual([])
    expect(registry.wasDenied(result.approvals.map(request => request.token))).toBe(true)
    await service.close()
  })

  it('takes no subject from a device\'s signed decision, whose challenge named none but the ask\'s own', async () => {
    const { registry, grants } = queue()
    const service = approvalServiceWithTerminal({ registry, workspaceId: 'w1', serverId: 'node', graceMs: 15_000, interaction: fixedInteraction({ requestCli: answering('none'), hold: 'prompt' }) })
    const [request] = (await registry.ask({ tool: 'fs_delete', sessionId: 's1', asks: [WIDE], call: CALL })).requests
    const result = await service.decide(deviceDecision({ token: request!.token, approved: true, scope: 'session', subject: WIDE.widerSubject, challenge: 'a'.repeat(64) }, { keyId: 'device' }))
    expect(result).toMatchObject({ status: 'refused', step: 'decision', error: { message: expect.stringContaining('buckle approve --below') } })
    expect(grants.list()).toEqual([])
    await service.close()
  })
})

const runtimes: CoreRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
})

describe('fs_delete outside the workspace\'s folder, end to end', () => {
  it('asks with both subjects, and a session grant of the folder and its subfolders lets later deletes there run', async () => {
    const root = scratch()
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(join(outside, 'sub'), { recursive: true })
    mkdirSync(join(root, 'other'))
    for (const file of ['outside/a.txt', 'outside/sub/b.txt', 'other/c.txt']) writeFileSync(join(root, file), file)
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '1' })
    const runtime = await createRuntime({ config })
    runtimes.push(runtime)
    const call = (args: JsonObject, requestId: string, tokens: string[] = []): Promise<InvokeResponse> => runtime.invoke({ request: { requestId, tool: 'fs_delete', args, approvalTokens: tokens }, sessionId: 'agent' })

    const asked = await call({ paths: [join(outside, 'a.txt')] }, 'outside-1')
    expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ rule: 'write_scope', subject: `delete:${outside}`, widerSubject: `delete-below:${outside}`, offeredScopes: ['once', 'session', 'always'] }] })
    const token = asked.outcome === 'approval_required' ? asked.approvals[0]!.token : ''
    expect(await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'session', subject: `delete-below:${outside}` }, source: SOURCES.cli })).toMatchObject({ ok: true, granted: `delete-below:${outside}` })
    expect(await call({ paths: [join(outside, 'a.txt')] }, 'outside-1', [token])).toMatchObject({ outcome: 'ok', output: { removed: 1 } })
    expect(await call({ paths: [join(outside, 'sub/b.txt')] }, 'outside-2')).toMatchObject({ outcome: 'ok', output: { removed: 1 } })
    expect(existsSync(join(outside, 'sub/b.txt'))).toBe(false)
    expect(await call({ paths: [join(root, 'other/c.txt')] }, 'outside-3')).toMatchObject({ outcome: 'approval_required', approvals: [{ subject: `delete:${join(root, 'other')}` }] })
  })
})

describe('fs_move of a file out of a folder outside the workspace\'s folder', () => {
  async function setup() {
    const root = scratch()
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    writeFileSync(join(outside, 'rename.txt'), 'rename')
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '1' })
    const runtime = await createRuntime({ config })
    runtimes.push(runtime)
    for (const subject of [runtime.paths().root, outside]) await runtime.grants.grant({ sessionId: 'agent', rule: 'write_scope', subject, scope: 'session' })
    await runtime.grants.grant({ sessionId: 'agent', rule: 'read_scope', subject: outside, scope: 'session' })
    const call = (tool: string, args: JsonObject, requestId: string, tokens: string[] = []): Promise<InvokeResponse> => runtime.invoke({ request: { requestId, tool, args, approvalTokens: tokens }, sessionId: 'agent' })
    return { workspace, outside, runtime, call }
  }

  it('asks as a delete in that folder when the file lands inside the workspace, which would free its delete', async () => {
    const { workspace, outside, call } = await setup()
    const asked = await call('fs_move', { from: join(outside, 'keep.txt'), to: 'keep.txt' }, 'move-in')
    expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ rule: 'write_scope', subject: `delete:${outside}`, widerSubject: `delete-below:${outside}` }] })
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
    expect(existsSync(join(workspace, 'keep.txt'))).toBe(false)
  })

  it('runs once a person approved that delete, and the file is then the workspace\'s to delete', async () => {
    const { workspace, outside, runtime, call } = await setup()
    const asked = await call('fs_move', { from: join(outside, 'keep.txt'), to: 'keep.txt' }, 'move-in')
    const token = asked.outcome === 'approval_required' ? asked.approvals[0]!.token : ''
    expect((await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, source: SOURCES.cli })).ok).toBe(true)
    expect(await call('fs_move', { from: join(outside, 'keep.txt'), to: 'keep.txt' }, 'move-in', [token])).toMatchObject({ outcome: 'ok' })
    expect(await call('fs_delete', { paths: ['keep.txt'] }, 'delete-in')).toMatchObject({ outcome: 'ok', output: { removed: 1 } })
    expect(existsSync(join(workspace, 'keep.txt'))).toBe(false)
  })

  it('does not ask for a rename that stays outside, nor for a file moved out of the workspace', async () => {
    const { workspace, outside, call } = await setup()
    writeFileSync(join(workspace, 'mine.txt'), 'mine')
    expect(await call('fs_move', { from: join(outside, 'rename.txt'), to: join(outside, 'renamed.txt') }, 'rename')).toMatchObject({ outcome: 'ok' })
    expect(await call('fs_move', { from: 'mine.txt', to: join(outside, 'mine.txt') }, 'move-out')).toMatchObject({ outcome: 'ok' })
    expect(existsSync(join(outside, 'renamed.txt'))).toBe(true)
    expect(existsSync(join(outside, 'mine.txt'))).toBe(true)
  })
})
