import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isRuntimeError, RuntimeErrorCode } from '@5straps/runtime'
import { acquireFileLock } from '@5straps/runtime/sqlite'
import type { InvokeResponse } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { approvalsPath, grantsPath, type BuckleConfig } from '../common/runtime/config.js'
import { createApprovalRegistry, GRANT_OWED_NOTE } from '../common/services/approvals/approval-registry.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'
import { NO_INTERACTION, type Interaction } from '../common/runtime/interaction.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { runCli } from './support/cli.js'
import { fixedInteraction } from './support/interaction.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { SOURCES } from '../common/types/ports/approval-source.js'
import { auditEntries, settleAuditLogs } from './support/action-log-writer.js'

// The ledger commits a decision first and its grant after, under the approvals lock, and a grant owed at a crash is
// written when the workspace opens again, before any call runs.

// The renames of `rename` to fail: the first `skip` pass, then `count` fail.
const failing = vi.hoisted(() => ({ rename: undefined as string | undefined, skip: 0, count: 1 }))
// A rename onto `path` waits for `until`, once `reached` says it began.
const holding = vi.hoisted(() => ({ path: undefined as string | undefined, reached: () => {}, until: Promise.resolve() }))
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
  Object.assign(failing, { rename: undefined, skip: 0, count: 1 })
  Object.assign(holding, { path: undefined, reached: () => {}, until: Promise.resolve() })
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const NOBODY: Interaction = { requestCli: NO_INTERACTION.requestCli, hold: 'prompt' }

async function open(config?: BuckleConfig): Promise<{ config: BuckleConfig; runtime: CoreRuntime }> {
  const settings = config ?? setUp()
  const runtime = await createRuntime({ config: settings, interaction: fixedInteraction(NOBODY) })
  runtimes.push(runtime)
  return { config: settings, runtime }
}

