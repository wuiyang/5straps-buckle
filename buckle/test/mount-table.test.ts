import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatMount, mountTargetRefusal, parseMountSpec } from '../common/domain/mount-table.js'
import { loadConfig, unreadWorkspaceDefaults } from '../common/runtime/config.js'
import { MOUNTS_UNREADABLE } from '../common/services/workspaces/node-roots.js'
import { nodeRootsOf } from '../common/services/workspaces/workspace-manager.js'
import { ownerMounts, resolveSettings, settingsPath, withMount, withOwnerMounts, WorkspaceSettingsInvalidError, WorkspaceSettingsSchema } from '../common/services/workspaces/workspace-settings.js'
import { idOf, registerWorkspace, workspacesOf } from './support/workspaces.js'

// Phase 2 item 1 of the workspace-model brief: each workspace's mount table in its workspace.json (D84 (3), D85 Q1 and
// Q6), the node's mount settings its defaults, and every writable mount a root no program runs from.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-mount-table-')))
  roots.push(root)
  return root
}

const folder = { kind: 'workspace' as const, target: '/workspace', access: 'rw' as const }

describe('a mount as the owner types it', () => {
  it('reads Docker\'s -v form, read-write unless :ro or --read-only says otherwise', () => {
    expect(parseMountSpec('/home/me/data:/data', false)).toEqual({ source: '/home/me/data', target: '/data', access: 'rw' })
    expect(parseMountSpec('/home/me/data:/data:ro', false)).toEqual({ source: '/home/me/data', target: '/data', access: 'ro' })
    expect(parseMountSpec('/home/me/data:/data:rw', false)).toEqual({ source: '/home/me/data', target: '/data', access: 'rw' })
    expect(parseMountSpec('/home/me/data:/data', true)).toEqual({ source: '/home/me/data', target: '/data', access: 'ro' })
  })

  it('keeps a Windows drive, a share, and a colon in a local name in the source', () => {
    expect(parseMountSpec('C:\\data:/data', false)).toEqual({ source: 'C:\\data', target: '/data', access: 'rw' })
    expect(parseMountSpec('\\\\server\\share\\docs:/docs:ro', false)).toEqual({ source: '\\\\server\\share\\docs', target: '/docs', access: 'ro' })
    expect(parseMountSpec('/home/me/a:b:/data', false)).toEqual({ source: '/home/me/a:b', target: '/data', access: 'rw' })
  })

  it('names no mount where a part is missing, or :rw contradicts --read-only', () => {
    for (const spec of ['/home/me/data', '/data', ':/data', '/home/me/data:data', '/home/me/data:/da:ta']) expect(parseMountSpec(spec, false)).toBeNull()
    expect(parseMountSpec('/home/me/data:/data:rw', true)).toBeNull()
  })

  it('prints as it is added, source:target:access', () => {
    expect(formatMount({ source: '/home/me/data', target: '/data', access: 'ro' })).toBe('/home/me/data:/data:ro')
  })
})

