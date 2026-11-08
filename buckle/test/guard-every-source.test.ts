import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalDecision, ApprovalRequest } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { guardDecision, type DecisionClaim, type LedgerView } from '../common/domain/approval/decision-guard.js'
import { TODAYS_ROUTES, type RecordedRoute } from '../common/domain/approval/routes.js'
import { createPathView } from '../common/domain/path-view.js'
import { FILE_FLOOR_MARKS, PLAIN_MARKS, type AskMarks, type GrantLookup, type PermissionDecision } from '../common/domain/permission/decision.js'
import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { FLOOR_POLICY, type FloorPolicy } from '../common/domain/permission/floor-policy.js'
import { withDangerouslyAllow } from '../common/domain/permission/rules/dangerously-allow.js'
import type { DangerouslyAllowMode } from '../common/types/ports/dangerously-allow-store.js'
import { createDestructivePathRule } from '../common/domain/permission/rules/destructive-path-rule.js'
import type { ResolvedEffect } from '../common/domain/effect.js'
import { grantLookup } from '../common/services/approvals/approval-gate.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { SOURCES, type ApprovalSource } from '../common/types/ports/approval-source.js'

// The decision guard's checks for every source, each a table test against the guard alone. Today's sources pass each
// one as before. The file floor's always stays as today, behind a floor policy switch that turns the safer default on;
// the dangerously-allow switch's reach over floor asks is its mode's.

const NOW = Date.parse('2026-11-07T10:00:00.000Z')
const request: ApprovalRequest = { token: 't-1', rule: 'write_scope', subject: 'delete:/outside', reason: 'Deleting asks a person', tool: 'fs_delete', offeredScopes: ['once', 'session', 'always'], expiresAt: '2026-11-07T10:10:00.000Z', widerSubject: 'delete-below:/outside' }
const approve = (scope: ApprovalDecision['scope'] = 'once', extra: Partial<ApprovalDecision> = {}): ApprovalDecision => ({ token: 't-1', approved: true, scope, ...extra })
const deny = (): ApprovalDecision => ({ token: 't-1', approved: false, scope: 'once' })
const claim = (source: ApprovalSource, decision: ApprovalDecision): DecisionClaim => ({ decision, source })
const ledger = (input: { marks?: AskMarks; routes?: readonly RecordedRoute[] } = {}): LedgerView => ({ waiting: { request, complete: true, challenges: [], marks: input.marks ?? PLAIN_MARKS, routes: input.routes ?? TODAYS_ROUTES } })
const guard = (input: { claim: DecisionClaim; ledger?: LedgerView; policy?: FloorPolicy }) => guardDecision({ claim: input.claim, ledger: input.ledger ?? ledger(), now: NOW, live: { forms: true }, ...(input.policy ? { policy: input.policy } : {}) })
const PERSONS = ['terminal', 'cli', 'forms', 'devices'] as const

describe('routing by the ask\'s recorded routes', () => {
  it('reads an ask recorded without routes as today\'s set: the terminal, forms, and devices decide, and the sealed envelope only denies', () => {
    expect(TODAYS_ROUTES).toEqual([{ id: 'terminal', role: 'decide' }, { id: 'forms', role: 'decide' }, { id: 'devices', role: 'decide' }, { id: 'sealed', role: 'notify' }])
    for (const source of PERSONS) expect(guard({ claim: claim(SOURCES[source], approve()) })).toEqual({ ok: true, apply: {} })
    expect(guard({ claim: claim(SOURCES.sealed, deny()) })).toEqual({ ok: true, apply: {} })
  })

  it('refuses a source no route of the ask names, and lets a notify route\'s source deny alone', () => {
    const routes: RecordedRoute[] = [{ id: 'terminal', role: 'decide' }, { id: 'forms', role: 'notify' }]
    expect(guard({ claim: claim(SOURCES.devices, approve()), ledger: ledger({ routes }) })).toEqual({ ok: false, code: 'approver_not_allowed', reason: 'This ask was not routed to devices' })
    expect(guard({ claim: claim(SOURCES.devices, deny()), ledger: ledger({ routes }) })).toMatchObject({ ok: false, code: 'approver_not_allowed' })
    expect(guard({ claim: claim(SOURCES.forms, approve()), ledger: ledger({ routes }) })).toEqual({ ok: false, code: 'approver_not_allowed', reason: 'forms is only told of this ask, so it may deny it and never approve it' })
    expect(guard({ claim: claim(SOURCES.forms, deny()), ledger: ledger({ routes }) })).toEqual({ ok: true, apply: {} })
  })

  it('counts the person at the node and the judge as routed to every ask, whatever routes it recorded', () => {
    expect(guard({ claim: claim(SOURCES.cli, approve()), ledger: ledger({ routes: [] }) })).toEqual({ ok: true, apply: {} })
    expect(guard({ claim: claim(SOURCES.judge, approve()), ledger: ledger({ routes: [] }) })).toEqual({ ok: true, apply: {} })
  })

  it.each(['terminal', 'sealed'])('holds a built-in route for its own kind: a backend that names itself %s is routed nothing', (id) => {
    expect(guard({ claim: claim({ id, kind: 'backend' }, deny()) })).toMatchObject({ ok: false, code: 'approver_not_allowed' })
    expect(guard({ claim: claim({ id, kind: 'backend' }, approve()) })).toMatchObject({ ok: false, code: 'capability_exceeded' })
  })
})

