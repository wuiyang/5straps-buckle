import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'
import { grantsPath, type BuckleConfig } from '../common/runtime/config.js'
import { NO_INTERACTION, type Interaction } from '../common/runtime/interaction.js'
import { createApprovalRegistry, type ApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { SOURCES } from '../common/types/ports/approval-source.js'
import type { GrantStore } from '../common/types/ports/grant-store.js'
import { settleAuditLogs } from './support/action-log-writer.js'
import { fixedInteraction } from './support/interaction.js'
import { holdLockInProcess, killHolder } from './support/lock-holder.js'
import { configFromEnvironment } from './support/workspace-config.js'

// A person may skip the save of an approval whose grant did not save: its lasting part is given up for good. Skip and the
// settling pass each run under the approvals lock, so one goes first: a skip first leaves nothing for the pass to write,
// and a pass first leaves a grant the skip removes by the id its decision kept.

// A rename onto `path` waits for `until`, once `reached` says it began.
const holding = vi.hoisted(() => ({ path: undefined as string | undefined, reached: () => {}, until: Promise.resolve() }))
// The renames onto `rename` to fail: the first `skip` pass, then `count` fail.
const failing = vi.hoisted(() => ({ rename: undefined as string | undefined, skip: 0, count: 1 }))
vi.mock('../common/adapters/replace-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../common/adapters/replace-file.js')>()
  return {
    ...actual,
    replaceFile: async (from: string, to: string, io?: Parameters<typeof actual.replaceFile>[2]) => {
      if (holding.path === to) {
        holding.path = undefined
        holding.reached()
        await holding.until
      }
      if (failing.rename === to && failing.skip > 0) failing.skip -= 1
      else if (failing.rename === to) {
        failing.count -= 1
        if (failing.count === 0) failing.rename = undefined
        throw Object.assign(new Error('Injected write failure'), { code: 'EIO' })
      }
      return actual.replaceFile(from, to, io)
    },
  }
})

const roots: string[] = []
const runtimes: CoreRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  Object.assign(holding, { path: undefined, reached: () => {}, until: Promise.resolve() })
  Object.assign(failing, { rename: undefined, skip: 0, count: 1 })
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const CALL = { arguments: {}, cwd: '/', description: null, complete: true as const }
const cli = SOURCES.cli

function files(): { approvals: string; store: GrantStore } {
  const root = mkdtempSync(join(tmpdir(), 'buckle-save-skip-'))
  roots.push(root)
  return { approvals: join(root, 'approvals.json'), store: createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'workspace-id' }) }
}

const denied = (path: string) => Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES' })

/** The store, with its first `grant` writes and `revoke`s failing as a locked grants file does. */
function flaky(store: GrantStore, fails: { grant?: number; revoke?: number }): GrantStore & { revokes: string[] } {
  const left = { grant: fails.grant ?? 0, revoke: fails.revoke ?? 0 }
  const revokes: string[] = []
  return {
    ...store,
    revokes,
    grant: async (input) => {
      if (left.grant > 0) { left.grant -= 1; throw denied('/state/grants.json') }
      return store.grant(input)
    },
    revoke: async (id) => {
      revokes.push(id)
      if (left.revoke > 0) { left.revoke -= 1; throw denied('/state/grants.json') }
      return store.revoke(id)
    },
  }
}

async function askIn(registry: ApprovalRegistry, requestId: string, input: { rule?: 'write_scope' | 'sensitive_path'; subject?: string } = {}): Promise<string> {
  const { rule = 'write_scope', subject = `/outside/${requestId}` } = input
  const { requests } = await registry.ask({ tool: 'fs_write', sessionId: 's', requestId, asks: [{ kind: 'ask', ...PLAIN_MARKS, rule, subject, reason: 'outside', offeredScopes: ['once', 'session', 'always'] }], call: CALL })
  return requests[0]!.token
}

const sessionApproval = (token: string) => ({ token, approved: true, scope: 'session' as const })

interface KeptGrant { id: string; sessionId: string; rule: 'write_scope'; subject: string; scope: 'session'; save: string; source?: { id: string; kind: string } }
const keptGrant = (approvals: string, token: string): KeptGrant | undefined =>
  (JSON.parse(readFileSync(approvals, 'utf8')) as { resolved: Array<{ decision: { token: string }; grant?: KeptGrant }> }).resolved.find(entry => entry.decision.token === token)?.grant

