import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRuntimeError, RuntimeErrorCode } from '@5straps/runtime'
import { acquireFileLock } from '@5straps/runtime/sqlite'
import type { InvokeResponse } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { approvalsPath, grantsPath, type BuckleConfig } from '../common/runtime/config.js'
import { NO_INTERACTION, type Interaction } from '../common/services/approvals/interaction.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction } from './support/interaction.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The ledger commits a decision first and its grant after, under the approvals lock, and a grant owed at a crash is
// written when the workspace opens again, before any call runs.

const failing = vi.hoisted(() => ({ rename: undefined as string | undefined }))
vi.mock('../common/adapters/replace-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../common/adapters/replace-file.js')>()
  return {
    ...actual,
    replaceFile: async (from: string, to: string, io?: Parameters<typeof actual.replaceFile>[2]) => {
      if (failing.rename === to) {
        failing.rename = undefined
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
  failing.rename = undefined
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
const session = (token: string) => ({ decision: { token, approved: true, scope: 'session' as const }, authority: 'admin' as const })

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

  it('leaves the grant owed when its write fails after the ledger commits, and the workspace writes it on opening, before any call runs', async () => {
    const { config, runtime } = await open()
    const token = tokenOf(await write(runtime, 'one/a.md'))
    vi.spyOn(runtime.grants, 'grant').mockRejectedValueOnce(new Error('The process stopped here'))

    await expect(runtime.approvalService.answer(session(token))).rejects.toThrow('The process stopped here')
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
    await expect(runtime.approvalService.answer(session(token))).rejects.toThrow('The grants file was busy')

    expect(await runtime.approvalService.answer(session(token))).toMatchObject({ ok: true, repeated: true })
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
})
