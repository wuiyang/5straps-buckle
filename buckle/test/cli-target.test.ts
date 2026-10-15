import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCli } from './support/cli.js'
import { takeTarget, TargetError } from '../cli/target.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { registerWorkspace, workspaceIdOf, workspacesOf } from './support/workspaces.js'

// D83 (4): a command acts on the workspace it names with --workspace, else the one whose folder holds --dir, else the
// one whose folder holds the directory it runs in; where none does, it refuses and lists the ids, never a folder.

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('takeTarget', () => {
  it.each([
    [['tools', '--workspace', 'site'], { workspace: 'site' }, ['tools']],
    [['--workspace=site', 'policy', 'show'], { workspace: 'site' }, ['policy', 'show']],
    [['policy', 'show', '--dir', 'sub'], { dir: 'sub' }, ['policy', 'show']],
    [['fs', 'read', 'a.md', '--dir=../other'], { dir: '../other' }, ['fs', 'read', 'a.md']],
    // After a `--` every word is the tool's own.
    [['shell', 'exec', '--', 'ls', '--dir', 'x'], {}, ['shell', 'exec', '--', 'ls', '--dir', 'x']],
  ])('reads %j as the target %j, leaving %j', (argv, target, rest) => {
    expect(takeTarget(argv)).toEqual({ target, argv: rest })
  })

  it.each([
    [['tools', '--workspace'], '--workspace needs a value'],
    [['tools', '--dir', '--'], '--dir needs a value'],
    [['tools', '--workspace', 'a', '--workspace', 'b'], '--workspace is given twice'],
    [['tools', '--workspace', 'a', '--dir', 'b'], 'not both'],
  ])('refuses %j', (argv, reason) => {
    expect(() => takeTarget(argv)).toThrow(TargetError)
    expect(() => takeTarget(argv)).toThrow(reason)
  })
})

describe('the workspace a command runs on', () => {
  async function node() {
    const root = mkdtempSync(join(tmpdir(), 'buckle-target-'))
    roots.push(root)
    for (const directory of ['default', join('site', 'src'), 'elsewhere']) mkdirSync(join(root, directory), { recursive: true })
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'default'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' })
    const workspaces = await workspacesOf(config)
    await registerWorkspace(workspaces, { id: 'site', dir: join(root, 'site') })
    mkdirSync(join(root, 'the-site'))
    await workspaces.create({ dir: join(root, 'the-site'), name: 'The site' })
    return { root, config }
  }

  async function run(input: { argv: string[]; config: ReturnType<typeof configFromEnvironment>; cwd: string }) {
    let stdout = ''
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { stdout += String(chunk); return true })
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr += String(chunk); return true })
    const { exitCode } = await runCli(input)
    vi.restoreAllMocks()
    return { exitCode, stdout, stderr }
  }

  const workspaceOf = (stdout: string) => (JSON.parse(stdout) as { name: string }).name

  it('is the one whose folder holds the directory it runs in, the deepest folder in it included', async () => {
    const { root, config } = await node()
    expect(workspaceOf((await run({ argv: ['manifest'], config, cwd: join(root, 'site', 'src') })).stdout)).toBe('site')
    expect(workspaceOf((await run({ argv: ['manifest'], config, cwd: join(root, 'default') })).stdout)).toBe('default')
  })

  it('is the one --workspace names, by name in any case or by id, or whose folder holds --dir, read from where it runs', async () => {
    const { root, config } = await node()
    expect(workspaceOf((await run({ argv: ['manifest', '--workspace', 'site'], config, cwd: join(root, 'elsewhere') })).stdout)).toBe('site')
    expect(workspaceOf((await run({ argv: ['manifest', '--workspace', 'The Site'], config, cwd: join(root, 'elsewhere') })).stdout)).toBe('The site')
    expect(workspaceOf((await run({ argv: ['manifest', '--workspace', workspaceIdOf(join(root, 'the-site'))], config, cwd: join(root, 'elsewhere') })).stdout)).toBe('The site')
    expect(workspaceOf((await run({ argv: ['manifest', '--dir', '../site/src'], config, cwd: join(root, 'elsewhere') })).stdout)).toBe('site')
  })

  it('is refused outside every workspace\'s folder, naming the names and no folder', async () => {
    const { root, config } = await node()
    const refused = await run({ argv: ['tools'], config, cwd: join(root, 'elsewhere') })
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain('No workspace holds the current directory. Name one with --workspace <name> (default, site, The site)')
    expect(refused.stderr).not.toContain(root)
  })

  it('is refused for a name the node does not hold, naming the ones it does', async () => {
    const { root, config } = await node()
    const refused = await run({ argv: ['tools', '--workspace', 'nowhere'], config, cwd: join(root, 'default') })
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain('No workspace is named nowhere. The workspaces: default, site, The site')
  })
})
