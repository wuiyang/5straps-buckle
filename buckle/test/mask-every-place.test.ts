import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBubblewrapSandbox } from '../common/adapters/sandbox/bubblewrap-sandbox.js'
import { createPathView } from '../common/domain/path-view.js'
import { createShellPack } from '../common/services/packs/shell/index.js'
import type { ProcessRequest } from '../common/types/ports/process-runner.js'
import type { SandboxCommand } from '../common/types/ports/sandbox.js'

// Fix brief 6, item 3 (finding 3 of recheck 4): a hidden file was masked at the first place it shows, though the
// layout can bind one host path twice. A scratch root holding the workspace's folder, bound writable at its own path
// beside the folder's /workspace, showed the folder's .env at its host path past the mask at /workspace/.env; a toolchain
// that is also a mount's source showed its hidden file at its own path, masked only at the mount's target. The shell
// now refuses that scratch root wherever the folder shows at a mount, and a mask is laid at every place. No bwrap runs
// here: the layout is read from its arguments.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** R/code, a scratch root, holds the workspace's folder R/code/site, which holds a .env and folders the owner's rules name. */
function scratchAboveFolder() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-mask-places-')))
  roots.push(root)
  const code = join(root, 'code')
  const site = join(code, 'site')
  mkdirSync(join(site, 'private'), { recursive: true })
  writeFileSync(join(site, '.env'), 'SECRET=1')
  return { root, code, site }
}

function masks(args: string[]): string[] {
  return args.flatMap((arg, index) => (arg === '--ro-bind' && args[index + 1] === '/dev/null' ? [args[index + 2]!] : arg === '--tmpfs' && args[index + 1] !== '/' && args[index + 1] !== '/tmp' ? [args[index + 1]!] : []))
}

describe('a scratch root that holds the workspace\'s folder', () => {
  function shell(paths: ReturnType<typeof createPathView>, writableRoots: string[]) {
    const calls: ProcessRequest[] = []
    const pack = createShellPack({
      paths, sandbox: createBubblewrapSandbox('/usr/bin/bwrap'), writableRoots, hiddenPaths: [], readOnlyPaths: [], unavailableReason: null,
      runProcess: async (request) => { calls.push(request); return { exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false } },
    })
    const run = (cwd = '.') => pack.tools[0]!.prepare({ command: 'cat', args: ['.env'], cwd }).execute({ requestId: 'r', sessionId: 's', timeoutMs: 1000, signal: new AbortController().signal })
    return { calls, run }
  }

  it('is refused by the shell without isolation where the folder shows at /workspace, naming the scratch root, and nothing runs', async () => {
    const { code, site } = scratchAboveFolder()
    const { calls, run } = shell(createPathView({ root: site, mount: '/workspace', scratchRoots: [code] }), [site, code])
    await expect(run()).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: `The mount at ${code} overlaps the workspace's folder or Buckle's protected state, so Buckle binds nothing there; the owner narrows it` })
    await expect(run(code)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(calls).toEqual([])
  })

  it('still runs where the folder shows at its real path, one view of it, masked there', async () => {
    const { code, site } = scratchAboveFolder()
    const { calls, run } = shell(createPathView({ root: site, mount: null, scratchRoots: [code] }), [site, code])
    await run()
    expect(masks(calls[0]!.args)).toContain(join(site, '.env'))
  })
})

describe('a hidden path the layout shows at two places', () => {
  const base = (overrides: Partial<SandboxCommand>): SandboxCommand => ({ command: 'cat', args: [], cwd: '/', writableRoots: [], allowNetwork: false, mount: null, hiddenPaths: [], readOnlyPaths: [], ...overrides })

  it('is masked at both where a writable root bound at its own path holds the folder: credential files, and the owner\'s denied folders', () => {
    const { code, site } = scratchAboveFolder()
    const { args } = createBubblewrapSandbox('/usr/bin/bwrap').wrap(base({ cwd: site, workspaceRoot: site, mount: { root: site, at: '/workspace' }, writableRoots: [site, code], hiddenFiles: [join(site, '.env')], hiddenPaths: [join(site, 'private')] }))
    expect(masks(args)).toEqual(expect.arrayContaining(['/workspace/.env', join(site, '.env'), '/workspace/private', join(site, 'private')]))
    // Each mask comes after the bind it covers.
    expect(args.lastIndexOf(join(site, '.env'))).toBeGreaterThan(args.indexOf(code))
  })

  it('is masked at the mount\'s target and at its own path where a toolchain is also a mount\'s source', () => {
    const { root } = scratchAboveFolder()
    const tool = join(root, 'tool')
    const { args } = createBubblewrapSandbox('/usr/bin/bwrap').wrap(base({ readOnlyPaths: [tool], mounts: [{ source: tool, target: '/tool', readOnly: true }], hiddenFiles: [join(tool, '.env')] }))
    expect(masks(args)).toEqual(expect.arrayContaining(['/tool/.env', join(tool, '.env')]))
  })

  it('is masked once where it shows once', () => {
    const { site } = scratchAboveFolder()
    const { args } = createBubblewrapSandbox('/usr/bin/bwrap').wrap(base({ cwd: site, workspaceRoot: site, mount: { root: site, at: '/workspace' }, writableRoots: [site, join(site, 'private')], hiddenFiles: [join(site, 'private', '.env')] }))
    expect(masks(args)).toEqual(['/workspace/private/.env'])
  })
})