describe('a floor ask', () => {
  it.each(PERSONS)('takes the approval of %s, a person at local or above', (source) => {
    expect(guard({ claim: claim(SOURCES[source], approve()), ledger: ledger({ marks: FILE_FLOOR_MARKS }) })).toEqual({ ok: true, apply: {} })
  })

  it('refuses the decision AI\'s approval, which is no person\'s, and keeps its denial', () => {
    expect(guard({ claim: claim(SOURCES.judge, approve()), ledger: ledger({ marks: FILE_FLOOR_MARKS }) })).toEqual({ ok: false, code: 'assurance_too_low', reason: 'A person decides a floor ask: approve it at the node, or with an enrolled key' })
    expect(guard({ claim: claim(SOURCES.judge, deny()), ledger: ledger({ marks: FILE_FLOOR_MARKS }) })).toEqual({ ok: true, apply: {} })
    expect(guard({ claim: claim(SOURCES.judge, approve()), ledger: ledger({ marks: { floor: false, destructive: true } }) })).toEqual({ ok: true, apply: {} })
  })
})

describe('scope always on a file floor ask', () => {
  it('stays open where offered, as today, from every person', () => {
    for (const source of ['terminal', 'cli', 'forms'] as const) expect(guard({ claim: claim(SOURCES[source], approve('always')), ledger: ledger({ marks: FILE_FLOOR_MARKS }) })).toEqual({ ok: true, apply: {} })
  })

  it('is refused from every source with the switch turned the other way, while a session approval still passes', () => {
    const policy: FloorPolicy = { ...FLOOR_POLICY, alwaysAtFloor: false }
    for (const source of ['terminal', 'cli', 'forms'] as const) {
      expect(guard({ claim: claim(SOURCES[source], approve('always')), ledger: ledger({ marks: FILE_FLOOR_MARKS }), policy })).toEqual({ ok: false, code: 'scope_forbidden', reason: 'A destructive ask is approved once or for the session, never always' })
      expect(guard({ claim: claim(SOURCES[source], approve('session')), ledger: ledger({ marks: FILE_FLOOR_MARKS }), policy })).toEqual({ ok: true, apply: {} })
    }
    expect(guard({ claim: claim(SOURCES.cli, approve('always')), policy })).toEqual({ ok: true, apply: {} })
  })
})

describe('scope always on a destructive command', () => {
  // A command's ask never offers always; this one does, as a backend or an earlier build might have recorded it.
  const command: ApprovalRequest = { token: 't-1', rule: 'destructive_command', subject: 'rm -rf build', reason: 'Deletes a folder', tool: 'shell_exec', offeredScopes: ['once', 'session', 'always'], expiresAt: request.expiresAt }
  const asked = (marks: AskMarks): LedgerView => ({ waiting: { request: command, complete: true, challenges: [], marks, routes: TODAYS_ROUTES } })
  const SOURCE_REFUSALS = [...PERSONS.map(source => [source, 'scope_forbidden'] as const), ['judge', 'assurance_too_low'], ['sealed', 'capability_exceeded']] as const

  it.each(SOURCE_REFUSALS)('is refused from %s under today\'s floor policy, though the ask offers it', (source, code) => {
    for (const marks of [{ floor: true, destructive: true }, { floor: false, destructive: true }]) {
      expect(guard({ claim: claim(SOURCES[source], approve('always')), ledger: asked(marks) })).toMatchObject({ ok: false, code })
    }
  })

  it.each(PERSONS)('still takes once and the session from %s', (source) => {
    for (const scope of ['once', 'session'] as const) expect(guard({ claim: claim(SOURCES[source], approve(scope)), ledger: asked({ floor: false, destructive: true }) })).toEqual({ ok: true, apply: {} })
  })
})

