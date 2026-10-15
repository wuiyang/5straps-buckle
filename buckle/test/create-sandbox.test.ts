import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'pathe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyWorkspacePolicy, type HarnessManifest } from '@5straps/protocol'
import { resolveSandbox } from '../common/adapters/sandbox/create-sandbox.js'
import { resolveProgram, rootsOf, type ExecutableLookup } from '../common/domain/executable.js'
import { configFromEnvironment, nodeConfigOf } from './support/workspace-config.js'
import { initializeCommon, type BuckleCommon } from '../common/runtime/initialize.js'
import { nodeRootsOf } from '../common/services/workspaces/workspace-manager.js'
import { byName, defaultRuntime } from './support/workspaces.js'
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

/** An executable bwrap in a directory, as npm install or an agent's chmod leaves one. */
function bwrapIn(directory: string): string {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'bwrap'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(directory, 'bwrap'), 0o755)
  return join(directory, 'bwrap')
}

/** The node as `buckle` starts it, its default workspace at `workspace`, run by `use` and closed after. */
async function onNode<T>(input: { workspace: string; state: string; mounts?: string }, use: (common: BuckleCommon) => Promise<T>): Promise<T> {
  const common = initializeCommon({ role: 'cli', config: nodeConfigOf(configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: input.workspace, BUCKLE_STATE_DIR: input.state, BUCKLE_SANDBOX: process.platform === 'linux' ? 'auto' : 'bubblewrap',
    BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell', ...(input.mounts ? { BUCKLE_MOUNTS: input.mounts } : {}),
  })) })
  try {
    await common.start()
    return await use(common)
  } finally { await common.owner.close() }
}

const shellReason = (manifest: HarnessManifest) => manifest.packs.find(pack => pack.id === 'shell')?.unavailableReason ?? null

/** A node's default workspace, a workspace to register, its state directory, and a trusted bwrap outside all three. */
function scene() {
  const state = join(scratch(), 'state')
  mkdirSync(state, { mode: 0o700 })
  return { workspace: scratch(), child: scratch(), state, trusted: bwrapIn(join(scratch(), 'bin')) }
}

/** A lookup that answers from a table, as findExecutable would from PATH. */
function lookupFrom(table: Record<string, string>): ExecutableLookup {
  return name => table[name] ?? null
}

const WITHHELD = /found in or through a workspace of this node, where an agent can write, so Buckle does not run it; no process sandbox is available, so shell tools are withheld/

