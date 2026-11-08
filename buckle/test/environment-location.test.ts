import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runInit } from '../cli/init.js'
import { settingsCommand } from '../cli/settings.js'
import { defaultEnvironmentFile, environmentFilePath } from '../common/runtime/config.js'
import { loadEnvironmentFile, nodeLocation } from '../common/runtime/environment.js'
import { recordedEnvironmentFiles } from '../common/runtime/environment-files.js'
import { configFromEnvironment } from './support/workspace-config.js'

// Owner ruling (2026-09-28): the node's settings live under ~/.5straps, in buckle.env in its state
// directory, and never in the working directory; BUCKLE_ENV_FILE still names any other file.

let base: string
let home: string
let root: string
let printed: string
// loadEnvironmentFile copies the file's BUCKLE_ values into process.env: restored after each test (review L12 of B18-B19).
let savedEnvironment: NodeJS.ProcessEnv
beforeEach(() => {
  savedEnvironment = { ...process.env }
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
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const name of Object.keys(process.env)) if (!(name in savedEnvironment)) delete process.env[name]
  Object.assign(process.env, savedEnvironment)
  rmSync(base, { recursive: true, force: true })
})

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

  it('refuses a relative BUCKLE_ENV_FILE, which would name another file in every working directory (review L9 of B18-B19)', () => {
    vi.stubEnv('BUCKLE_ENV_FILE', 'custom.env')
    expect(() => environmentFilePath()).toThrow('BUCKLE_ENV_FILE must be an absolute path, not custom.env')
  })

  it('refuses a relative BUCKLE_STATE_DIR too, before anything is created under the working directory (review L13 of B20-B22)', () => {
    vi.stubEnv('BUCKLE_ENV_FILE', '')
    vi.stubEnv('BUCKLE_STATE_DIR', 'rel-state')
    expect(() => environmentFilePath()).toThrow('BUCKLE_STATE_DIR must be an absolute path, not rel-state')
    expect(() => configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: 'rel-state' })).toThrow('BUCKLE_STATE_DIR must be an absolute path')
    expect(existsSync(join(process.cwd(), 'rel-state'))).toBe(false)
  })
})

