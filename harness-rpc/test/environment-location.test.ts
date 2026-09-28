import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runInit } from '../cli/init.js'
import { settingsCommand } from '../cli/settings.js'
import { defaultEnvironmentFile, environmentFilePath, loadEnvironmentFile } from '../common/runtime/environment.js'

// Owner ruling (2026-09-28): the node's settings live under ~/.5straps, in buckle.env in its state
// directory, and never in the working directory; BUCKLE_ENV_FILE still names any other file.

let base: string
let home: string
let root: string
let printed: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'buckle-env-location-'))
  home = join(base, 'home')
  root = join(base, 'project')
  mkdirSync(home); mkdirSync(root)
  vi.stubEnv('HOME', home)
  vi.stubEnv('BUCKLE_ENV_FILE', undefined)
  vi.stubEnv('BUCKLE_STATE_DIR', undefined)
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  printed = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { printed += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { printed += String(chunk); return true })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }) })

const prompt = { interactive: false, question: async () => '', say: () => {}, close: () => {} }
const stateFile = () => join(home, '.5straps', 'buckle', 'buckle.env')

describe('where the environment file is', () => {
  it('is buckle.env in the default state directory, whatever the working directory holds', () => {
    writeFileSync(join(root, 'buckle.env'), 'BUCKLE_SERVER_NAME=from-the-project\n')
    expect(environmentFilePath()).toBe(stateFile())
    expect(defaultEnvironmentFile()).toBe(stateFile())
  })

  it('follows BUCKLE_STATE_DIR from the process environment', () => {
    vi.stubEnv('BUCKLE_STATE_DIR', join(base, 'elsewhere'))
    expect(environmentFilePath()).toBe(join(base, 'elsewhere', 'buckle.env'))
  })

  it('is the file BUCKLE_ENV_FILE names, which overrides the state directory', () => {
    vi.stubEnv('BUCKLE_STATE_DIR', join(base, 'elsewhere'))
    vi.stubEnv('BUCKLE_ENV_FILE', join(base, 'custom.env'))
    expect(environmentFilePath()).toBe(join(base, 'custom.env'))
  })
})

describe('loading it', () => {
  it('reads the state directory file and never a file in the working directory', async () => {
    expect((await runInit(['--root', root, '--name', 'State node', '--yes'], prompt)).exitCode).toBe(0)
    writeFileSync(join(root, 'buckle.env'), 'BUCKLE_SERVER_NAME=from-the-project\n')
    vi.stubEnv('BUCKLE_SERVER_NAME', undefined)
    expect(loadEnvironmentFile()).toEqual({ file: stateFile(), openToOthers: false })
    expect(process.env.BUCKLE_SERVER_NAME).toBe('State node')
  })

  it('refuses to start beside a working-directory .env that sets BUCKLE_ variables, naming the file it reads and BUCKLE_ENV_FILE', () => {
    writeFileSync(join(root, '.env'), 'BUCKLE_SERVER_NAME=project file\n')
    expect(() => loadEnvironmentFile()).toThrow(`${join(root, '.env')} sets BUCKLE_ variables, but Buckle never reads the working directory: its settings live in ${stateFile()}, or in the file BUCKLE_ENV_FILE names.`)
    // Named explicitly, the owner has chosen: the project file is not a question any more.
    vi.stubEnv('BUCKLE_ENV_FILE', join(base, 'absent.env'))
    expect(loadEnvironmentFile()).toEqual({ file: null, openToOthers: false })
  })

  it('leaves a .env without BUCKLE_ variables alone', () => {
    writeFileSync(join(root, '.env'), 'APPLICATION_FIXTURE=true\n')
    expect(loadEnvironmentFile()).toEqual({ file: null, openToOthers: false })
  })

  it('refuses a state directory file that moves the state directory', async () => {
    expect((await runInit(['--root', root, '--yes'], prompt)).exitCode).toBe(0)
    writeFileSync(stateFile(), `${readFileSync(stateFile(), 'utf8')}BUCKLE_STATE_DIR=${join(base, 'other')}\n`)
    expect(() => loadEnvironmentFile()).toThrow('sets BUCKLE_STATE_DIR to another directory')
  })
})