describe('the sandbox program found where the agent writes', () => {
  it('is refused on Linux, whether bubblewrap was asked for or found, and no command runs unsandboxed', () => {
    const workspace = '/home/me/ws'
    const scratchRoot = '/tmp/scratch'
    const untrustedRoots = [...rootsOf('workspace', [workspace]), ...rootsOf('scratch root', [scratchRoot])]
    for (const [found, kind] of [[`${workspace}/node_modules/.bin/bwrap`, 'a workspace'], [`${scratchRoot}/bwrap`, 'a scratch root']]) {
      for (const requested of ['auto', 'bubblewrap'] as const) {
        const resolved = resolveSandbox({ requested, acknowledgedUnsandboxed: false, untrustedRoots, lookup: lookupFrom({ bwrap: found! }), platform: 'linux' })
        expect(resolved.sandbox.mode).toBe('none')
        expect(resolved.unavailableReason).toBe(`bwrap is found in or through ${kind} of this node, where an agent can write, so Buckle does not run it; no process sandbox is available, so shell tools are withheld`)
      }
    }
  })

  it('is spawned by where PATH leads when it is found elsewhere', () => {
    const resolved = resolveSandbox({ requested: 'auto', acknowledgedUnsandboxed: false, untrustedRoots: rootsOf('workspace', ['/home/me/ws']), lookup: lookupFrom({ bwrap: '/opt/bubblewrap/bin/bwrap' }), platform: 'linux' })
    expect(resolved.unavailableReason).toBeNull()
    expect(resolved.sandbox.mode).toBe('bubblewrap')
    expect(resolved.sandbox.wrap({ command: 'true', args: [], cwd: '/home/me/ws', workspaceRoot: '/home/me/ws', writableRoots: ['/home/me/ws'], hiddenPaths: [], readOnlyPaths: [], mount: null, allowNetwork: false }).command).toBe('/opt/bubblewrap/bin/bwrap')
  })

  it('is refused on macOS too, where sandbox-exec sits inside an untrusted root, and used where it does not', () => {
    const lookup = lookupFrom({ '/usr/bin/sandbox-exec': '/usr/bin/sandbox-exec' })
    const refused = resolveSandbox({ requested: 'auto', acknowledgedUnsandboxed: false, untrustedRoots: rootsOf('workspace', ['/usr']), lookup, platform: 'darwin' })
    expect(refused.sandbox.mode).toBe('none')
    expect(refused.unavailableReason).toMatch(WITHHELD)
    const used = resolveSandbox({ requested: 'seatbelt', acknowledgedUnsandboxed: false, untrustedRoots: rootsOf('workspace', ['/Users/me/ws']), lookup, platform: 'darwin' })
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
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(scratch(), 'state'), BUCKLE_SANDBOX: process.platform === 'linux' ? 'auto' : 'bubblewrap', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell' })
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
  it('withholds a registered workspace\'s shell while PATH starts at a bwrap in the default workspace, and both use the trusted one once it is gone', async () => {
    const { workspace, child, state, trusted } = scene()
    const planted = bwrapIn(join(workspace, 'node_modules', '.bin'))
    vi.stubEnv('PATH', `${dirname(planted)}:${dirname(trusted)}:${process.env.PATH ?? ''}`)
    await onNode({ workspace, state }, async common => {
      const workspaces = await common.services.getWorkspaces()
      await workspaces.create({ id: 'child', name: 'Child', dir: child, policy: emptyWorkspacePolicy() })
      for (const manifest of [(await byName(workspaces, 'child')).runtime.manifest(), (await defaultRuntime(common)).manifest()]) {
        expect(manifest.sandbox.mode).toBe('none')
        expect(shellReason(manifest)).toMatch(WITHHELD)
        expect(manifest.tools.map(tool => tool.name)).not.toContain('shell_exec')
      }
    })
    rmSync(planted)
    await onNode({ workspace, state }, async common => {
      for (const runtime of [await defaultRuntime(common), (await byName(await common.services.getWorkspaces(), 'child')).runtime]) {
        expect(runtime.manifest().sandbox.mode).toBe('bubblewrap')
        expect(shellReason(runtime.manifest())).toBeNull()
      }
    })
  })

  it('withholds the default workspace\'s shell from the start while PATH starts at a bwrap in a workspace the registry holds', async () => {
    const { workspace, child, state, trusted } = scene()
    vi.stubEnv('PATH', `${dirname(trusted)}:${process.env.PATH ?? ''}`)
    await onNode({ workspace, state }, async common => {
      await (await common.services.getWorkspaces()).create({ id: 'child', name: 'Child', dir: child, policy: emptyWorkspacePolicy() })
    })
    const planted = bwrapIn(join(child, 'node_modules', '.bin'))
    vi.stubEnv('PATH', `${dirname(planted)}:${dirname(trusted)}:${process.env.PATH ?? ''}`)
    await onNode({ workspace, state }, async common => {
      const manifest = (await defaultRuntime(common)).manifest()
      expect(manifest.sandbox.mode).toBe('none')
      expect(shellReason(manifest)).toMatch(WITHHELD)
    })
  })

  // Every workspace lives in the registry (D83), so a node whose registry cannot be read opens none: it starts no
  // workspace at all. A runtime that resolves a program while the registry fails runs none.
  it('runs no program while the registry cannot be read, as one could lie in a workspace it holds', async () => {
    const { workspace, child, state, trusted } = scene()
    vi.stubEnv('PATH', `${dirname(trusted)}:${process.env.PATH ?? ''}`)
    await onNode({ workspace, state }, async common => {
      await (await common.services.getWorkspaces()).create({ id: 'child', name: 'Child', dir: child, policy: emptyWorkspacePolicy() })
    })
    writeFileSync(join(state, 'workspaces.json'), '{ not json')
    await expect(onNode({ workspace, state }, async () => undefined)).rejects.toThrow('workspaces.json')
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: state })
    const resolved = resolveSandbox({ requested: 'bubblewrap', acknowledgedUnsandboxed: false, ...nodeRootsOf(nodeConfigOf(config)).current(), environment: { PATH: dirname(trusted) }, platform: 'linux' })
    expect(resolved.unavailableReason).toBe('bwrap is not run while the workspace registry cannot be read: it could lie in a registered workspace, where an agent can write; no process sandbox is available, so shell tools are withheld')
  })
})