function setUp(): BuckleConfig {
  const root = mkdtempSync(join(tmpdir(), 'buckle-ledger-split-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, 'one'), { recursive: true })
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  return configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' })
}

const write = (runtime: CoreRuntime, path: string): Promise<InvokeResponse> =>
  runtime.invoke({ request: { requestId: `write-${path}`, tool: 'fs_write', args: { path, content: 'a' }, approvalTokens: [] }, sessionId: 's' })

const tokenOf = (response: InvokeResponse): string => {
  if (response.outcome !== 'approval_required') throw new Error(`expected an ask, got ${response.outcome}`)
  return response.approvals[0]!.token
}

interface Ledger { pending: Array<{ request: { token: string } }>; resolved: Array<{ decision: { token: string }; grant?: { id: string; save: string } }> }
const ledgerOf = (config: BuckleConfig): Ledger => JSON.parse(readFileSync(approvalsPath(config), 'utf8')) as Ledger
const revocationsOf = (config: BuckleConfig): string => join(dirname(approvalsPath(config)), 'approval-revocations.json')
const onDisk = (config: BuckleConfig, token: string) => {
  const ledger = ledgerOf(config)
  const resolved = ledger.resolved.find(entry => entry.decision.token === token)
  return { pending: ledger.pending.some(entry => entry.request.token === token), resolved: resolved !== undefined, owes: resolved?.grant?.save === 'owed' }
}
/** The lasting grant a decision keeps: the id it is written under, and whether it is saved. */
const keptGrant = (config: BuckleConfig, token: string) => {
  const grant = ledgerOf(config).resolved.find(entry => entry.decision.token === token)?.grant
  return grant === undefined ? undefined : { id: grant.id, save: grant.save }
}
const session = (token: string) => ({ decision: { token, approved: true, scope: 'session' as const }, source: SOURCES.cli })

async function approvalsLockHeld(config: BuckleConfig): Promise<boolean> {
  try {
    const lock = await acquireFileLock({ path: `${approvalsPath(config)}.lock.sqlite`, wait: 'none' })
    await lock.release()
    return false
  } catch (error) {
    if (isRuntimeError(error, RuntimeErrorCode.lockBusy)) return true
    throw error
  }
}

describe('a lasting decision', () => {
  it('writes its grant once its resolved entry is on disk, with the approvals lock still held', async () => {
    const { config, runtime } = await open()
    const token = tokenOf(await write(runtime, 'one/a.md'))
    const seen: Array<ReturnType<typeof onDisk> & { locked: boolean }> = []
    const grant = runtime.grants.grant.bind(runtime.grants)
    vi.spyOn(runtime.grants, 'grant').mockImplementation(async (input) => {
      seen.push({ ...onDisk(config, token), locked: await approvalsLockHeld(config) })
      return grant(input)
    })

    expect(await runtime.approvalService.answer(session(token))).toMatchObject({ ok: true })
    expect(seen).toEqual([{ pending: false, resolved: true, owes: true, locked: true }])
    expect(onDisk(config, token)).toEqual({ pending: false, resolved: true, owes: false })
  })

  it('answers as applied with its grant owed when the grant write fails after the ledger commits, and the workspace writes it on opening, before any call runs', async () => {
    const { config, runtime } = await open()
    const token = tokenOf(await write(runtime, 'one/a.md'))
    vi.spyOn(runtime.grants, 'grant').mockRejectedValueOnce(new Error('The process stopped here'))

    expect(await runtime.approvalService.answer(session(token))).toMatchObject({ ok: true, save: 'owed' })
    expect(onDisk(config, token)).toEqual({ pending: false, resolved: true, owes: true })
    expect(runtime.grants.list()).toEqual([])

    const { runtime: reopened } = await open(config)
    expect(reopened.grants.list()).toEqual([expect.objectContaining({ rule: 'write_scope', scope: 'session', sessionId: 's' })])
    expect(onDisk(config, token)).toEqual({ pending: false, resolved: true, owes: false })
    expect(await write(reopened, 'one/b.md')).toMatchObject({ outcome: 'ok' })
  })

  it('writes the owed grant when the same decision is sent again', async () => {
    const { config, runtime } = await open()
    const token = tokenOf(await write(runtime, 'one/a.md'))
    vi.spyOn(runtime.grants, 'grant').mockRejectedValueOnce(new Error('The grants file was busy'))
    expect(await runtime.approvalService.answer(session(token))).toMatchObject({ ok: true, save: 'owed' })

    const repeated = await runtime.approvalService.answer(session(token))
    expect(repeated).toMatchObject({ ok: true, repeated: true, save: 'saved' })
    expect(runtime.grants.list()).toEqual([expect.objectContaining({ rule: 'write_scope', scope: 'session' })])
    expect(onDisk(config, token).owes).toBe(false)
  })

  it('writes no grant when the ledger cannot commit the decision, and its ask still waits', async () => {
    const { config, runtime } = await open()
    const token = tokenOf(await write(runtime, 'one/a.md'))
    failing.rename = approvalsPath(config)

    await expect(runtime.approvalService.answer(session(token))).rejects.toThrow('Injected write failure')
    expect(runtime.grants.list()).toEqual([])
    expect(existsSync(grantsPath(config))).toBe(false)
    expect(onDisk(config, token)).toEqual({ pending: true, resolved: false, owes: false })
  })
  it('writes a grant another decision left owed when a once decision is recorded', async () => {
    const { config, runtime } = await open()
    const owing = tokenOf(await write(runtime, 'one/a.md'))
    vi.spyOn(runtime.grants, 'grant').mockRejectedValueOnce(new Error('The grants file was busy'))
    expect(await runtime.approvalService.answer(session(owing))).toMatchObject({ ok: true, save: 'owed' })

    const once = tokenOf(await write(runtime, 'two.md'))
    expect(await runtime.approvalService.answer({ decision: { token: once, approved: true, scope: 'once' }, source: SOURCES.cli })).toMatchObject({ ok: true })
    expect(onDisk(config, owing).owes).toBe(false)
    expect(runtime.grants.list()).toEqual([expect.objectContaining({ rule: 'write_scope', scope: 'session', sessionId: 's' })])
  })

  it('audits buckle approve as recorded, naming the grant it owes, when the grant cannot be written', async () => {
    const { config, runtime } = await open()
    const token = tokenOf(await write(runtime, 'one/a.md'))
    failing.rename = grantsPath(config)
    let stdout = ''
    const output = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout += String(chunk); return true })
    const approved = await runCli({ argv: ['approve', token, '--scope', 'session'], config, confirm: async () => true }).finally(() => output.mockRestore())

    expect(approved.exitCode).toBe(0)
    expect(stdout).toContain(`Approved ${token} in workspace`)
    expect(stdout).toContain(GRANT_OWED_NOTE)
    expect(onDisk(config, token)).toEqual({ pending: false, resolved: true, owes: true })
    const result = (await auditEntries(runtime.actions, 50)).find(entry => entry.tool === 'cli_approve' && entry.event === 'result')
    expect(result).toMatchObject({ outcome: 'ok', detail: expect.stringContaining(GRANT_OWED_NOTE) })
  })

  it('keeps a revoked grant revoked when the mark its write cleared never reached the disk', async () => {
    const { config, runtime } = await open()
    const token = tokenOf(await write(runtime, 'one/a.md'))
    Object.assign(failing, { rename: approvalsPath(config), skip: 1, count: 2 })

    expect(await runtime.approvalService.answer(session(token))).toEqual(expect.objectContaining({ ok: true }))
    expect(onDisk(config, token).owes).toBe(true)
    const [grant] = runtime.grants.list()
    expect(await runtime.grants.revoke(grant!.id)).toBe(true)
    expect(onDisk(config, token).owes).toBe(false)

    const { runtime: reopened } = await open(config)
    expect(reopened.grants.list()).toEqual([])
    expect((await write(reopened, 'one/b.md')).outcome).toBe('approval_required')
  })

  it('writes a grant again under its own id when a mark outlived it, so buckle grants revoke still finds it', async () => {
    const { config, runtime } = await open()
    const token = tokenOf(await write(runtime, 'one/a.md'))
    Object.assign(failing, { rename: approvalsPath(config), skip: 1, count: 2 })
    expect(await runtime.approvalService.answer(session(token))).toEqual(expect.objectContaining({ ok: true }))
    const [grant] = runtime.grants.list()

    const { runtime: reopened } = await open(config)
    expect(reopened.grants.list().map(record => record.id)).toEqual([grant!.id])
    expect(onDisk(config, token).owes).toBe(false)
  })

  it('keeps a grant revoked while approvals.json was unreadable from coming back once the file is repaired', async () => {
    const { config, runtime } = await open()
    const token = tokenOf(await write(runtime, 'one/a.md'))
    Object.assign(failing, { rename: approvalsPath(config), skip: 1, count: 2 })
    expect(await runtime.approvalService.answer(session(token))).toEqual(expect.objectContaining({ ok: true }))
    expect(onDisk(config, token).owes).toBe(true)
    const [grant] = runtime.grants.list()
    const kept = readFileSync(approvalsPath(config), 'utf8')
    writeFileSync(approvalsPath(config), '{')

    expect(await runtime.grants.revoke(grant!.id)).toBe(true)
    expect(existsSync(revocationsOf(config))).toBe(true)
    writeFileSync(approvalsPath(config), kept)
    const { runtime: reopened } = await open(config)
    expect(reopened.grants.list()).toEqual([])
    expect(onDisk(config, token).owes).toBe(false)
    expect(existsSync(revocationsOf(config))).toBe(false)
  })

  it('drops the session grants a decision left owed when its session ends', async () => {
    const { config, runtime } = await open()
    const token = tokenOf(await write(runtime, 'one/a.md'))
    vi.spyOn(runtime.grants, 'grant').mockRejectedValueOnce(new Error('The grants file was busy'))
    expect(await runtime.approvalService.answer(session(token))).toMatchObject({ ok: true, save: 'owed' })

    await runtime.grants.endSession('s')
    expect(onDisk(config, token).owes).toBe(false)
    const { runtime: reopened } = await open(config)
    expect(reopened.grants.list()).toEqual([])
  })

  it('keeps a session ended while approvals.json was unreadable from getting its owed grants back once the file is repaired', async () => {
    const { config, runtime } = await open()
    const token = tokenOf(await write(runtime, 'one/a.md'))
    vi.spyOn(runtime.grants, 'grant').mockRejectedValueOnce(new Error('The grants file was busy'))
    expect(await runtime.approvalService.answer(session(token))).toMatchObject({ ok: true, save: 'owed' })
    const kept = readFileSync(approvalsPath(config), 'utf8')
    writeFileSync(approvalsPath(config), '{')

    await runtime.grants.endSession('s')
    writeFileSync(approvalsPath(config), kept)
    const { runtime: reopened } = await open(config)
    expect(reopened.grants.list()).toEqual([])
    expect(onDisk(config, token).owes).toBe(false)
  })

  it('refuses a decision while the revocations file is damaged, naming it, so no owed grant is written past a revoke it holds', async () => {
    const { config, runtime } = await open()
    const token = tokenOf(await write(runtime, 'one/a.md'))
    writeFileSync(revocationsOf(config), '{')

    await expect(runtime.approvalService.answer(session(token))).rejects.toThrow('approval-revocations.json')
    expect(onDisk(config, token)).toEqual({ pending: true, resolved: false, owes: false })
    expect(runtime.grants.list()).toEqual([])
  })
})

