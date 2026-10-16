import { describe, expect, it } from 'vitest'
import { createBubblewrapSandbox } from '../common/adapters/sandbox/bubblewrap-sandbox.js'
import { createNoneSandbox } from '../common/adapters/sandbox/none-sandbox.js'
import { createSeatbeltSandbox } from '../common/adapters/sandbox/seatbelt-sandbox.js'
import { createPathView } from '../common/domain/path-view.js'
import { createBuiltinPacks } from '../common/services/packs/index.js'
import type { SandboxCommand } from '../common/types/ports/sandbox.js'

const STATE = '/home/me/.5straps/buckle'

function command(overrides: Partial<SandboxCommand> = {}): SandboxCommand {
  return {
    command: 'pnpm',
    args: ['build'],
    cwd: '/work/project/apps/web',
    writableRoots: ['/work/project', '/tmp/scratch'],
    allowNetwork: true,
    mount: null,
    hiddenPaths: [STATE],
    readOnlyPaths: [],
    ...overrides,
  }
}

function pairs(args: string[], flag: string): string[][] {
  return args.flatMap((argument, index) => argument === flag ? [args.slice(index + 1, index + 3)] : [])
}

describe('bubblewrap without a mount', () => {
  const sandbox = createBubblewrapSandbox('/usr/bin/bwrap', { nodePrefix: '/opt/node' })

  it('exposes the workspace and toolchain without exposing the host root', () => {
    const { args } = sandbox.wrap(command())
    expect(pairs(args, '--ro-bind')).not.toContainEqual(['/', '/'])
    expect(pairs(args, '--ro-bind')).toContainEqual(['/work/project', '/work/project'])
    // The state directory lies in nothing bound, so it is not there to hide, and no folder of the owner's holds a mask.
    expect(pairs(args, '--tmpfs').map(([path]) => path)).toEqual(['/', '/tmp'])
    expect(sandbox.wrap(command({ readOnlyPaths: ['/home/me'] })).args.join(' ')).toContain(`--tmpfs ${STATE}`)
    expect(args.slice(-4)).toEqual(['/work/project/apps/web', '--', 'pnpm', 'build'])
  })
})

describe('bubblewrap with the workspace mounted', () => {
  const sandbox = createBubblewrapSandbox('/usr/bin/bwrap', { nodePrefix: '/opt/node' })
  const mounted = command({ mount: { root: '/work/project', at: '/workspace' }, readOnlyPaths: ['/home/me/.local/share/pnpm'] })
  const { args } = sandbox.wrap(mounted)

  it('binds the workspace at the virtual path and nothing of the host root', () => {
    expect(pairs(args, '--bind')).toContainEqual(['/work/project', '/workspace'])
    expect(pairs(args, '--ro-bind')).toEqual([['/work/project', '/workspace']])
  })

  it('keeps the system directories, the node install and the named extras readable', () => {
    const readOnly = pairs(args, '--ro-bind-try').map(([from]) => from)
    expect(readOnly).toEqual(expect.arrayContaining(['/usr', '/etc/hosts', '/opt/node', '/home/me/.local/share/pnpm']))
    expect(readOnly).not.toContain('/home')
  })

  it('gives commands a scratch home and the virtual working directory', () => {
    expect(pairs(args, '--setenv')).toContainEqual(['HOME', '/tmp/home'])
    expect(pairs(args, '--chdir')[0]?.[0]).toBe('/workspace/apps/web')
  })

  it('still binds other writable roots at their real path', () => {
    expect(pairs(args, '--bind')).toContainEqual(['/tmp/scratch', '/tmp/scratch'])
  })

  it('reports that it honours mounts', () => {
    expect(sandbox.supportsMount).toBe(true)
  })
})

describe('the other sandboxes', () => {
  it('seatbelt denies Buckle state to commands and does not honour a mount', () => {
    const sandbox = createSeatbeltSandbox()
    const { args } = sandbox.wrap(command())
    expect(args[1]).toContain(`(deny file-read* file-write* (subpath "${STATE}"))`)
    expect(sandbox.supportsMount).toBe(false)
  })

  it('withholds shell rather than showing a mounted agent a different view', () => {
    const packs = createBuiltinPacks({
      cwd: '/work/project',
      paths: createPathView({ root: '/work/project', mount: '/workspace' }),
      runProcess: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false }),
      sandbox: createNoneSandbox(),
      writableRoots: ['/work/project'],
      hiddenPaths: [],
      mountReadOnlyPaths: [],
      approvedUrls: null,
      approvedLists: [],
      allowedHosts: [],
    forge: { apiUrl: 'https://api.github.com', author: { name: 'test', email: 'test@example.com' } },
    stateDirectory: '/state',
      agentBrowserCommand: 'agent-browser',
      browserStateDirectory: '/state/browser-profiles/project',
      browserHeaded: false,
      enableShell: true,
      sandboxUnavailableReason: null,
    })
    const shell = packs.find(pack => pack.id === 'shell')
    expect(shell?.unavailableReason).toContain('/workspace')
    expect(shell?.unavailableReason).toContain('bubblewrap')
  })
})