// Judged by the path PATH gave and where it really leads, a program reached through a link in a workspace passed: PATH
// started at a link to a workspace folder, where the agent linked bwrap to the trusted one, then swapped the link for its
// own script, which the next shell call ran as the sandbox. Every place on the way is judged now, and the real path runs.
describe('the sandbox program reached through a link in a workspace', () => {
  it('is refused in the default and a registered workspace while PATH starts at a link to a workspace folder, and nothing planted after runs', async () => {
    const { workspace, child, state, trusted } = scene()
    const linked = join(scratch(), 'linked-tools')
    mkdirSync(join(workspace, 'tools'))
    symlinkSync(join(workspace, 'tools'), linked)
    symlinkSync(trusted, join(workspace, 'tools', 'bwrap'))
    vi.stubEnv('PATH', `${linked}:${process.env.PATH ?? ''}`)
    await onNode({ workspace, state }, async common => {
      const workspaces = await common.services.getWorkspaces()
      await workspaces.create({ id: 'child', name: 'Child', dir: child, policy: emptyWorkspacePolicy() })
      for (const manifest of [(await defaultRuntime(common)).manifest(), (await byName(workspaces, 'child')).runtime.manifest()]) {
        expect(manifest.sandbox.mode).toBe('none')
        expect(shellReason(manifest)).toMatch(WITHHELD)
      }
    })
    unlinkSync(join(workspace, 'tools', 'bwrap'))
    bwrapIn(join(workspace, 'tools'))
    await onNode({ workspace, state }, async common => {
      for (const runtime of [await defaultRuntime(common), (await byName(await common.services.getWorkspaces(), 'child')).runtime]) {
        expect(runtime.manifest().sandbox.mode).toBe('none')
        expect(shellReason(runtime.manifest())).toMatch(WITHHELD)
      }
    })
  })

  it('is refused where a link between two places outside every root passes through a workspace', () => {
    const { workspace, trusted } = scene()
    const bin = join(scratch(), 'bin')
    mkdirSync(bin)
    symlinkSync(trusted, join(workspace, 'hop'))
    symlinkSync(join(workspace, 'hop'), join(bin, 'bwrap'))
    const resolved = resolveSandbox({ requested: 'bubblewrap', acknowledgedUnsandboxed: false, untrustedRoots: rootsOf('workspace', [workspace]), environment: { PATH: bin }, platform: 'linux' })
    expect(resolved.sandbox.mode).toBe('none')
    expect(resolved.unavailableReason).toMatch(WITHHELD)
  })

  it('is spawned by its real path, started by the name PATH gave, where every link on the way lies outside every root', () => {
    const { workspace, trusted } = scene()
    const bin = join(scratch(), 'bin')
    mkdirSync(bin)
    symlinkSync(trusted, join(bin, 'bwrap'))
    expect(resolveProgram('bwrap', { untrustedRoots: rootsOf('workspace', [workspace]), environment: { PATH: bin }, platform: 'linux' })).toEqual({ path: trusted, argv0: join(bin, 'bwrap'), args: [] })
    const resolved = resolveSandbox({ requested: 'bubblewrap', acknowledgedUnsandboxed: false, untrustedRoots: rootsOf('workspace', [workspace]), environment: { PATH: bin }, platform: 'linux' })
    expect(resolved.sandbox.wrap({ command: 'true', args: [], cwd: workspace, workspaceRoot: workspace, writableRoots: [workspace], hiddenPaths: [], readOnlyPaths: [], mount: null, allowNetwork: false }).command).toBe(trusted)
  })
})

// The last fix made every mount's source a root no program runs from, so a bwrap in a folder BUCKLE_MOUNTS shares was
// refused, and the shell named the mounts as why. A source the sandbox mounts read-only is one no agent writes, as a
// BUCKLE_MOUNT_READ_ONLY folder is; only a writable one is a root, and a refusal names it.
describe('the sandbox program in a folder a mount shares', () => {
  it('is used from a source mounted read-only', async () => {
    const { workspace, state } = scene()
    const shared = bwrapIn(join(scratch(), 'tools'))
    vi.stubEnv('PATH', `${dirname(shared)}:${process.env.PATH ?? ''}`)
    await onNode({ workspace, state, mounts: JSON.stringify([{ source: dirname(shared), target: '/opt/tools' }]) }, async common => {
      const manifest = (await defaultRuntime(common)).manifest()
      expect(manifest.sandbox.mode).toBe('bubblewrap')
      expect(shellReason(manifest)).toBeNull()
    })
  })

  it('is refused from a source mounted writable, with a reason naming that root', () => {
    const { workspace, state } = scene()
    const shared = bwrapIn(join(scratch(), 'tools'))
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: state })
    // Every mount is read-only today; a writable one is imitated past the schema that allows no other.
    const roots = nodeRootsOf({ ...nodeConfigOf(config), sandboxMounts: [{ source: dirname(shared), target: '/opt/tools', readOnly: false as unknown as true }] }).current()
    const resolved = resolveSandbox({ requested: 'bubblewrap', acknowledgedUnsandboxed: false, ...roots, environment: { PATH: dirname(shared) }, platform: 'linux' })
    expect(resolved.unavailableReason).toBe('bwrap is found in or through the source of a writable mount of this node, where an agent can write, so Buckle does not run it; no process sandbox is available, so shell tools are withheld')
  })

  it('withholds the shell for the refusal, not for the mounts, where the sandbox program lies in a workspace', async () => {
    const { workspace, state } = scene()
    const planted = bwrapIn(join(workspace, 'node_modules', '.bin'))
    const shared = join(scratch(), 'tools')
    mkdirSync(shared)
    vi.stubEnv('PATH', `${dirname(planted)}:${process.env.PATH ?? ''}`)
    await onNode({ workspace, state, mounts: JSON.stringify([{ source: shared, target: '/opt/tools' }]) }, async common => {
      expect(shellReason((await defaultRuntime(common)).manifest())).toMatch(WITHHELD)
    })
  })
})
