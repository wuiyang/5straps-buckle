import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonValue } from '@5straps/protocol'
import { createBubblewrapSandbox } from '../common/adapters/sandbox/bubblewrap-sandbox.js'
import { createPathView } from '../common/domain/path-view.js'
import { mountSourceState, validateSandboxMounts } from '../common/domain/sandbox-mounts.js'
import { loadConfig, sandboxBinds } from '../common/runtime/config.js'
import { createShellPack } from '../common/services/packs/shell/index.js'
import { openObjectStore } from '../common/services/history/object-store.js'
import { checkpointRoots } from '../common/services/workspaces/workspace-runtime.js'
import { withOwnerMounts } from '../common/services/workspaces/workspace-settings.js'
import type { ProcessRequest } from '../common/types/ports/process-runner.js'
import { settleAuditLogs } from './support/action-log-writer.js'
import { byName, idOf, registerWorkspace, workspacesOf } from './support/workspaces.js'

// A mount's source is stored as the disk names it. One swapped for a link since (by another workspace's agent that can
// restructure a shared folder, say) lands wherever the link points; the shell, history, and the execution lock use
// the stored source alone and refuse, or leave out, one that no longer lands on itself.

const roots: string[] = []
afterEach(async () => { await settleAuditLogs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
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
    const manager = await workspacesOf(loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_PACKS: 'fs', BUCKLE_ALLOW_HOST_GIT: 'true', BUCKLE_HISTORY_MAX_BYTES: '100000' }))
    await registerWorkspace(manager, { id: 'site', dir: join(root, 'site') })
    await manager.updateSettings(idOf(manager, 'site'), settings => withOwnerMounts(settings, [{ source: assets, target: '/assets', access: 'rw' }], '/workspace'))
    const { runtime } = await byName(manager, 'site')
    await runtime.grants.grant({ sessionId: 'site', rule: 'write_scope', subject: join(root, 'site'), scope: 'always' })
    const call = (args: Record<string, JsonValue>) => runtime.invoke({ request: { requestId: `write-${Math.random()}`, tool: 'fs_write', args, approvalTokens: [] }, sessionId: 'site' })
    swap()
    expect(await call({ path: '/workspace/b.txt', content: 'written' })).toMatchObject({ outcome: 'ok' })
    const history = join(root, 'state', 'workspaces', idOf(manager, 'site'), 'history')
    const [key] = readdirSync(history).filter(name => !name.startsWith('.'))
    const checkpoints = (JSON.parse(readFileSync(join(history, key!, 'checkpoints.json'), 'utf8')) as { checkpoints: Array<{ roots: string[] }> }).checkpoints
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
    expect(config.workspaceDefaults.mounts).toEqual([{ source: join(root, 'dotfiles'), target: '/tmp/home/.config', access: 'ro', node: true }])
  })

  // Fix brief 6, item 9 (finding 22 of recheck 4): a node mount whose source is gone was refused naming buckle workspace
  // mount remove, which refuses a node mount; the refusal now names the node's settings, and still no source path.
  it('are refused, once a source is gone, naming the node\'s settings and not workspace mount remove', async () => {
    const root = scratch()
    mkdirSync(join(root, 'dotfiles'))
    mkdirSync(join(root, 'site'))
    const manager = await workspacesOf(loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_PACKS: 'fs', BUCKLE_MOUNTS: JSON.stringify([{ source: join(root, 'dotfiles'), target: '/srv/dotfiles' }]) }))
    await registerWorkspace(manager, { id: 'site', dir: join(root, 'site') })
    const { config } = await byName(manager, 'site')
    rmSync(join(root, 'dotfiles'), { recursive: true })
    const check = () => validateSandboxMounts(sandboxBinds(config.mounts), { protectedRoots: [], workspaceRoots: [join(root, 'site')], workspaceTarget: '/workspace' })
    expect(check).toThrow("The mount at /srv/dotfiles has no source on disk; it is one of the node's mounts, so the owner restores its source, or changes them with buckle settings set mounts, or buckle settings unset mounts")
    let refusal = ''
    try { check() } catch (error) { refusal = String(error) }
    expect(refusal).not.toContain('workspace mount remove')
    expect(refusal).not.toContain(root)
    await expect(manager.removeMount(idOf(manager, 'site'), '/srv/dotfiles')).rejects.toThrow("/srv/dotfiles is one of the node's mounts")
    await manager.close()
  })
})