describe('a wider subject', () => {
  it.each(['terminal', 'cli'] as const)('is granted to %s, at the node', (source) => {
    expect(guard({ claim: claim(SOURCES[source], approve('session', { subject: 'delete-below:/outside' })) })).toEqual({ ok: true, apply: { wider: 'delete-below:/outside' } })
  })

  it.each(['forms', 'devices'] as const)('is refused to %s', (source) => {
    expect(guard({ claim: claim(SOURCES[source], approve('session', { subject: 'delete-below:/outside' })) })).toEqual({ ok: false, code: 'scope_forbidden', reason: 'Only the node\'s terminal and buckle approve grant a folder and its subfolders' })
  })
})

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('the ledger hands the guard each ask\'s marks and today\'s routes', () => {
  it('refuses the decision AI\'s once on a floor ask and takes it on a plain one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-guard-sources-'))
    roots.push(root)
    const registry = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'w-1' }), join(root, 'approvals.json'), 15_000)
    const asked = (marks: AskMarks): Extract<PermissionDecision, { kind: 'ask' }> => ({ kind: 'ask', ...marks, rule: 'destructive_command', subject: 'python3 job.py', reason: 'asks', offeredScopes: ['once', 'session'] })
    const call = { arguments: { command: 'python3' }, cwd: '/w', description: null, effects: [], complete: true as const }
    const [floor, plain] = (await registry.ask({ tool: 'shell_exec', sessionId: 's', asks: [asked(FILE_FLOOR_MARKS), { ...asked(PLAIN_MARKS), subject: 'python3 other.py' }], call })).requests
    expect(await registry.resolve({ token: floor!.token, approved: true, scope: 'once' }, SOURCES.judge)).toMatchObject({ ok: false, code: 'assurance_too_low' })
    expect(await registry.resolve({ token: plain!.token, approved: true, scope: 'once' }, SOURCES.judge)).toMatchObject({ ok: true })
    expect(await registry.resolve({ token: floor!.token, approved: false, scope: 'once' }, SOURCES.sealed)).toMatchObject({ ok: true })
  })
})

const WORKSPACE = '/work/project'
const removed = (path: string): ResolvedEffect => ({ kind: 'delete_path', path, directory: path.slice(0, path.lastIndexOf('/')) || '/', floor: true })
const NONE: GrantLookup = { subjectsFor: () => [] }

describe('the file floor\'s offered scopes', () => {
  const floor = (policy?: FloorPolicy) => createPermissionEngine([createDestructivePathRule({ paths: createPathView({ root: WORKSPACE, mount: null }), strict: false, deletes: { inWorkspace: 'ask', massLimit: 100 }, ...(policy ? { policy } : {}) })])

  it('offers always, as today', () => {
    expect(floor().evaluate({ tool: 'fs_delete', effects: [removed(`${WORKSPACE}/a.txt`)], grants: NONE })).toMatchObject({ kind: 'ask', asks: [{ offeredScopes: ['once', 'session', 'always'] }] })
  })

  it('offers once and the session alone with the switch turned the other way', () => {
    expect(floor({ ...FLOOR_POLICY, alwaysAtFloor: false }).evaluate({ tool: 'fs_delete', effects: [removed(`${WORKSPACE}/a.txt`)], grants: NONE })).toMatchObject({ kind: 'ask', asks: [{ offeredScopes: ['once', 'session'] }] })
  })
})