describe('where a mount may show', () => {
  const at = (target: string, others: string[] = [], fixed: string[] = []) => mountTargetRefusal(target, { folder: '/workspace', others, fixed })

  it('is a plain absolute path of the sandbox\'s own', () => {
    expect(at('/data')).toBeNull()
    expect(at('/srv/cache')).toBeNull()
    for (const target of ['data', '/data/', '/data/../etc', '/da ta', '/./data', '/']) expect(at(target)).not.toBeNull()
  })

  it('is never a folder the sandbox keeps for the host\'s programs, nor above or inside one, except inside the sandbox home', () => {
    for (const target of ['/usr', '/usr/local/x', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/etc/ssl', '/dev', '/proc', '/sys', '/tmp', '/tmp/x', '/tmp/home']) {
      expect(at(target)).toMatch(/for the host's own programs/)
    }
    expect(at('/tmp/home/.gitconfig')).toBeNull()
  })

  it('never overlaps the folder\'s own target, another mount, or a toolchain the sandbox binds at its own path', () => {
    expect(at('/workspace/data')).toMatch(/where the workspace's folder shows/)
    expect(at('/data/inner', ['/data'])).toMatch(/where another mount shows/)
    expect(at('/data', ['/data/inner'])).toMatch(/where another mount shows/)
    expect(at('/home', [], ['/home/me/.nvm/versions/node/v24'])).toMatch(/toolchain/)
    expect(at('/home/me/.nvm/versions/node/v24/bin', [], ['/home/me/.nvm/versions/node/v24'])).toMatch(/toolchain/)
  })
})

describe('the mount table in workspace.json', () => {
  it('reads the first spelling of the folder\'s access, write, as rw', () => {
    expect(WorkspaceSettingsSchema.parse({ version: 1, mounts: [{ kind: 'workspace', target: '/workspace', access: 'write' }] }).mounts).toEqual([folder])
  })

  it('holds the owner\'s mounts beside the folder\'s entry', () => {
    const settings = WorkspaceSettingsSchema.parse({ version: 1, mounts: [folder, { source: '/home/me/data', target: '/data', access: 'rw' }, { source: '/home/me/docs', target: '/docs', access: 'ro' }] })
    expect(ownerMounts(settings)).toEqual([{ source: '/home/me/data', target: '/data', access: 'rw' }, { source: '/home/me/docs', target: '/docs', access: 'ro' }])
  })

  it.each([
    ['a mount with the folder unmounted', [{ source: '/home/me/data', target: '/data', access: 'rw' }], /needs the workspace's folder mounted/],
    ['two entries for the folder', [folder, { ...folder, target: '/other' }], /one entry for the workspace's folder/],
    ['a reserved target', [folder, { source: '/home/me/data', target: '/etc/data', access: 'rw' }], /for the host's own programs/],
    ['a target inside the folder\'s', [folder, { source: '/home/me/data', target: '/workspace/data', access: 'rw' }], /where the workspace's folder shows/],
    ['two targets in one another', [folder, { source: '/home/me/a', target: '/data', access: 'rw' }, { source: '/home/me/b', target: '/data/b', access: 'rw' }], /where another mount shows/],
    ['two sources in one another', [folder, { source: '/home/me/a', target: '/a', access: 'rw' }, { source: '/home/me/a/b', target: '/b', access: 'ro' }], /overlaps the source/],
    ['a relative source', [folder, { source: 'data', target: '/data', access: 'rw' }], /absolute path/],
    ['an access other than rw or ro', [folder, { source: '/home/me/data', target: '/data', access: 'write' }], /access/],
  ])('refuses %s', (_name, mounts, message) => {
    const parsed = WorkspaceSettingsSchema.safeParse({ version: 1, mounts })
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toMatch(message)
  })

  it('refuses taking the folder\'s mount away while it has mounts of its own, and keeps them when it moves', () => {
    const settings = WorkspaceSettingsSchema.parse({ version: 1, mounts: [folder, { source: '/home/me/data', target: '/data', access: 'rw' }] })
    expect(() => withMount(settings, null)).toThrow(WorkspaceSettingsInvalidError)
    expect(() => withMount(settings, undefined)).toThrow(/remove it first with buckle workspace mount remove/)
    expect(withMount(settings, '/project').mounts).toEqual([{ ...folder, target: '/project' }, { source: '/home/me/data', target: '/data', access: 'rw' }])
  })

  it('writes the folder\'s target in force as its own beside a first mount, and refuses one where the folder shows its real path', () => {
    const unset = WorkspaceSettingsSchema.parse({ version: 1 })
    expect(withOwnerMounts(unset, [{ source: '/home/me/data', target: '/data', access: 'ro' }], '/node').mounts).toEqual([{ ...folder, target: '/node' }, { source: '/home/me/data', target: '/data', access: 'ro' }])
    expect(() => withOwnerMounts(unset, [{ source: '/home/me/data', target: '/data', access: 'ro' }], null)).toThrow(/buckle workspace set mount \/workspace first/)
    // The last one removed leaves the folder's entry, so the node's mounts are the workspace's again.
    const own = WorkspaceSettingsSchema.parse({ version: 1, mounts: [folder, { source: '/home/me/data', target: '/data', access: 'rw' }] })
    expect(withOwnerMounts(own, [], '/workspace').mounts).toEqual([folder])
  })
})

describe('the mounts in force', () => {
  it('are the workspace\'s own where it has any, else the node\'s BUCKLE_MOUNTS read-only and BUCKLE_SCRATCH_ROOTS as scratch', () => {
    const root = scratch()
    mkdirSync(join(root, 'scratch'))
    const node = loadConfig({ BUCKLE_MOUNTS: JSON.stringify([{ source: '/home/me/.docker/config.json', target: '/tmp/home/.docker/config.json' }]), BUCKLE_SCRATCH_ROOTS: join(root, 'scratch') }).workspaceDefaults
    const none = WorkspaceSettingsSchema.parse({ version: 1, mounts: [folder] })
    expect(resolveSettings(none, node)).toMatchObject({
      mounts: [{ source: '/home/me/.docker/config.json', target: '/tmp/home/.docker/config.json', access: 'ro' }, { source: join(root, 'scratch'), target: join(root, 'scratch'), access: 'rw', scratch: true }],
      sources: { mounts: 'node' },
    })
    const own = WorkspaceSettingsSchema.parse({ version: 1, mounts: [folder, { source: '/home/me/data', target: '/data', access: 'rw' }] })
    expect(resolveSettings(own, node)).toMatchObject({ mounts: [{ source: '/home/me/data', target: '/data', access: 'rw' }], sources: { mounts: 'workspace' } })
    expect(resolveSettings(none, loadConfig({}).workspaceDefaults)).toMatchObject({ mounts: [], sources: { mounts: 'built-in' } })
  })

  // Fix brief 4, finding 42: a shell's or an MCP config's env never sets a workspace default, so never a writable folder.
  it('come from the node\'s environment file alone, whatever the caller\'s env says', () => {
    const root = scratch()
    mkdirSync(join(root, 'scratch'))
    const layers = { file: { path: join(root, 'buckle.env'), values: {} }, caller: { BUCKLE_SCRATCH_ROOTS: join(root, 'scratch'), BUCKLE_MOUNTS: '[]' } }
    expect(loadConfig({ ...layers.caller }, process.platform, layers).workspaceDefaults.mounts).toBeUndefined()
    expect(unreadWorkspaceDefaults(layers)).toEqual(['BUCKLE_MOUNTS', 'BUCKLE_SCRATCH_ROOTS'])
  })
})

describe('a workspace\'s writable mount', () => {
  it('is a root no program runs from, for every workspace of the node; a read-only one is not', async () => {
    const root = scratch()
    for (const directory of ['site', 'tools', 'docs']) mkdirSync(join(root, directory))
    const config = loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none' })
    const manager = await workspacesOf(config)
    await registerWorkspace(manager, { id: 'site', dir: join(root, 'site') })
    await manager.updateSettings(idOf(manager, 'site'), settings => withOwnerMounts(settings, [{ source: join(root, 'tools'), target: '/tools', access: 'rw' }, { source: join(root, 'docs'), target: '/docs', access: 'ro' }], '/workspace'))
    const current = nodeRootsOf(config).current()
    expect(current.rootsUnknown).toBeNull()
    expect(current.untrustedRoots).toEqual(expect.arrayContaining([{ path: join(root, 'site'), kind: 'workspace' }, { path: join(root, 'tools'), kind: 'writable mount' }]))
    expect(current.untrustedRoots).not.toContainEqual(expect.objectContaining({ path: join(root, 'docs') }))
    await manager.close()
  })

  it('leaves every program refused while a workspace\'s settings will not read, naming no workspace and no path', async () => {
    const root = scratch()
    mkdirSync(join(root, 'site'))
    const config = loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none' })
    const manager = await workspacesOf(config)
    await registerWorkspace(manager, { id: 'site', dir: join(root, 'site') })
    writeFileSync(settingsPath(config.stateDirectory, idOf(manager, 'site')), '{"version":1,"mounts":"broken"}')
    expect(nodeRootsOf(config).current().rootsUnknown).toBe(MOUNTS_UNREADABLE)
    expect(MOUNTS_UNREADABLE).not.toContain(root)
    await manager.close()
  })
})
