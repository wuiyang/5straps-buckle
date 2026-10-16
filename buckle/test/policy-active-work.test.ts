import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, type NodeConfig } from '../common/runtime/config.js'
import { workspaceStateKey } from '../common/domain/workspace-key.js'
import { openWorkspaceManager, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { runCli } from './support/cli.js'
import { fixedInteraction } from './support/interaction.js'
import { byName, registerWorkspace, workspaceIdOf } from './support/workspaces.js'

// buckle policy changes a list while buckle serve runs in the same workspace. A list swaps in at the next call, so a
// shell result awaiting review, a call running, and a workbench lock another process holds are no reason to refuse it.
// Only an open workbench holds a write back, since taking it up stops its terminals; a mount reshapes the tools, which
// any active work holds back.

const ADMIN = 'policy-active-work-admin-fixture'
let base: string
let state: string
let folder: string
let out: string
let err: string
let serving: WorkspaceManager
let serve: BuckleRuntime

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-policy-active-')))
  state = join(base, 'state')
  folder = join(base, 'alpha')
  mkdirSync(folder, { recursive: true })
  out = ''
  err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err += String(chunk); return true })
  const setup = await openWorkspaceManager({ config: node() })
  await registerWorkspace(setup, { id: 'alpha', dir: folder })
  await setup.close()
  serving = await openWorkspaceManager({ config: node(), interaction: fixedInteraction() })
  serve = (await byName(serving, 'alpha')).runtime
})
afterEach(async () => {
  await serving.close()
  vi.restoreAllMocks()
  rmSync(base, { recursive: true, force: true })
})

function node(): NodeConfig {
  return loadConfig({ BUCKLE_STATE_DIR: state, BUCKLE_ADMIN_TOKEN: ADMIN, BUCKLE_SANDBOX: 'none' })
}

/** `buckle policy <argv>` from the workspace's folder, as a process of its own. */
async function policy(...argv: string[]): Promise<{ exitCode: number; out: string; err: string }> {
  out = ''
  err = ''
  const { exitCode } = await runCli({ argv: ['policy', ...argv], config: node(), confirm: null, cwd: folder })
  return { exitCode, out, err }
}

/** A workbench serve owns, so it holds the workbench lock; closed by discarding it unless `open`. */
async function holdWorkbenchLock(open = false): Promise<void> {
  const id = randomUUID()
  await serve.workbenches.provision({ id, token: 'policy-active-work-workbench-fixture-token-0', projectId: 'project', chatId: 'chat', allowShell: false })
  if (!open) await serve.workbenches.discard(id, 'owner')
}

/** A shell result of the workspace waiting for review on disk, as an isolated shell leaves it. */
function stageShellResult(): void {
  const id = `shell-${randomUUID()}`
  const directory = join(state, 'workspaces', workspaceIdOf(folder), 'isolated-shell', workspaceStateKey(folder), id)
  mkdirSync(join(directory, 'workspace'), { recursive: true })
  writeFileSync(join(directory, 'run.json'), JSON.stringify({ id, sessionId: 's', stageId: 'st', tool: 'shell_exec', sourceRoot: folder, copyRoot: join(directory, 'workspace'), writableRoots: [folder], excluded: [], createdAt: new Date().toISOString(), status: 'needs_review' }))
}

/** Serve's next call, which takes a change to the settings up first. */
async function nextCall(): Promise<void> {
  expect(await serve.invoke({ request: { requestId: `call-${randomUUID()}`, tool: 'fs_list', args: { path: '.' }, approvalTokens: [] }, sessionId: 'serve' })).toMatchObject({ outcome: 'ok' })
}

describe('buckle policy while a shell result waits for review', () => {
  it('changes a list, which serve takes up at its next call', async () => {
    stageShellResult()
    expect(serve.inspectActiveWork()).toBe(true)

    expect(await policy('allow-url', 'https://new.example.test')).toMatchObject({ exitCode: 0 })
    await nextCall()
    expect(serve.policy.effective().network.allow).toEqual(['https://new.example.test'])
  })

  it('still refuses a mount, which rebuilds the tools, as a conflict', async () => {
    stageShellResult()

    expect(await policy('mount', '/site')).toMatchObject({ exitCode: 2, err: expect.stringContaining('Resolve active work and staged changes') })
    expect(serve.policy.stored().mount).toBe('/workspace')
  })
})

describe('buckle policy while buckle serve holds the workbench lock', () => {
  it('changes a list over closed workbenches, which serve takes up at its next call', async () => {
    await holdWorkbenchLock()

    expect(await policy('deny-command', 'rm *')).toMatchObject({ exitCode: 0 })
    await nextCall()
    expect(serve.policy.effective().commands.deny).toContain('rm *')
  })

  it('refuses any policy write as a conflict while a workbench is open, since taking it up stops its terminals', async () => {
    await holdWorkbenchLock(true)

    for (const argv of [['allow-url', 'https://new.example.test'], ['clear']]) {
      const refused = await policy(...argv)
      expect(refused.exitCode).toBe(2)
      expect(refused.err).toContain('Close the open workbenches of this workspace before changing its policy')
    }
    expect(serve.policy.stored().network.allow).toEqual([])
  })
})
