import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'pathe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyWorkspacePolicy, type HarnessManifest } from '@5straps/protocol'
import { resolveSandbox } from '../common/adapters/sandbox/create-sandbox.js'
import type { ExecutableLookup } from '../common/domain/executable.js'
import { loadConfig } from '../common/runtime/config.js'
import { initializeCommon, type BuckleCommon } from '../common/runtime/initialize.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'

// The sandbox program is the one program every shell, script, and terminal call runs through. `npx` and `pnpm exec`
// put `<ws>/node_modules/.bin` first on PATH, so a bwrap planted there was the sandbox from the next runtime on. It is
// now resolved as every other program is, and refused where the agent writes. These tests put a lookup in PATH's place.

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'buckle-create-sandbox-'))
  roots.push(root)
  return root
}

/** A lookup that answers from a table, as findExecutable would from PATH. */
function lookupFrom(table: Record<string, string>): ExecutableLookup {
  return name => table[name] ?? null
}

const WITHHELD = /found inside a workspace, a scratch root, or a mount of this node, where an agent may have put it, so Buckle does not run it; no process sandbox is available, so shell tools are withheld/

describe('the sandbox program found where the agent writes', () => {
  it('is refused on Linux, whether bubblewrap was asked for or found, and no command runs unsandboxed', () => {
    const workspace = '/home/me/ws'
    const scratchRoot = '/tmp/scratch'
    for (const found of [`${workspace}/node_modules/.bin/bwrap`, `${scratchRoot}/bwrap`]) {
      for (const requested of ['auto', 'bubblewrap'] as const) {
        const resolved = resolveSandbox({ requested, acknowledgedUnsandboxed: false, untrustedRoots: [workspace, scratchRoot], lookup: lookupFrom({ bwrap: found }), platform: 'linux' })
        expect(resolved.sandbox.mode).toBe('none')
        expect(resolved.unavailableReason).toMatch(WITHHELD)
        expect(resolved.unavailableReason).toMatch(/^bwrap /)
      }
    }
  })

  it('is spawned by the path PATH gave when it is found elsewhere', () => {
    const resolved = resolveSandbox({ requested: 'auto', acknowledgedUnsandboxed: false, untrustedRoots: ['/home/me/ws'], lookup: lookupFrom({ bwrap: '/opt/bubblewrap/bin/bwrap' }), platform: 'linux' })
    expect(resolved.unavailableReason).toBeNull()
    expect(resolved.sandbox.mode).toBe('bubblewrap')
    expect(resolved.sandbox.wrap({ command: 'true', args: [], cwd: '/home/me/ws', workspaceRoot: '/home/me/ws', writableRoots: ['/home/me/ws'], hiddenPaths: [], readOnlyPaths: [], mount: null, allowNetwork: false }).command).toBe('/opt/bubblewrap/bin/bwrap')
  })

  it('is refused on macOS too, where sandbox-exec sits inside an untrusted root, and used where it does not', () => {
    const lookup = lookupFrom({ '/usr/bin/sandbox-exec': '/usr/bin/sandbox-exec' })
    const refused = resolveSandbox({ requested: 'auto', acknowledgedUnsandboxed: false, untrustedRoots: ['/usr'], lookup, platform: 'darwin' })
    expect(refused.sandbox.mode).toBe('none')
    expect(refused.unavailableReason).toMatch(WITHHELD)
    const used = resolveSandbox({ requested: 'seatbelt', acknowledgedUnsandboxed: false, untrustedRoots: ['/Users/me/ws'], lookup, platform: 'darwin' })
    expect(used.sandbox.mode).toBe('seatbelt')
    expect(used.sandbox.wrap({ command: 'true', args: [], cwd: '/Users/me/ws', writableRoots: ['/Users/me/ws'], hiddenPaths: [], readOnlyPaths: [], mount: null, allowNetwork: false }).command).toBe('/usr/bin/sandbox-exec')
  })

  it('withholds the shell from a runtime whose PATH starts in the workspace\'s node_modules/.bin', async () => {
    const workspace = scratch()
    const bin = join(workspace, 'node_modules', '.bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'bwrap'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(bin, 'bwrap'), 0o755)
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`)
    const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(scratch(), 'state'), BUCKLE_SANDBOX: process.platform === 'linux' ? 'auto' : 'bubblewrap', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell' })
    const runtime = await createRuntime({ config })
    try {
      const manifest = runtime.manifest()
      expect(manifest.sandbox.mode).toBe('none')
      expect(manifest.packs.find(pack => pack.id === 'shell')?.unavailableReason).toMatch(WITHHELD)
      expect(manifest.tools.map(tool => tool.name)).not.toContain('shell_exec')
    } finally { await runtime.history.close() }
  })
})

// A registered workspace's runtime was built with no scratch roots, so its sandbox program was checked against its own
// root alone: a bwrap the default workspace's agent planted in its node_modules/.bin, first on the node's PATH, became
// the registered workspace's sandbox. Every root the node knows is now one no program runs from, for every workspace.
describe('the sandbox program planted in another root of the node', () => {
  /** An executable bwrap in a directory, as npm install or an agent's chmod leaves one. */
  function bwrapIn(directory: string): string {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'bwrap'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(directory, 'bwrap'), 0o755)
    return join(directory, 'bwrap')
  }

  /** The node as `buckle` starts it, its default workspace at `workspace`, run by `use` and closed after. */
  async function onNode<T>(input: { workspace: string; state: string }, use: (common: BuckleCommon) => Promise<T>): Promise<T> {
    const common = initializeCommon({ role: 'cli', config: loadConfig({
      BUCKLE_WORKSPACE_ROOT: input.workspace, BUCKLE_STATE_DIR: input.state, BUCKLE_SANDBOX: process.platform === 'linux' ? 'auto' : 'bubblewrap',
      BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell',
    }) })
    try {
      await common.start()
      return await use(common)
    } finally { await common.owner.close() }
  }

  const shellReason = (manifest: HarnessManifest) => manifest.packs.find(pack => pack.id === 'shell')?.unavailableReason ?? null
  const tokens = { authToken: 'planted-sandbox-agent-token-fixture', adminToken: 'planted-sandbox-admin-token-fixture' }

  function scene() {
    const state = join(scratch(), 'state')
    mkdirSync(state, { mode: 0o700 })
    return { workspace: scratch(), child: scratch(), state, trusted: bwrapIn(join(scratch(), 'bin')) }
  }

  it('withholds a registered workspace\'s shell while PATH starts at a bwrap in the default workspace, and both use the trusted one once it is gone', async () => {
    const { workspace, child, state, trusted } = scene()
    const planted = bwrapIn(join(workspace, 'node_modules', '.bin'))
    vi.stubEnv('PATH', `${dirname(planted)}:${dirname(trusted)}:${process.env.PATH ?? ''}`)
    await onNode({ workspace, state }, async common => {
      const workspaces = await common.services.getWorkspaces()
      await workspaces.register({ id: 'child', name: 'Child', root: child, ...tokens, policy: emptyWorkspacePolicy() })
      for (const manifest of [(await workspaces.resolve('child')).runtime.manifest(), (await common.services.getWorkspaceRuntime()).manifest()]) {
        expect(manifest.sandbox.mode).toBe('none')
        expect(shellReason(manifest)).toMatch(WITHHELD)
        expect(manifest.tools.map(tool => tool.name)).not.toContain('shell_exec')
      }
    })
    rmSync(planted)
    await onNode({ workspace, state }, async common => {
      for (const runtime of [await common.services.getWorkspaceRuntime(), (await (await common.services.getWorkspaces()).resolve('child')).runtime]) {
        expect(runtime.manifest().sandbox.mode).toBe('bubblewrap')
        expect(shellReason(runtime.manifest())).toBeNull()
      }
    })
  })

  it('withholds the default workspace\'s shell from the start while PATH starts at a bwrap in a workspace the registry holds', async () => {
    const { workspace, child, state, trusted } = scene()
    vi.stubEnv('PATH', `${dirname(trusted)}:${process.env.PATH ?? ''}`)
    await onNode({ workspace, state }, async common => {
      await (await common.services.getWorkspaces()).register({ id: 'child', name: 'Child', root: child, ...tokens, policy: emptyWorkspacePolicy() })
    })
    const planted = bwrapIn(join(child, 'node_modules', '.bin'))
    vi.stubEnv('PATH', `${dirname(planted)}:${dirname(trusted)}:${process.env.PATH ?? ''}`)
    await onNode({ workspace, state }, async common => {
      const manifest = (await common.services.getWorkspaceRuntime()).manifest()
      expect(manifest.sandbox.mode).toBe('none')
      expect(shellReason(manifest)).toMatch(WITHHELD)
    })
  })

  it('runs no program while the registry cannot be read, as one could lie in a workspace it holds', async () => {
    const { workspace, child, state, trusted } = scene()
    vi.stubEnv('PATH', `${dirname(trusted)}:${process.env.PATH ?? ''}`)
    await onNode({ workspace, state }, async common => {
      await (await common.services.getWorkspaces()).register({ id: 'child', name: 'Child', root: child, ...tokens, policy: emptyWorkspacePolicy() })
    })
    writeFileSync(join(state, 'workspaces.json'), '{ not json')
    await onNode({ workspace, state }, async common => {
      const manifest = (await common.services.getWorkspaceRuntime()).manifest()
      expect(manifest.sandbox.mode).toBe('none')
      expect(shellReason(manifest)).toBe('bwrap is not run while the workspace registry cannot be read: it could lie in a registered workspace, where an agent can write; no process sandbox is available, so shell tools are withheld')
    })
  })
})