/** A decision whose grant could not be written: its entry keeps the grant owed. */
async function owedApproval(input: { fails?: { grant?: number; revoke?: number } } = {}) {
  const { approvals, store } = files()
  const grants = flaky(store, { grant: 1, ...input.fails })
  const registry = createApprovalRegistry(grants, approvals)
  const token = await askIn(registry, 'one')
  expect(await registry.resolve(sessionApproval(token), cli)).toMatchObject({ ok: true, save: 'owed', saveError: 'permission denied' })
  return { approvals, store, grants, registry, token, kept: keptGrant(approvals, token)! }
}

/** A gate a promise waits at until it opens, saying when the first one reached it. */
function gate() {
  let reached!: () => void
  let open!: () => void
  return { reached: new Promise<void>((resolve) => { reached = resolve }), until: new Promise<void>((resolve) => { open = resolve }), reach: () => reached(), open: () => open() }
}

const settled = async <T>(work: Promise<T>, ms = 100): Promise<boolean> =>
  Promise.race([work.then(() => true, () => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), ms))])

describe('a skip before the settling pass', () => {
  it('gives the grant up for good: the entry reads skipped, and no opening, retry, later decision, or restart writes it', async () => {
    const { approvals, store, registry, token, kept } = await owedApproval()

    expect(await registry.skipSave({ token, source: cli })).toEqual({ ok: true })
    expect(keptGrant(approvals, token)).toEqual({ ...kept, save: 'skipped' })

    await createApprovalRegistry(store, approvals).recover()
    expect(store.list()).toEqual([])
    const retried = await registry.resolve(sessionApproval(token), cli)
    expect(retried).toMatchObject({ ok: true, repeated: true, save: 'skipped' })
    expect(retried).not.toHaveProperty('saveError')
    const later = await askIn(registry, 'two')
    expect(await registry.resolve({ token: later, approved: true, scope: 'once' }, cli)).toMatchObject({ ok: true })
    await createApprovalRegistry(store, approvals).recover()
    expect(store.list()).toEqual([])
    expect(keptGrant(approvals, token)).toEqual({ ...kept, save: 'skipped' })
  })

  it('holds a settling pass off until the skip is recorded, so the pass writes nothing', async () => {
    const { approvals, store, registry, token } = await owedApproval()
    const recording = gate()
    Object.assign(holding, { path: approvals, reached: recording.reach, until: recording.until })

    const skipping = registry.skipSave({ token, source: cli })
    await recording.reached
    const recovering = createApprovalRegistry(store, approvals).recover()
    expect(await settled(recovering)).toBe(false)
    recording.open()
    expect(await skipping).toEqual({ ok: true })
    await recovering

    expect(store.list()).toEqual([])
    expect(keptGrant(approvals, token)?.save).toBe('skipped')
  })

  it('skips while the grant store cannot be written, since the grant it would remove was never written', async () => {
    const { approvals, store, grants, registry, token } = await owedApproval({ fails: { grant: 2, revoke: 2 } })

    expect(await registry.skipSave({ token, source: cli })).toEqual({ ok: true })
    expect(grants.revokes).toEqual([])
    expect(keptGrant(approvals, token)?.save).toBe('skipped')
    await createApprovalRegistry(store, approvals).recover()
    expect(store.list()).toEqual([])
  })
})