describe('buckle init', () => {
  it('writes buckle.env in the state directory owner-only, and nothing in the project', async () => {
    writeFileSync(join(root, '.env'), 'APPLICATION_FIXTURE=true\n')
    expect((await runInit(['--root', root, '--yes'], prompt)).exitCode).toBe(0)

    expect(parseEnv(readFileSync(stateFile(), 'utf8'))).toMatchObject({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_WORKSPACE_MOUNT: '/workspace' })
    expect(parseEnv(readFileSync(stateFile(), 'utf8')).BUCKLE_STATE_DIR).toBeUndefined()
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('APPLICATION_FIXTURE=true\n')
    expect(existsSync(join(home, '.5straps', 'workspaces'))).toBe(false)
    if (process.platform !== 'win32') {
      expect(statSync(stateFile()).mode & 0o777).toBe(0o600)
      expect(statSync(join(home, '.5straps', 'buckle')).mode & 0o777).toBe(0o700)
    }
    expect(printed).toContain(`Wrote ${stateFile()}`)
    expect(printed).toMatch(/Start the node:\s+buckle serve\n/)
  })

  it('refuses to replace the file without --force, and replaces it with --force', async () => {
    expect((await runInit(['--root', root, '--yes'], prompt)).exitCode).toBe(0)
    const original = readFileSync(stateFile(), 'utf8')
    expect((await runInit(['--root', root, '--yes'], prompt)).exitCode).toBe(1)
    expect(readFileSync(stateFile(), 'utf8')).toBe(original)
    expect((await runInit(['--root', root, '--yes', '--force'], prompt)).exitCode).toBe(0)
    expect(readFileSync(stateFile(), 'utf8')).not.toBe(original)
  })

  it('names the state directory in the start hint when BUCKLE_STATE_DIR moved it, and the file when --out chose one', async () => {
    vi.stubEnv('BUCKLE_STATE_DIR', join(base, 'state'))
    expect((await runInit(['--root', root, '--yes'], prompt)).exitCode).toBe(0)
    expect(printed).toContain(`BUCKLE_STATE_DIR=${join(base, 'state')} buckle serve`)
    expect(existsSync(join(base, 'state', 'buckle.env'))).toBe(true)
    expect((await runInit(['--root', root, '--yes', '--out', join(base, 'custom.env')], prompt)).exitCode).toBe(0)
    expect(printed).toContain(`BUCKLE_ENV_FILE=${join(base, 'custom.env')} buckle serve`)
    if (process.platform !== 'win32') expect(statSync(join(base, 'custom.env')).mode & 0o777).toBe(0o600)
  })

  it('refuses a workspace root that holds the state directory', async () => {
    expect((await runInit(['--root', home, '--yes'], prompt)).exitCode).toBe(1)
    expect(printed).toContain('holds the state directory')
    expect(existsSync(stateFile())).toBe(false)
  })
})

describe('buckle settings on the state directory file', () => {
  it('writes the file serve reads, and refuses to unset its workspace root', async () => {
    expect((await runInit(['--root', root, '--yes'], prompt)).exitCode).toBe(0)
    const next = join(base, 'relocated'); mkdirSync(next)
    const context = { environment: {}, environmentFile: environmentFilePath(), cwd: root, home }
    expect((await settingsCommand({ ...context, argv: ['set', 'root', next] })).exitCode).toBe(0)
    expect(parseEnv(readFileSync(stateFile(), 'utf8')).BUCKLE_WORKSPACE_ROOT).toBe(next)
    expect((await settingsCommand({ ...context, argv: ['unset', 'root'] })).exitCode).toBe(1)
    expect(printed).toContain('must name its workspace root')
  })
})
