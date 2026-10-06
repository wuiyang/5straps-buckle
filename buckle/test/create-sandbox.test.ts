import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveSandbox } from '../common/adapters/sandbox/create-sandbox.js'
import type { ExecutableLookup } from '../common/domain/executable.js'
import { loadConfig } from '../common/runtime/config.js'
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

const WITHHELD = /found inside the workspace or a scratch root, where an agent can write, so Buckle does not run it; no process sandbox is available, so shell tools are withheld/

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