describe('a grant held on the file floor', () => {
  const OFF: FloorPolicy = { ...FLOOR_POLICY, alwaysAtFloor: false }
  const floor = (policy?: FloorPolicy) => createPermissionEngine([createDestructivePathRule({ paths: createPathView({ root: WORKSPACE, mount: null }), strict: false, deletes: { inWorkspace: 'ask', massLimit: 100 }, home: '/home/owner', ...(policy ? { policy } : {}) })])
  const inside = { tool: 'fs_delete', effects: [removed(`${WORKSPACE}/a.txt`)] }
  const outside = { tool: 'fs_delete', effects: [removed('/srv/data/old.csv')] }

  async function held(scope: 'session' | 'always') {
    const root = mkdtempSync(join(tmpdir(), 'buckle-floor-grants-'))
    roots.push(root)
    const store = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'w-1' })
    for (const subject of [`delete:${WORKSPACE}`, 'delete-below:/srv']) await store.grant({ sessionId: 's-1', rule: 'write_scope', subject, scope })
    return grantLookup({ store, holder: { sessionId: 's-1' }, consumed: [] })
  }

  it('clears the ask when made always, as today', async () => {
    const grants = await held('always')
    for (const call of [inside, outside]) expect(floor().evaluate({ ...call, grants })).toMatchObject({ kind: 'allow' })
  })

  it('no longer clears the ask when made always, with the switch turned the other way', async () => {
    const grants = await held('always')
    for (const call of [inside, outside]) expect(floor(OFF).evaluate({ ...call, grants })).toMatchObject({ kind: 'ask' })
  })

  it('still clears the ask when made for the session, with the switch turned the other way', async () => {
    const grants = await held('session')
    for (const call of [inside, outside]) expect(floor(OFF).evaluate({ ...call, grants })).toMatchObject({ kind: 'allow' })
  })
})

describe('the dangerously-allow switch over floor asks', () => {
  const engine = (mode: DangerouslyAllowMode) => withDangerouslyAllow(createPermissionEngine([createDestructivePathRule({ paths: createPathView({ root: WORKSPACE, mount: null }), strict: false, deletes: { inWorkspace: 'ask', massLimit: 100 } })]), { mode: () => mode, root: () => WORKSPACE })
  const egress: Extract<PermissionDecision, { kind: 'ask' }> = { kind: 'ask', ...PLAIN_MARKS, rule: 'network_egress', subject: 'api.example.com', reason: 'egress', offeredScopes: ['once'] }

  it('lifts a floor ask on, and leaves it to a person at safe', () => {
    expect(engine('on').evaluate({ tool: 'fs_delete', effects: [removed(`${WORKSPACE}/a.txt`)], grants: NONE })).toMatchObject({ kind: 'allow', allowedBy: [`dangerously_allow:on:write_scope:delete:${WORKSPACE}`] })
    expect(engine('safe').evaluate({ tool: 'fs_delete', effects: [removed(`${WORKSPACE}/a.txt`)], grants: NONE })).toMatchObject({ kind: 'ask', asks: [{ rule: 'write_scope', floor: true }] })
  })

  it('at safe, keeps the floor ask of a call alone and lifts its plain one', () => {
    const floorAsk: Extract<PermissionDecision, { kind: 'ask' }> = { kind: 'ask', ...FILE_FLOOR_MARKS, rule: 'write_scope', subject: `delete:${WORKSPACE}`, reason: 'floor', offeredScopes: ['once'] }
    const both = withDangerouslyAllow({ evaluate: () => ({ kind: 'ask', asks: [egress, floorAsk] }) }, { mode: () => 'safe', root: () => WORKSPACE })
    expect(both.evaluate({ tool: 'fs_delete', effects: [], grants: NONE })).toEqual({ kind: 'ask', asks: [floorAsk] })
    const plain = withDangerouslyAllow({ evaluate: () => ({ kind: 'ask', asks: [egress] }) }, { mode: () => 'safe', root: () => WORKSPACE })
    expect(plain.evaluate({ tool: 'web_fetch', effects: [], grants: NONE })).toEqual({ kind: 'allow', allowedBy: ['dangerously_allow:safe:network_egress:api.example.com'] })
  })

  it('leaves the floor policy one switch, alwaysAtFloor, the mode deciding the rest', () => {
    expect(Object.keys(FLOOR_POLICY)).toEqual(['alwaysAtFloor'])
  })
})