describe('loading it', () => {
  // The shipped .env.example is meant to be copied into the state directory as buckle.env and edited. It must load
  // from there, so no setting it carries may name the state directory or another environment file, which the file
  // cannot do from inside the state directory (public docs review).
  it('loads the shipped .env.example when it is copied into the state directory as buckle.env', () => {
    const example = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env.example')
    mkdirSync(join(home, '.5straps', 'buckle'), { recursive: true })
    copyFileSync(example, stateFile())
    expect(loadEnvironmentFile()).toMatchObject({ file: stateFile(), openToOthers: expect.any(Boolean) })
    const set = parseEnv(readFileSync(example, 'utf8'))
    expect(set.BUCKLE_ENV_FILE).toBeUndefined()
    expect(set.BUCKLE_STATE_DIR).toBeUndefined()
  })

  it('reads the state directory file and never a file in the working directory', async () => {
    expect((await runInit(['--root', root, '--name', 'State node', '--yes'], prompt)).exitCode).toBe(0)
    writeFileSync(join(root, 'buckle.env'), 'BUCKLE_SERVER_NAME=from-the-project\n')
    vi.stubEnv('BUCKLE_SERVER_NAME', undefined)
    expect(loadEnvironmentFile()).toMatchObject({ file: stateFile(), openToOthers: false })
    expect(process.env.BUCKLE_SERVER_NAME).toBe('State node')
  })

  it('refuses to start beside a working-directory .env that sets BUCKLE_ variables, naming the file it reads and BUCKLE_ENV_FILE', () => {
    writeFileSync(join(root, '.env'), 'BUCKLE_SERVER_NAME=project file\n')
    expect(() => loadEnvironmentFile()).toThrow(`${join(root, '.env')} sets BUCKLE_ variables, but Buckle never reads the working directory: its settings live in ${stateFile()}, or in the file BUCKLE_ENV_FILE names.`)
    // Named explicitly, the owner has chosen: the project file is not a question any more.
    vi.stubEnv('BUCKLE_ENV_FILE', join(base, 'absent.env'))
    expect(loadEnvironmentFile()).toMatchObject({ file: null, openToOthers: false })
  })

  it('leaves a .env without BUCKLE_ variables alone', () => {
    writeFileSync(join(root, '.env'), 'APPLICATION_FIXTURE=true\n')
    expect(loadEnvironmentFile()).toMatchObject({ file: null, openToOthers: false })
  })

  it('refuses an environment file that names another one, so settings and serve read the same file (review L9 of B18-B19)', async () => {
    expect((await runInit(['--root', root, '--yes'], prompt)).exitCode).toBe(0)
    writeFileSync(stateFile(), `${readFileSync(stateFile(), 'utf8')}BUCKLE_ENV_FILE=${join(base, 'other.env')}\n`)
    expect(() => loadEnvironmentFile()).toThrow(`${stateFile()} sets BUCKLE_ENV_FILE, but an environment file cannot name another one`)
    expect(process.env.BUCKLE_ENV_FILE).toBeUndefined()
    // The same when the shell named this file.
    const named = join(base, 'named.env')
    writeFileSync(named, `BUCKLE_ENV_FILE=${join(base, 'third.env')}\n`, { mode: 0o600 })
    vi.stubEnv('BUCKLE_ENV_FILE', named)
    expect(() => loadEnvironmentFile()).toThrow('cannot name another one')
  })

  it('refuses a folder where the settings file should be, naming it, in the start and in the node\'s location', () => {
    const named = join(base, 'settings', 'node.env')
    mkdirSync(named, { recursive: true })
    vi.stubEnv('BUCKLE_ENV_FILE', named)
    const refusal = `${named} is a folder, not the node's settings file: remove it, then write the settings there with buckle init --out ${named}`
    expect(() => loadEnvironmentFile()).toThrow(refusal)
    expect(() => nodeLocation()).toThrow(refusal)
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

    const written = parseEnv(readFileSync(stateFile(), 'utf8'))
    for (const key of ['BUCKLE_WORKSPACE_ROOT', 'BUCKLE_WORKSPACE_MOUNT', 'BUCKLE_STATE_DIR']) expect(written[key]).toBeUndefined()
    // D83 (2): the folder is a workspace in the registry beside the file, with its settings in its own workspace.json.
    const registry = JSON.parse(readFileSync(join(home, '.5straps', 'buckle', 'workspaces.json'), 'utf8')) as { workspaces: { id: string; dir: string }[] }
    expect(registry.workspaces.map(workspace => workspace.dir)).toEqual([root])
    expect(existsSync(join(home, '.5straps', 'buckle', 'workspaces', registry.workspaces[0]!.id, 'workspace.json'))).toBe(true)
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('APPLICATION_FIXTURE=true\n')
    expect(existsSync(join(home, '.5straps', 'workspaces'))).toBe(false)
    if (process.platform !== 'win32') {
      expect(statSync(stateFile()).mode & 0o777).toBe(0o600)
      expect(statSync(join(home, '.5straps', 'buckle')).mode & 0o777).toBe(0o700)
    }
    expect(printed).toContain(`Wrote ${stateFile()}`)
    expect(printed).toMatch(/Start the node:\s+buckle serve\n/)
  })

  it('keeps the file on a second run, and replaces it with --force', async () => {
    expect((await runInit(['--root', root, '--yes'], prompt)).exitCode).toBe(0)
    const original = readFileSync(stateFile(), 'utf8')
    expect((await runInit(['--root', root, '--yes'], prompt)).exitCode).toBe(0)
    expect(readFileSync(stateFile(), 'utf8')).toBe(original)
    expect(printed).toContain(`The node is already set up in ${stateFile()}; its settings are unchanged.`)
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

  it('records a file --out chose outside the state directory there, for every process on it to protect, and none in it', async () => {
    vi.stubEnv('BUCKLE_STATE_DIR', join(base, 'state'))
    expect((await runInit(['--root', root, '--yes'], prompt)).exitCode).toBe(0)
    expect(recordedEnvironmentFiles(join(base, 'state'))).toEqual([])
    expect((await runInit(['--root', root, '--yes', '--out', join(base, 'custom.env')], prompt)).exitCode).toBe(0)
    expect(recordedEnvironmentFiles(join(base, 'state'))).toEqual([join(base, 'custom.env')])
  })

  it('refuses a workspace folder that holds the state directory', async () => {
    expect((await runInit(['--root', home, '--yes'], prompt)).exitCode).toBe(1)
    expect(printed).toContain('holds the state directory')
    expect(existsSync(stateFile())).toBe(false)
  })
})

describe('buckle settings on the state directory file', () => {
  it('writes the file serve reads, and refuses the workspace folder, a workspace\'s own now', async () => {
    expect((await runInit(['--root', root, '--yes'], prompt)).exitCode).toBe(0)
    const context = { environment: {}, environmentFile: environmentFilePath(), cwd: root, home }
    expect((await settingsCommand({ ...context, argv: ['set', 'name', 'Relocated node'] })).exitCode).toBe(0)
    expect(parseEnv(readFileSync(stateFile(), 'utf8')).BUCKLE_SERVER_NAME).toBe('Relocated node')
    expect((await settingsCommand({ ...context, argv: ['set', 'root', join(base, 'relocated')] })).exitCode).toBe(1)
    expect(printed).toContain('Serve a folder with buckle workspace init --dir <folder>.')
  })
})