describe('a revoke or a session end, against the decisions around it', () => {
  const subject = '/outside'
  const askIn = async (registry: ReturnType<typeof createApprovalRegistry>, requestId: string): Promise<string> =>
    (await registry.ask({ tool: 'fs_write', sessionId: 's', requestId, asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: `${subject}/${requestId}`, reason: 'outside', offeredScopes: ['once', 'session'] }], call: { arguments: {}, cwd: '/', description: null, complete: true } })).requests[0]!.token
  const sessionGrant = (token: string) => ({ token, approved: true, scope: 'session' as const })
  const paths = () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-ledger-revoke-'))
    roots.push(root)
    return { approvals: join(root, 'approvals.json'), store: createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'workspace-id' }) }
  }
  /** A gate a promise waits at until it opens, saying when the first one reached it. */
  const gate = () => {
    let reached!: () => void
    let open!: () => void
    return { reached: new Promise<void>((resolve) => { reached = resolve }), until: new Promise<void>((resolve) => { open = resolve }), reach: () => reached(), open: () => open() }
  }
  // A grant written whose clearing commit was lost: the mark that wrote it outlives it.
  async function owedOverStanding() {
    const { approvals, store } = paths()
    const registry = createApprovalRegistry(store, approvals)
    const token = await askIn(registry, 'one')
    Object.assign(failing, { rename: approvals, skip: 1, count: 2 })
    expect(await registry.resolve(sessionGrant(token), SOURCES.cli)).toEqual(expect.objectContaining({ ok: true }))
    const [grant] = store.list()
    return { approvals, store, registry, grant: grant! }
  }

  it('keeps a revoke made while approvals.json is unreadable when another process settles owed grants meanwhile', async () => {
    const { approvals, store, registry, grant } = await owedOverStanding()
    const settling = gate()
    const settler = createApprovalRegistry({ ...store, grant: async (input) => { settling.reach(); await settling.until; return store.grant(input) } }, approvals)
    const recording = gate()
    Object.assign(holding, { path: join(dirname(approvals), 'approval-revocations.json'), reached: recording.reach, until: recording.until })
    const kept = readFileSync(approvals, 'utf8')
    writeFileSync(approvals, '{')

    const revoked = registry.grants.revoke(grant.id)
    await recording.reached
    writeFileSync(approvals, kept)
    const recovering = settler.recover()
    await Promise.race([settling.reached, new Promise(resolve => setTimeout(resolve, 300))])
    recording.open()
    expect(await revoked).toBe(true)
    settling.open()
    await recovering

    expect(store.list()).toEqual([])
    await createApprovalRegistry(store, approvals).recover()
    expect(store.list()).toEqual([])
  })

  it('drops the owed session grant of a decision recorded while its session end waited for the approvals lock', async () => {
    const { approvals, store } = paths()
    const first = gate()
    let writes = 0
    const registry = createApprovalRegistry({ ...store, grant: async (input) => {
      writes += 1
      if (writes === 1) { first.reach(); await first.until }
      if (writes === 2) throw new Error('The grants file was busy')
      return store.grant(input)
    } }, approvals)
    const earlier = await askIn(registry, 'one')
    const later = await askIn(registry, 'two')

    const holdingTheLock = registry.resolve(sessionGrant(earlier), SOURCES.cli)
    await first.reached
    const queued = registry.resolve(sessionGrant(later), SOURCES.cli)
    await new Promise(resolve => setTimeout(resolve, 20))
    const ended = registry.grants.endSession('s')
    await new Promise(resolve => setTimeout(resolve, 20))
    first.open()
    expect(await holdingTheLock).toMatchObject({ ok: true })
    expect(await queued).toMatchObject({ ok: true, save: 'owed' })
    await ended

    expect(store.list()).toEqual([])
    await createApprovalRegistry(store, approvals).recover()
    expect(store.list()).toEqual([])
  })

  it('writes the grant of a decision made after a revoke that approvals.json missed, whatever the clock says', async () => {
    const { approvals, store, registry, grant } = await owedOverStanding()
    const kept = readFileSync(approvals, 'utf8')
    writeFileSync(approvals, '{')
    expect(await registry.grants.revoke(grant.id)).toBe(true)
    writeFileSync(approvals, kept)

    const stepped = Date.now() - 60 * 60_000
    vi.spyOn(Date, 'now').mockReturnValue(stepped)
    const again = await askIn(registry, 'one')
    expect(await registry.resolve(sessionGrant(again), SOURCES.cli)).toMatchObject({ ok: true, save: 'saved' })
    expect(store.activeSubjects({ rule: 'write_scope', sessionId: 's' })).toEqual([`${subject}/one`])
  })
})

