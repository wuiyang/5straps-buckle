import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonValue } from '@5straps/protocol'
import { createBubblewrapSandbox } from '../common/adapters/sandbox/bubblewrap-sandbox.js'
import { createPathView } from '../common/domain/path-view.js'
import { mountSourceState, validateSandboxMounts } from '../common/domain/sandbox-mounts.js'
import { loadConfig } from '../common/runtime/config.js'
import { createShellPack } from '../common/services/packs/shell/index.js'
import { checkpointRoots } from '../common/services/workspaces/workspace-runtime.js'
import { withOwnerMounts } from '../common/services/workspaces/workspace-settings.js'
import type { ProcessRequest } from '../common/types/ports/process-runner.js'
import { byName, idOf, registerWorkspace, workspacesOf } from './support/workspaces.js'

// A mount's source is stored as the disk names it. One swapped for a link since (by another workspace's agent that can
// restructure a shared folder, say) lands wherever the link points; the shell, history, and the execution lock use
// the stored source alone and refuse, or leave out, one that no longer lands on itself.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-mount-swap-')))
  roots.push(root)
  return root
}

/** A shared folder, and the owner's credentials beside it; `swap` replaces the folder with a link to the credentials. */
function sharedFolder() {
  const root = scratch()
  const assets = join(root, 'other-workspace', 'assets')
  mkdirSync(assets, { recursive: true })
  const ssh = join(root, 'home', '.ssh')
  mkdirSync(ssh, { recursive: true })
  writeFileSync(join(ssh, 'id_ed25519'), 'PRIVATE KEY')
  const swap = () => { renameSync(assets, `${assets}.old`); symlinkSync('../home/.ssh', assets) }
  return { root, assets, ssh, swap }
}

describe('a mount source swapped for a link', () => {
  it('is told apart from one that still lands on itself and one that is gone', () => {
    const { assets, swap } = sharedFolder()
    expect(mountSourceState(assets)).toBe('present')
    swap()
    expect(mountSourceState(assets)).toBe('moved')
    rmSync(assets)
    expect(mountSourceState(assets)).toBe('missing')
  })

  it('is refused by the mount check, naming the target and never a host path', () => {
    const { root, assets, ssh, swap } = sharedFolder()
    swap()
    const check = () => validateSandboxMounts([{ source: assets, target: '/assets', readOnly: false }], { protectedRoots: [join(root, 'home', '.5straps')], workspaceRoots: [join(root, 'site')], workspaceTarget: '/workspace' })
    expect(check).toThrow('The mount at /assets changed on disk since the owner added it, so Buckle uses nothing there; the owner re-adds it')
    try { check() } catch (error) {
      expect(error).toMatchObject({ code: 'PERMISSION_DENIED' })
      expect(String(error)).not.toContain(root)
      expect(String(error)).not.toContain(ssh)
    }
  })

  it('is refused by the shell, which binds nothing where the link lands', async () => {
    const { root, assets, ssh, swap } = sharedFolder()
    const site = join(root, 'site')
    mkdirSync(site)
    const calls: ProcessRequest[] = []
    const pack = createShellPack({
      paths: createPathView({ root: site, mount: '/workspace' }), sandbox: createBubblewrapSandbox('/usr/bin/bwrap'), writableRoots: [site], hiddenPaths: [join(root, 'home', '.5straps')], readOnlyPaths: [], unavailableReason: null,
      mounts: [{ source: assets, target: '/assets', readOnly: false }],
      runProcess: async (request) => { calls.push(request); return { exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false } },
    })
    const run = () => pack.tools[0]!.prepare({ command: 'cat', args: ['/assets/id_ed25519'] }).execute({ requestId: 'swap', sessionId: 'caller', timeoutMs: 1000, signal: new AbortController().signal })
    await run()
    expect(calls[0]!.args.slice(calls[0]!.args.indexOf(assets) - 1, calls[0]!.args.indexOf(assets) + 2)).toEqual(['--bind', assets, '/assets'])
    swap()
    await expect(run()).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('The mount at /assets changed on disk') })
    expect(calls).toHaveLength(1)
    expect(calls.flatMap(call => call.args)).not.toContain(ssh)
  })

  it('is left out of the roots a checkpoint and the execution lock cover, which keep the stored source', () => {
    const { root, assets, swap } = sharedFolder()
    const site = join(root, 'site')
    mkdirSync(site)
    const mounts = createPathView({ root: site, mount: '/workspace', mounts: [{ source: assets, target: '/assets', access: 'rw' }] }).mounts
    expect(checkpointRoots(site, mounts)).toEqual([site, assets])
    swap()
    expect(checkpointRoots(site, mounts)).toEqual([site])
  })

  it('snapshots nothing where the link lands when the workspace writes', async () => {
    const { root, assets, swap } = sharedFolder()
    // The link's landing holds more than the history budget: a checkpoint that took it would refuse the write.
    writeFileSync(join(root, 'home', '.ssh', 'big.bin'), Buffer.alloc(200_000, 1))
    mkdirSync(join(root, 'site'))
    const manager = await workspacesOf(loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_PACKS: 'fs', BUCKLE_HISTORY_MAX_BYTES: '100000' }))
    await registerWorkspace(manager, { id: 'site', dir: join(root, 'site') })
    await manager.updateSettings(idOf(manager, 'site'), settings => withOwnerMounts(settings, [{ source: assets, target: '/assets', access: 'rw' }], '/workspace'))
    const { runtime } = await byName(manager, 'site')
    await runtime.grants.grant({ sessionId: 'site', rule: 'write_scope', subject: join(root, 'site'), scope: 'always' })
    const call = (args: Record<string, JsonValue>) => runtime.invoke({ request: { requestId: `write-${Math.random()}`, tool: 'fs_write', args, approvalTokens: [] }, sessionId: 'site' })
    swap()
    expect(await call({ path: '/workspace/b.txt', content: 'written' })).toMatchObject({ outcome: 'ok' })
    const history = join(root, 'state', 'workspaces', idOf(manager, 'site'), 'history')
    const [key] = readdirSync(history).filter(name => !name.startsWith('.'))
    const database = new DatabaseSync(join(history, key!, 'history.sqlite'), { readOnly: true })
    const checkpoints = database.prepare('SELECT data FROM checkpoints').all().map(row => JSON.parse(String(row.data)) as { roots: string[] })
    database.close()
    expect(checkpoints.map(checkpoint => checkpoint.roots)).toEqual([[join(root, 'site')]])
    await manager.close()
  })
})

describe('the node\'s BUCKLE_MOUNTS', () => {
  it('are stored as the disk names them, so a link typed for a source keeps working and a later swap is refused', () => {
    const root = scratch()
    mkdirSync(join(root, 'dotfiles'))
    symlinkSync(join(root, 'dotfiles'), join(root, 'dotfiles-link'))
    const config = loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_MOUNTS: JSON.stringify([{ source: join(root, 'dotfiles-link'), target: '/tmp/home/.config' }]) })
    expect(config.workspaceDefaults.mounts).toEqual([{ source: join(root, 'dotfiles'), target: '/tmp/home/.config', access: 'ro' }])
  })
})