describe('a settling pass before the skip', () => {
  it('leaves a grant another process saved first, which the skip removes by the id its decision kept, saying it had saved', async () => {
    const { approvals, store, registry, token, kept } = await owedApproval()
    await createApprovalRegistry(store, approvals).recover()
    expect(store.list().map(grant => grant.id)).toEqual([kept.id])

    expect(await registry.skipSave({ token, source: cli })).toEqual({ ok: true, removed: true })
    expect(store.list()).toEqual([])
    expect(keptGrant(approvals, token)).toEqual({ ...kept, save: 'skipped' })
    await createApprovalRegistry(store, approvals).recover()
    expect(store.list()).toEqual([])
  })

  it('waits for a pass that holds the approvals lock, then removes what it wrote', async () => {
    const { approvals, store, registry, token, kept } = await owedApproval()
    const writing = gate()
    const settler = createApprovalRegistry({ ...store, grant: async (input) => { writing.reach(); await writing.until; return store.grant(input) } }, approvals)

    const recovering = settler.recover()
    await writing.reached
    const skipping = registry.skipSave({ token, source: cli })
    expect(await settled(skipping)).toBe(false)
    writing.open()
    await recovering
    expect(await skipping).toEqual({ ok: true, removed: true })

    expect(store.list()).toEqual([])
    expect(keptGrant(approvals, token)).toEqual({ ...kept, save: 'skipped' })
  })

  it('reads the ledger under the lock another process held while it settled, and removes the grant that process saved', async () => {
    const { approvals, store, registry, token, kept } = await owedApproval()
    const holder = await holdLockInProcess(`${approvals}.lock.sqlite`)
    let skipping: Promise<unknown> | undefined
    try {
      skipping = registry.skipSave({ token, source: cli })
      expect(await settled(skipping, 200)).toBe(false)
      // The holder's settling pass: the grant written under its kept id, then its entry committed as saved.
      const { id, sessionId, rule, subject, scope } = kept
      await store.grant({ id, sessionId, rule, subject, scope })
      const ledger = JSON.parse(readFileSync(approvals, 'utf8')) as { resolved: Array<{ grant?: { save: string } }> }
      for (const entry of ledger.resolved) if (entry.grant) entry.grant.save = 'saved'
      writeFileSync(approvals, JSON.stringify(ledger))
    } finally {
      await killHolder(holder)
    }

    expect(await skipping).toEqual({ ok: true, removed: true })
    expect(store.list()).toEqual([])
    expect(keptGrant(approvals, token)?.save).toBe('skipped')
  })

  it('removes a grant written before its commit was lost, which the entry still reads as owed', async () => {
    const { approvals, store } = files()
    const registry = createApprovalRegistry(store, approvals)
    const token = await askIn(registry, 'one')
    Object.assign(failing, { rename: approvals, skip: 1, count: 2 })
    expect(await registry.resolve(sessionApproval(token), cli)).toMatchObject({ ok: true })
    expect(keptGrant(approvals, token)?.save).toBe('owed')
    expect(store.list()).toHaveLength(1)

    expect(await registry.skipSave({ token, source: cli })).toEqual({ ok: true, removed: true })
    expect(store.list()).toEqual([])
    await createApprovalRegistry(store, approvals).recover()
    expect(store.list()).toEqual([])
  })

  it('records the skip and says so, naming no path, when the grant it would remove cannot be removed, and a skip again removes it', async () => {
    const { approvals, store, registry, token, grants } = await owedApproval({ fails: { revoke: 1 } })
    await createApprovalRegistry(store, approvals).recover()

    const failed = await registry.skipSave({ token, source: cli }).then(() => undefined, (error: unknown) => error)
    expect(failed).toBeInstanceOf(Error)
    expect((failed as Error).message).toBe('Skipped, but its grant could not be removed: permission denied; skip again to remove it')
    expect(keptGrant(approvals, token)?.save).toBe('skipped')
    expect(store.list()).toHaveLength(1)
    await createApprovalRegistry(store, approvals).recover()
    expect(store.list()).toHaveLength(1)

    expect(await registry.skipSave({ token, source: cli })).toEqual({ ok: true, repeated: true, removed: true })
    expect(grants.revokes).toHaveLength(2)
    expect(store.list()).toEqual([])
  })
})

describe('who may skip, and what', () => {
  it('answers a skip sent again as repeated', async () => {
    const { registry, token } = await owedApproval()
    expect(await registry.skipSave({ token, source: cli })).toEqual({ ok: true })
    expect(await registry.skipSave({ token, source: cli })).toEqual({ ok: true, repeated: true })
  })

  it('keeps the source that recorded the decision on its grant, and refuses a skip from any other', async () => {
    const { approvals, registry, token, kept } = await owedApproval()
    expect(kept.source).toEqual({ id: 'cli', kind: 'cli' })

    for (const source of [SOURCES.terminal, SOURCES.forms, { id: 'cli', kind: 'backend' as const }]) {
      expect(await registry.skipSave({ token, source })).toMatchObject({ ok: false, code: 'approver_not_allowed' })
    }
    expect(keptGrant(approvals, token)?.save).toBe('owed')
  })

  it('refuses a skip of a decision that made no lasting grant, of an ask still waiting, and of a token it does not know', async () => {
    const { store, approvals } = files()
    const registry = createApprovalRegistry(store, approvals)
    const once = await askIn(registry, 'once')
    expect(await registry.resolve({ token: once, approved: true, scope: 'once' }, cli)).toMatchObject({ ok: true })
    const denial = await askIn(registry, 'denial', { rule: 'sensitive_path', subject: 'secret-file:/workspace/.env' })
    expect(await registry.resolve({ token: denial, approved: false, scope: 'session' }, cli)).toMatchObject({ ok: true })
    const waiting = await askIn(registry, 'waiting')

    expect(await registry.skipSave({ token: once, source: cli })).toMatchObject({ ok: false, code: 'conflicting_decision' })
    expect(await registry.skipSave({ token: denial, source: cli })).toMatchObject({ ok: false, code: 'conflicting_decision' })
    expect(await registry.skipSave({ token: waiting, source: cli })).toMatchObject({ ok: false, code: 'unknown_ask' })
    expect(await registry.skipSave({ token: 'not-a-token', source: cli })).toMatchObject({ ok: false, code: 'unknown_ask' })
    expect(store.list()).toEqual([expect.objectContaining({ rule: 'sensitive_path', denied: true })])
  })

  it('has nothing left to skip once a session end dropped the owed grant', async () => {
    const { registry, store, token } = await owedApproval()
    await registry.grants.endSession('s')
    expect(await registry.skipSave({ token, source: cli })).toEqual({ ok: true, repeated: true })
    expect(store.list()).toEqual([])
  })
})