describe('a lasting denial', () => {
  const secretAsk = async (runtime: CoreRuntime): Promise<string> => {
    const [secret] = (await runtime.approvals.ask({ tool: 'fs_read', sessionId: 's', asks: [{ kind: 'ask', rule: 'sensitive_path', subject: '/workspace/.env', reason: 'secret', offeredScopes: ['once'], ...PLAIN_MARKS }], call: { arguments: {}, cwd: '/workspace', description: null, complete: true } })).requests
    return secret!.token
  }
  const denial = (token: string) => ({ decision: { token, approved: false, scope: 'session' as const }, source: SOURCES.cli })

  it('writes its denial before its decision commits, so the denial stands for every call from then on', async () => {
    const { config, runtime } = await open()
    const token = await secretAsk(runtime)
    const seen: Array<ReturnType<typeof onDisk>> = []
    const grant = runtime.grants.grant.bind(runtime.grants)
    vi.spyOn(runtime.grants, 'grant').mockImplementation(async (input) => {
      seen.push(onDisk(config, token))
      return grant(input)
    })

    expect(await runtime.approvalService.answer(denial(token))).toMatchObject({ ok: true })
    expect(seen).toEqual([{ pending: true, resolved: false, owes: false }])
    expect(onDisk(config, token)).toEqual({ pending: false, resolved: true, owes: false })
    expect(runtime.grants.list()).toEqual([expect.objectContaining({ rule: 'sensitive_path', scope: 'session', denied: true })])
  })

  it('is refused as grant_unsaved, retryable and naming no path, when its denial cannot be written, and records nothing, so its ask still waits', async () => {
    const { config, runtime } = await open()
    const token = await secretAsk(runtime)
    vi.spyOn(runtime.grants, 'grant').mockRejectedValueOnce(Object.assign(new Error(`EACCES: permission denied, open '${grantsPath(config)}'`), { code: 'EACCES' }))

    const receipt = await runtime.approvalService.decide({ source: 'cli', decision: { token, outcome: 'deny', scope: 'session' } })
    expect(receipt).toEqual({
      status: 'refused', step: 'decision', decision: { token, approved: false, scope: 'session' },
      error: { code: 'grant_unsaved', message: 'Not denied for the session: saving failed: permission denied; the call still waits', retryable: true },
    })
    expect(JSON.stringify(receipt)).not.toContain(dirname(grantsPath(config)))
    expect(onDisk(config, token)).toEqual({ pending: true, resolved: false, owes: false })
    expect(runtime.grants.list()).toEqual([])
  })

  it('is recorded when sent again once its denial can be written, and a denial for that call alone refuses the call', async () => {
    const { config, runtime } = await open()
    writeFileSync(join(config.cwd, '.env'), 'TOKEN=fixture\n')
    const read = (requestId: string, approvalTokens: string[] = []) => runtime.invoke({ request: { requestId, tool: 'fs_read', args: { path: '.env' }, approvalTokens }, sessionId: 's' })
    const deny = (token: string, scope: 'once' | 'session') => runtime.approvalService.decide({ source: 'cli', decision: { token, outcome: 'deny', scope } })
    Object.assign(failing, { rename: grantsPath(config), count: 1 })

    const sent = tokenOf(await read('read-first'))
    expect(await deny(sent, 'session')).toMatchObject({ status: 'refused', error: { code: 'grant_unsaved', retryable: true } })
    expect(await deny(sent, 'session')).toMatchObject({ status: 'applied', state: 'denied' })
    expect(runtime.grants.list()).toEqual([expect.objectContaining({ rule: 'sensitive_path', scope: 'session', denied: true })])

    await runtime.grants.revoke(runtime.grants.list()[0]!.id)
    Object.assign(failing, { rename: grantsPath(config), count: 1 })
    const skipped = tokenOf(await read('read-second'))
    expect(await deny(skipped, 'session')).toMatchObject({ status: 'refused', error: { code: 'grant_unsaved' } })
    expect(await deny(skipped, 'once')).toMatchObject({ status: 'applied', state: 'denied' })
    expect(await read('read-second', [skipped])).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Approval was declined') } })
    expect(runtime.grants.list()).toEqual([])
    expect((await read('read-third')).outcome).toBe('approval_required')
  })

  it('takes its denial back when the ledger cannot then record its decision, so its ask waits with nothing in force', async () => {
    const { config, runtime } = await open()
    const token = await secretAsk(runtime)
    failing.rename = approvalsPath(config)

    await expect(runtime.approvalService.answer(denial(token))).rejects.toThrow('Injected write failure')
    expect(onDisk(config, token)).toEqual({ pending: true, resolved: false, owes: false })
    expect(runtime.grants.list()).toEqual([])
  })

  it.each([
    ['waking the webhook sender', (fail: () => void) => ({ durableNotices: true, onNoticeQueued: fail })],
    ['reporting an expired ask', (fail: () => void) => ({ onExpired: fail })],
  ])('keeps its denial in force once its decision is on disk, when %s fails after', async (_step, hooks) => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-ledger-denial-'))
    roots.push(root)
    const store = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'workspace-id' })
    let armed = false
    const registry = createApprovalRegistry(store, join(root, 'approvals.json'), 0, hooks(() => { if (armed) throw new Error('A step after the decision failed') }))
    const call = { arguments: {}, cwd: '/workspace', description: null, complete: true as const }
    const [secret] = (await registry.ask({ tool: 'fs_read', sessionId: 's', asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'sensitive_path', subject: '/workspace/.env', reason: 'secret', offeredScopes: ['once'] }], call })).requests
    // An ask made an hour ago has expired, so the decision's update drops it and reports it.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 60 * 60_000)
    await registry.ask({ tool: 'fs_write', sessionId: 'other', asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once'] }], call })
    clock.mockRestore()
    armed = true

    expect(await registry.resolve({ token: secret!.token, approved: false, scope: 'session' }, SOURCES.cli)).toMatchObject({ ok: true })
    expect(store.list()).toEqual([expect.objectContaining({ rule: 'sensitive_path', scope: 'session', denied: true })])
    expect(registry.wasDenied([secret!.token])).toBe(true)
  })

  it.each(['session', 'always'] as const)('stands over an earlier %s approval of the same secret file whose grant was left owed, and after reopening', async (scope) => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-ledger-denial-'))
    roots.push(root)
    const store = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'workspace-id' })
    let failNext = true
    const grants = { ...store, grant: async (input: Parameters<typeof store.grant>[0]) => {
      if (!failNext) return store.grant(input)
      failNext = false
      throw new Error('The grants file was busy')
    } }
    const registry = createApprovalRegistry(grants, join(root, 'approvals.json'))
    const subject = 'secret-file:/workspace/.env'
    const ask = async (requestId: string) => (await registry.ask({ tool: 'shell_exec', sessionId: 's', actor: 'a', requestId, asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'sensitive_path', subject, reason: 'secret file', offeredScopes: ['once', 'session', 'always'] }], call: { arguments: {}, cwd: '/workspace', description: null, complete: true } })).requests[0]!.token
    const holder = { rule: 'sensitive_path' as const, sessionId: 's', actor: 'a' }

    expect(await registry.resolve({ token: await ask('approved'), approved: true, scope }, SOURCES.cli)).toMatchObject({ ok: true, save: 'owed' })
    expect(await registry.resolve({ token: await ask('denied'), approved: false, scope }, SOURCES.cli)).toEqual(expect.objectContaining({ ok: true }))
    expect(store.list()).toEqual([expect.objectContaining({ subject, scope, denied: true })])
    expect(store.activeSubjects(holder)).toEqual([])

    await createApprovalRegistry(store, join(root, 'approvals.json')).recover()
    expect(store.list()).toEqual([expect.objectContaining({ subject, scope, denied: true })])
    expect(store.activeSubjects(holder)).toEqual([])
  })
})

