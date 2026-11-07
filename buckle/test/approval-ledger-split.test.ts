import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRuntimeError, RuntimeErrorCode } from '@5straps/runtime'
import { acquireFileLock } from '@5straps/runtime/sqlite'
import type { InvokeResponse } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { approvalsPath, grantsPath, type BuckleConfig } from '../common/runtime/config.js'
import { GRANT_OWED_NOTE } from '../common/services/approvals/approval-registry.js'
import { NO_INTERACTION, type Interaction } from '../common/services/approvals/interaction.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { runCli } from './support/cli.js'
import { fixedInteraction } from './support/interaction.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { SOURCES } from '../common/types/ports/approval-source.js'

// The ledger commits a decision first and its grant after, under the approvals lock, and a grant owed at a crash is
// written when the workspace opens again, before any call runs.

// The renames of `rename` to fail: the first `skip` pass, then `count` fail.
const failing = vi.hoisted(() => ({ rename: undefined as string | undefined, skip: 0, count: 1 }))
vi.mock('../common/adapters/replace-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../common/adapters/replace-file.js')>()
  return {
    ...actual,
    replaceFile: async (from: string, to: string, io?: Parameters<typeof actual.replaceFile>[2]) => {
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
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  Object.assign(failing, { rename: undefined, skip: 0, count: 1 })
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const NOBODY: Interaction = { requestCli: NO_INTERACTION.requestCli, hold: 'prompt' }

async function open(config?: BuckleConfig): Promise<{ config: BuckleConfig; runtime: BuckleRuntime }> {
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

const write = (runtime: BuckleRuntime, path: string): Promise<InvokeResponse> =>
  runtime.invoke({ request: { requestId: `write-${path}`, tool: 'fs_write', args: { path, content: 'a' }, approvalTokens: [] }, sessionId: 's' })

const tokenOf = (response: InvokeResponse): string => {
  if (response.outcome !== 'approval_required') throw new Error(`expected an ask, got ${response.outcome}`)
  return response.approvals[0]!.token
}

interface Ledger { pending: Array<{ request: { token: string } }>; resolved: Array<{ decision: { token: string }; owedGrant?: unknown }> }
const ledgerOf = (config: BuckleConfig): Ledger => JSON.parse(readFileSync(approvalsPath(config), 'utf8')) as Ledger
const onDisk = (config: BuckleConfig, token: string) => {
  const ledger = ledgerOf(config)
  const resolved = ledger.resolved.find(entry => entry.decision.token === token)
  return { pending: ledger.pending.some(entry => entry.request.token === token), resolved: resolved !== undefined, owes: resolved?.owedGrant !== undefined }
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

    expect(await runtime.approvalService.answer(session(token))).toMatchObject({ ok: true, grantOwed: true })
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
    expect(await runtime.approvalService.answer(session(token))).toMatchObject({ ok: true, grantOwed: true })

    const repeated = await runtime.approvalService.answer(session(token))
    expect(repeated).toMatchObject({ ok: true, repeated: true })
    expect(repeated).not.toHaveProperty('grantOwed')
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
    expect(await runtime.approvalService.answer(session(owing))).toMatchObject({ ok: true, grantOwed: true })

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
    const result = runtime.actions.read(50).find(entry => entry.tool === 'cli_approve' && entry.event === 'result')
    expect(result).toMatchObject({ outcome: 'ok', detail: expect.stringContaining(GRANT_OWED_NOTE) })
  })

  it('keeps a revoked grant revoked when the mark its write cleared never reached the disk', async () => {
    const { config, runtime } = await open()
    const token = tokenOf(await write(runtime, 'one/a.md'))
    Object.assign(failing, { rename: approvalsPath(config), skip: 1, count: 1 })

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
    Object.assign(failing, { rename: approvalsPath(config), skip: 1, count: 1 })
    expect(await runtime.approvalService.answer(session(token))).toEqual(expect.objectContaining({ ok: true }))
    const [grant] = runtime.grants.list()

    const { runtime: reopened } = await open(config)
    expect(reopened.grants.list().map(record => record.id)).toEqual([grant!.id])
    expect(onDisk(config, token).owes).toBe(false)
  })
})