// A writable mount whose source is gone (a renamed or deleted ~/data, or a hand-edited source) gives history nothing to
// checkpoint: the folder above it is never taken in its place, and a write or a shell run aimed at it is refused.
describe('a mount whose source is gone', () => {
  async function workspaceBesideHome() {
    const root = scratch()
    const home = join(root, 'home')
    mkdirSync(join(home, 'data'), { recursive: true })
    writeFileSync(join(home, 'big.bin'), Buffer.alloc(200_000, 1))
    writeFileSync(join(home, 'secret.txt'), 'owner secret')
    mkdirSync(join(root, 'site'))
    const manager = await workspacesOf(loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_PACKS: 'fs', BUCKLE_ALLOW_HOST_GIT: 'true', BUCKLE_HISTORY_MAX_BYTES: '100000' }))
    await registerWorkspace(manager, { id: 'site', dir: join(root, 'site') })
    await manager.updateSettings(idOf(manager, 'site'), settings => withOwnerMounts(settings, [{ source: join(home, 'data'), target: '/data', access: 'rw' }], '/workspace'))
    const { runtime } = await byName(manager, 'site')
    await runtime.grants.grant({ sessionId: 'site', rule: 'write_scope', subject: join(root, 'site'), scope: 'always' })
    await runtime.grants.grant({ sessionId: 'site', rule: 'write_scope', subject: join(home, 'data'), scope: 'always' })
    const write = (path: string) => runtime.invoke({ request: { requestId: `write-${Math.random()}`, tool: 'fs_write', args: { path, content: 'written' }, approvalTokens: [] }, sessionId: 'site' })
    return { root, home, manager, runtime, write }
  }

  it('leaves the workspace writable, and history never snapshots the folder above it', async () => {
    const { root, home, manager, write } = await workspaceBesideHome()
    rmSync(join(home, 'data'), { recursive: true })
    expect(await write('/workspace/b.txt')).toMatchObject({ outcome: 'ok' })
    const history = join(root, 'state', 'workspaces', idOf(manager, 'site'), 'history')
    const [key] = readdirSync(history).filter(name => !name.startsWith('.'))
    const records = (JSON.parse(readFileSync(join(history, key!, 'checkpoints.json'), 'utf8')) as { checkpoints: Array<{ roots: string[] }> }).checkpoints
    const roots = records.map(record => record.roots)
    // A file tool's checkpoint keeps its content in history's object store, never in shadow git (Slice F2, items 1 and 4).
    const store = openObjectStore(join(history, key!))
    const copied = (await Promise.all(store.list().map(id => store.read(id)))).map(String).join('\n')
    expect(roots).toEqual([[join(root, 'site')]])
    expect(store.list().length).toBeGreaterThan(0)
    expect(copied).not.toContain('owner secret')
    expect(existsSync(join(history, key!, 'git'))).toBe(false)
    await manager.close()
  })

  it('refuses a write into it, naming the mount by its target and the command that removes it', async () => {
    const { root, home, manager, write } = await workspaceBesideHome()
    expect(await write('/data/a.txt')).toMatchObject({ outcome: 'ok' })
    rmSync(join(home, 'data'), { recursive: true })
    const refused = await write('/data/b.txt')
    expect(refused).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('The mount at /data has no source on disk; the owner re-adds it, or removes it with buckle workspace mount remove /data') } })
    expect(JSON.stringify(refused)).not.toContain(root)
    expect(existsSync(join(home, 'data'))).toBe(false)
    await manager.close()
  })

  it('refuses a shell run, naming the target, where it used to fail on a raw ENOENT', () => {
    const root = scratch()
    expect(() => validateSandboxMounts([{ source: join(root, 'gone'), target: '/data', readOnly: false }], { protectedRoots: [], workspaceRoots: [join(root, 'site')], workspaceTarget: '/workspace' }))
      .toThrow('The mount at /data has no source on disk; the owner re-adds it, or removes it with buckle workspace mount remove /data')
  })

  it('still covers a scratch root not made yet from the nearest folder that is, as its first write may make it', () => {
    const root = scratch()
    const site = join(root, 'site')
    mkdirSync(site)
    const mounts = createPathView({ root: site, mount: '/workspace', mounts: [{ source: join(root, 'scratch', 'later'), target: join(root, 'scratch', 'later'), access: 'rw', scratch: true }, { source: join(root, 'gone'), target: '/gone', access: 'rw' }] }).mounts
    expect(checkpointRoots(site, mounts)).toEqual([site, root])
  })
})