describe('a lasting approval whose grant cannot be saved', () => {
  const approve = (runtime: CoreRuntime, token: string) => runtime.approvalService.decide({ source: 'cli', decision: { token, outcome: 'approve', scope: 'session' } })
  const resend = (runtime: CoreRuntime, path: string, token: string): Promise<InvokeResponse> =>
    runtime.invoke({ request: { requestId: `write-${path}`, tool: 'fs_write', args: { path, content: 'a' }, approvalTokens: [token] }, sessionId: 's' })
  const again = (runtime: CoreRuntime, path: string): Promise<InvokeResponse> =>
    runtime.invoke({ request: { requestId: `again-${path}`, tool: 'fs_write', args: { path, content: 'a' }, approvalTokens: [] }, sessionId: 's' })

  it('is applied with its grant owed and why, naming no path, and the call that asked runs once while the same call sent anew asks', async () => {
    const { config, runtime } = await open()
    const token = tokenOf(await write(runtime, 'one/a.md'))
    vi.spyOn(runtime.grants, 'grant').mockRejectedValueOnce(Object.assign(new Error(`EACCES: permission denied, open '${grantsPath(config)}'`), { code: 'EACCES' }))

    const receipt = await approve(runtime, token)
    expect(receipt).toMatchObject({ status: 'applied', state: 'approved', save: 'owed', saveError: 'permission denied' })
    expect(JSON.stringify(receipt)).not.toContain(dirname(grantsPath(config)))
    expect(runtime.grants.list()).toEqual([])
    expect(runtime.approvals.unspent('s')).toEqual([expect.objectContaining({ subject: { rule: 'write_scope', subject: expect.any(String) }, tool: 'fs_write' })])

    expect(await resend(runtime, 'one/a.md', token)).toMatchObject({ outcome: 'ok' })
    expect(runtime.approvals.unspent('s')).toEqual([])
    expect((await again(runtime, 'one/a.md')).outcome).toBe('approval_required')
  })

  it('saves its grant under the id its decision kept when the same decision is sent again once the store heals, and gives no second once', async () => {
    const { config, runtime } = await open()
    const token = tokenOf(await write(runtime, 'one/a.md'))
    Object.assign(failing, { rename: grantsPath(config), count: 2 })

    expect(await approve(runtime, token)).toMatchObject({ status: 'applied', save: 'owed', saveError: 'a disk I/O error' })
    const owed = keptGrant(config, token)
    expect(owed).toEqual({ id: expect.any(String), save: 'owed' })
    expect(await resend(runtime, 'one/a.md', token)).toMatchObject({ outcome: 'ok' })

    expect(await approve(runtime, token)).toMatchObject({ status: 'repeated', state: 'approved', save: 'owed', saveError: 'a disk I/O error' })
    expect(runtime.approvals.unspent('s')).toEqual([])
    const retried = await approve(runtime, token)
    expect(retried).toMatchObject({ status: 'repeated', state: 'approved', save: 'saved' })
    expect(retried).not.toHaveProperty('saveError')
    expect(runtime.grants.list()).toEqual([expect.objectContaining({ id: owed!.id, rule: 'write_scope', scope: 'session', sessionId: 's' })])
    expect(keptGrant(config, token)).toEqual({ id: owed!.id, save: 'saved' })
    expect(await again(runtime, 'one/b.md')).toMatchObject({ outcome: 'ok' })
  })

  it('keeps the id its grant was written under, saved, and gives no once beside a grant that saved', async () => {
    const { config, runtime } = await open()
    const token = tokenOf(await write(runtime, 'one/a.md'))

    const receipt = await approve(runtime, token)
    expect(receipt).toMatchObject({ status: 'applied', state: 'approved', save: 'saved' })
    const [grant] = runtime.grants.list()
    expect(keptGrant(config, token)).toEqual({ id: grant!.id, save: 'saved' })
    expect(runtime.approvals.unspent('s')).toEqual([])
  })
})

describe('a decision whose grant stays owed', () => {
  it('still releases the answered call\'s file and wakes the webhook sender', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-ledger-owed-'))
    roots.push(root)
    const store = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'workspace-id' })
    const grants = { ...store, grant: async () => { throw new Error('The grants file was busy') } }
    const woken = vi.fn()
    const registry = createApprovalRegistry(grants, join(root, 'approvals.json'), 0, { durableNotices: true, onNoticeQueued: woken })
    const [request] = (await registry.ask({ tool: 'fs_write', sessionId: 's', asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once', 'session'] }], call: { arguments: {}, cwd: root, description: null, complete: true } })).requests
    expect(readdirSync(join(root, 'approval-calls'))).toHaveLength(1)
    woken.mockClear()

    expect(await registry.resolve({ token: request!.token, approved: true, scope: 'session' }, SOURCES.cli)).toMatchObject({ ok: true, save: 'owed' })
    expect(readdirSync(join(root, 'approval-calls'))).toEqual([])
    expect(woken).toHaveBeenCalledOnce()
  })
})