describe('a skip, at the workspace', () => {
  const NOBODY: Interaction = { requestCli: NO_INTERACTION.requestCli, hold: 'prompt' }

  async function open(config?: BuckleConfig): Promise<{ config: BuckleConfig; runtime: CoreRuntime }> {
    const settings = config ?? setUp()
    const runtime = await createRuntime({ config: settings, interaction: fixedInteraction(NOBODY) })
    runtimes.push(runtime)
    return { config: settings, runtime }
  }

  function setUp(): BuckleConfig {
    const root = mkdtempSync(join(tmpdir(), 'buckle-save-skip-workspace-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(join(workspace, 'one'), { recursive: true })
    mkdirSync(join(root, 'state'), { mode: 0o700 })
    return configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' })
  }

  const write = (runtime: CoreRuntime, path: string, input: { requestId?: string; token?: string } = {}): Promise<InvokeResponse> =>
    runtime.invoke({ request: { requestId: input.requestId ?? `write-${path}`, tool: 'fs_write', args: { path, content: 'a' }, approvalTokens: input.token === undefined ? [] : [input.token] }, sessionId: 's' })
  const tokenOf = (response: InvokeResponse): string => {
    if (response.outcome !== 'approval_required') throw new Error(`expected an ask, got ${response.outcome}`)
    return response.approvals[0]!.token
  }

  async function owedAt(runtime: CoreRuntime, config: BuckleConfig): Promise<string> {
    const token = tokenOf(await write(runtime, 'one/a.md'))
    vi.spyOn(runtime.grants, 'grant').mockRejectedValueOnce(denied(grantsPath(config)))
    expect(await runtime.approvalApi.decide({ source: 'cli', decision: { token, outcome: 'approve', scope: 'session' } })).toMatchObject({ status: 'applied', save: 'owed' })
    return token
  }

  it('keeps the once the call that asked got, so that call runs, while every later call asks, after a restart too', async () => {
    const { config, runtime } = await open()
    const token = await owedAt(runtime, config)

    expect(await runtime.approvalApi.skipSave({ source: 'cli', token })).toEqual({ status: 'skipped' })
    expect(await write(runtime, 'one/a.md', { token })).toMatchObject({ outcome: 'ok' })
    expect((await write(runtime, 'one/b.md')).outcome).toBe('approval_required')
    expect(await runtime.approvalApi.decide({ source: 'cli', decision: { token, outcome: 'approve', scope: 'session' } })).toMatchObject({ status: 'repeated', save: 'skipped' })

    const { runtime: reopened } = await open(config)
    expect(reopened.grants.list()).toEqual([])
    expect((await write(reopened, 'one/c.md')).outcome).toBe('approval_required')
  })

  it('removes the grant a second process wrote as it opened, so its next call asks', async () => {
    const { config, runtime } = await open()
    const token = await owedAt(runtime, config)
    const { runtime: second } = await open(config)
    expect(await write(second, 'one/b.md')).toMatchObject({ outcome: 'ok' })

    expect(await runtime.approvalApi.skipSave({ source: 'cli', token })).toEqual({ status: 'skipped', removed: true })
    expect((await write(second, 'one/c.md')).outcome).toBe('approval_required')
  })

  it('refuses a skip from a route that did not record the decision', async () => {
    const { config, runtime } = await open()
    const token = tokenOf(await write(runtime, 'one/a.md'))
    vi.spyOn(runtime.grants, 'grant').mockRejectedValueOnce(denied(grantsPath(config)))
    expect(await runtime.approvalService.answer({ decision: sessionApproval(token), source: SOURCES.terminal })).toMatchObject({ ok: true, save: 'owed' })

    expect(await runtime.approvalApi.skipSave({ source: 'cli', token })).toEqual({ status: 'refused', error: { code: 'approver_not_allowed', message: expect.stringContaining('terminal'), retryable: false } })
  })
})
