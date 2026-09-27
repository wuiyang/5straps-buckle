import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { settingsCommand } from '../src/faces/cli/settings.js'
import { runInit } from '../src/faces/cli/init.js'
import { findWorkspaceConfig, moveWorkspaceConfig, registerWorkspaceConfig, workspaceEnvironmentFile } from '../src/faces/cli/workspace-config.js'

let base: string
let home: string
let root: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'buckle-map-'))
  home = join(base, 'home')
  root = join(base, 'project')
  mkdirSync(home); mkdirSync(root)
  vi.stubEnv('BUCKLE_ENV_FILE', '')
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }) })
const prompt = { interactive: false, question: async () => '', say: () => {}, close: () => {} }
function register(path = root) {
  return registerWorkspaceConfig({ root: path, home, write: entry => writeFileSync(entry.file, `BUCKLE_WORKSPACE_ROOT=${entry.root}\n`, { mode: 0o600 }) })
}
it('initializes private settings and state without replacing project environment files', async () => {
  writeFileSync(join(root, '.env'), 'APPLICATION_FIXTURE=true\n')
  expect((await runInit(['--root', root, '--yes'], prompt, { home })).exitCode).toBe(0)
  const entry = findWorkspaceConfig({ cwd: root, home })!
  const env = parseEnv(readFileSync(entry.file, 'utf8'))
  expect(env).toMatchObject({ BUCKLE_SERVER_ID: entry.id, BUCKLE_STATE_DIR: entry.state, BUCKLE_WORKSPACE_MOUNT: '/workspace' })
  expect(readFileSync(join(root, '.env'), 'utf8')).toBe('APPLICATION_FIXTURE=true\n')
  expect(JSON.parse(readFileSync(join(home, '.5straps/workspaces/map.json'), 'utf8')).workspaces[root]).toBe(entry.id)
  if (process.platform !== 'win32') {
    expect(statSync(entry.file).mode & 0o777).toBe(0o600)
    expect(statSync(entry.directory).mode & 0o777).toBe(0o700)
  }
  const original = readFileSync(entry.file, 'utf8')
  expect((await runInit(['--root', root, '--yes'], prompt, { home })).exitCode).toBe(1)
  expect(readFileSync(entry.file, 'utf8')).toBe(original)
  await runInit(['--root', root, '--yes', '--force'], prompt, { home })
  expect(findWorkspaceConfig({ cwd: root, home })!.id).toBe(entry.id)
})
it('selects the nearest registered ancestor and honors explicit files', () => {
  const parent = register()
  const child = join(root, 'child'); mkdirSync(child)
  expect(workspaceEnvironmentFile({ cwd: child, home })).toBe(parent.file)
  expect(findWorkspaceConfig({ cwd: child, home, exact: true })).toBeNull()
  const nested = register(child)
  expect(nested.id).not.toBe(parent.id)
  expect(workspaceEnvironmentFile({ cwd: child, home })).toBe(nested.file)
  expect(workspaceEnvironmentFile({ cwd: child, home, explicit: 'custom.env' })).toBe(join(child, 'custom.env'))
})
it('finds no environment file for an unregistered directory, even one holding a .env', async () => {
  writeFileSync(join(root, '.env'), 'BUCKLE_SERVER_NAME=project file\n')
  expect(workspaceEnvironmentFile({ cwd: root, home })).toBeNull()
  await runInit(['--root', root, '--yes', '--out', join(base, 'custom.env')], prompt, { home })
  expect(existsSync(join(home, '.5straps/workspaces/map.json'))).toBe(false)
})
it('refuses buckle settings without an environment file, naming both ways to get one', async () => {
  let stderr = ''
  vi.mocked(process.stderr.write).mockImplementation(chunk => { stderr += String(chunk); return true })
  expect((await settingsCommand({ argv: ['set', 'shell', 'off'], environment: { BUCKLE_STATE_DIR: join(base, 'state') }, environmentFile: null, cwd: root, home })).exitCode).toBe(1)
  expect(stderr).toContain('buckle init')
  expect(stderr).toContain('BUCKLE_ENV_FILE')
  expect(existsSync(join(root, '.env'))).toBe(false)
})
it('refuses missing or mismatched registered settings', () => {
  const entry = register()
  writeFileSync(entry.file, `BUCKLE_WORKSPACE_ROOT=${home}\n`)
  expect(() => workspaceEnvironmentFile({ cwd: root, home })).toThrow('disagree')
  rmSync(entry.file)
  expect(() => workspaceEnvironmentFile({ cwd: root, home })).toThrow('missing')
})
it('does not publish failed initialization', () => {
  expect(() => registerWorkspaceConfig({ root, home, write: () => { throw new Error('fixture failure') } })).toThrow('fixture failure')
  expect(findWorkspaceConfig({ cwd: root, home })).toBeNull()
})
it('moves roots with stable IDs and refuses collisions before writing', () => {
  const entry = register()
  const next = join(base, 'next'); mkdirSync(next)
  expect(moveWorkspaceConfig({ file: entry.file, root: next, home, write: () => { writeFileSync(entry.file, `BUCKLE_WORKSPACE_ROOT=${next}\n`); return true } })).toBe(true)
  expect(findWorkspaceConfig({ cwd: root, home })).toBeNull()
  expect(findWorkspaceConfig({ cwd: next, home })!.id).toBe(entry.id)
  register(root)
  const write = vi.fn(() => true)
  expect(() => moveWorkspaceConfig({ file: entry.file, root, home, write })).toThrow('another registered workspace')
  expect(write).not.toHaveBeenCalled()
})
it.skipIf(process.platform === 'win32')('canonicalizes aliases to the same workspace', () => {
  const entry = register()
  const alias = join(base, 'alias'); symlinkSync(root, alias)
  expect(findWorkspaceConfig({ cwd: alias, home })!.id).toBe(entry.id)
})
it('refuses roots containing private configuration', () => {
  expect(() => registerWorkspaceConfig({ root: home, home, write: () => {} })).toThrow('private workspace configuration')
})

it('settings root updates registration and refuses unsetting it', async () => {
  await runInit(['--root', root, '--yes'], prompt, { home })
  const entry = findWorkspaceConfig({ cwd: root, home })!
  const next = join(base, 'relocated'); mkdirSync(next)
  const context = { environment: {}, environmentFile: entry.file, cwd: root, home }
  expect((await settingsCommand({ ...context, argv: ['set', 'root', next] })).exitCode).toBe(0)
  expect(workspaceEnvironmentFile({ cwd: next, home })).toBe(entry.file)
  expect((await settingsCommand({ ...context, argv: ['unset', 'root'] })).exitCode).toBe(1)
  expect(findWorkspaceConfig({ cwd: next, home })!.id).toBe(entry.id)
})
