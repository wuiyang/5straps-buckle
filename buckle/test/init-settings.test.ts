import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runInit, serveCommand, type InitPrompt } from '../cli/init.js'
import { defaultEnvironmentFile } from '../common/runtime/environment.js'

let workspace: string
let out: string

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-init-settings-'))
  workspace = join(root, 'workspace')
  out = join(root, 'node.env')
  mkdirSync(workspace)
})

/** Answers the questions in order; the workspace root, mount and name come first. */
function scripted(answers: string[], interactive = true): InitPrompt & { asked: string[]; said: string[] } {
  const queue = [...answers]
  const asked: string[] = []
  const said: string[] = []
  return {
    interactive, asked, said,
    question: async text => { asked.push(text); return queue.shift() ?? '' },
    say: text => void said.push(text),
    close: () => {},
  }
}

async function init(prompt: InitPrompt, extra: string[] = []) {
  let printed = ''
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { printed += String(chunk); return true })
  try {
    const result = await runInit(['--out', out, '--port', '4399', ...extra], prompt)
    return { ...result, printed, written: readFileSync(out, 'utf8') }
  } finally { stdout.mockRestore() }
}

describe('buckle init asks for node settings after the workspace', () => {
  it('shows each default, and Enter keeps the shipped ones', async () => {
    const prompt = scripted([workspace, '', 'Fixture'])
    const result = await init(prompt)

    expect(prompt.asked.slice(3)).toEqual([
      expect.stringContaining('[all]'),
      expect.stringContaining('[Y/n]'),
      expect.stringContaining('[y/N]'),
      expect.stringContaining('[none]'),
      expect.stringContaining('[none]'),
    ])
    expect(prompt.said).toContainEqual('Host Git and forge tools read the repository outside the sandbox\'s per-file checks, so they start off.')
    for (const id of ['fs', 'web', 'git', 'forge', 'dev', 'browser', 'shell', 'environment']) expect(prompt.said.join('\n')).toContain(`  ${id} `)

    const env = parseEnv(result.written)
    expect(env.BUCKLE_SETUP_TOKEN).toBeUndefined()
    expect(env.BUCKLE_ADMIN_TOKEN).toBeTruthy()
    expect(env.BUCKLE_ALLOW_SHELL).toBe('true')
    for (const key of ['BUCKLE_PACKS', 'BUCKLE_ALLOW_HOST_GIT', 'BUCKLE_NETWORK_ALLOW', 'BUCKLE_ALLOWED_HOSTS']) expect(env[key]).toBeUndefined()
    expect(result.written).toContain('# BUCKLE_ALLOW_HOST_GIT=true')
    expect(result.written).toContain('# Host Git and forge tools read the repository outside per-file checks.\n')
  })

  it('writes the answers that move off a default', async () => {
    const result = await init(scripted([workspace, '', 'Fixture', 'fs, shell', 'n', 'y', 'localhost:3000,*.example.com', 'db.internal']))

    const env = parseEnv(result.written)
    expect(env).toMatchObject({
      BUCKLE_PACKS: 'fs,shell',
      BUCKLE_ALLOW_SHELL: 'false',
      BUCKLE_ALLOW_HOST_GIT: 'true',
      BUCKLE_NETWORK_ALLOW: 'localhost:3000,*.example.com',
      BUCKLE_ALLOWED_HOSTS: 'db.internal',
    })
    expect(result.printed).toMatch(/Packs\s+fs, shell/)
    expect(result.printed).toMatch(/Host Git\s+on/)
  })

  it('asks again after an answer the settings check refuses, saying why', async () => {
    const prompt = scripted([workspace, '', 'Fixture', 'fs,rocket', 'fs', 'maybe', '', '', '*', '', '*.0.0.1', ''])
    const result = await init(prompt)

    expect(prompt.said).toContainEqual(expect.stringContaining('Unknown pack rocket'))
    expect(prompt.said).toContainEqual('Answer y or n, or press Enter for the default.')
    expect(prompt.said).toContainEqual(expect.stringContaining('Invalid BUCKLE_NETWORK_ALLOW entry'))
    expect(prompt.said).toContainEqual(expect.stringContaining('Invalid BUCKLE_ALLOWED_HOSTS entry'))
    expect(parseEnv(result.written)).toMatchObject({ BUCKLE_PACKS: 'fs', BUCKLE_ALLOW_SHELL: 'true' })
    expect(parseEnv(result.written).BUCKLE_NETWORK_ALLOW).toBeUndefined()
  })

  it('asks again for the environment pack while BUCKLE_ENV_VALIDATOR_COMMAND is unset, naming it, and takes it once set', async () => {
    vi.stubEnv('BUCKLE_ENV_VALIDATOR_COMMAND', '')
    const refused = scripted([workspace, '', 'Fixture', 'fs,environment', 'fs'])
    expect(parseEnv((await init(refused)).written).BUCKLE_PACKS).toBe('fs')
    expect(refused.said).toContainEqual(expect.stringContaining('environment (BUCKLE_ENV_VALIDATOR_COMMAND is not set)'))

    vi.stubEnv('BUCKLE_ENV_VALIDATOR_COMMAND', 'varlock load')
    const accepted = scripted([workspace, '', 'Fixture', 'fs,environment'])
    expect(parseEnv((await init(accepted, ['--force'])).written).BUCKLE_PACKS).toBe('fs,environment')
    vi.unstubAllEnvs()
  })
})

describe('the command init prints to start the node', () => {
  it('sets the variable before the command on Linux and macOS', () => {
    expect(serveCommand('/srv/node/buckle.env', {}, 'linux')).toBe('BUCKLE_ENV_FILE=/srv/node/buckle.env buckle serve')
    expect(serveCommand('/srv/state/buckle.env', { BUCKLE_STATE_DIR: '/srv/state' }, 'darwin')).toBe('BUCKLE_STATE_DIR=/srv/state buckle serve')
  })

  it('sets it as PowerShell and cmd do on Windows, with cmd\'s quoted whole so no space ends the value', () => {
    expect(serveCommand("/srv/O'Neil/node.env", {}, 'win32')).toBe(`$env:BUCKLE_ENV_FILE = '/srv/O''Neil/node.env'; buckle serve   (PowerShell; in cmd: set "BUCKLE_ENV_FILE=/srv/O'Neil/node.env" && buckle serve)`)
    expect(serveCommand('/srv/state/buckle.env', { BUCKLE_STATE_DIR: '/srv/state' }, 'win32')).toBe(`$env:BUCKLE_STATE_DIR = '/srv/state'; buckle serve   (PowerShell; in cmd: set "BUCKLE_STATE_DIR=/srv/state" && buckle serve)`)
  })

  it('names no variable for the file in the default state directory, on any platform', () => {
    for (const platform of ['linux', 'win32'] as const) expect(serveCommand(defaultEnvironmentFile({}), {}, platform)).toBe('buckle serve')
  })
})

describe('buckle init without questions', () => {
  it.each([
    ['--yes', scripted([], true), ['--yes']],
    ['no terminal', scripted([], false), []],
  ])('keeps the defaults under %s, asks nothing, and prints what it kept', async (_label, prompt, flags) => {
    const result = await init(prompt, ['--root', workspace, ...flags])

    expect(prompt.asked).toEqual([])
    expect(result.exitCode).toBe(0)
    expect(result.printed).toMatch(/Packs\s+all, and plugins/)
    expect(result.printed).toMatch(/Shell\s+on/)
    expect(result.printed).toMatch(/Host Git\s+off/)
    expect(result.printed).toContain('These are the defaults')
    const env = parseEnv(result.written)
    expect(env.BUCKLE_ALLOW_SHELL).toBe('true')
    expect(env.BUCKLE_ALLOW_HOST_GIT).toBeUndefined()
    expect(env.BUCKLE_PACKS).toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32')('buckle init writes the environment file owner-only (RINGS-D20)', () => {
  it('narrows a world-readable file it replaces with --force', async () => {
    writeFileSync(out, 'BUCKLE_PORT=1\n')
    chmodSync(out, 0o644)
    await init(scripted([workspace, '', 'Fixture'], false), ['--force', '--root', workspace])
    expect(statSync(out).mode & 0o777).toBe(0o600)
  })
})

describe('workspace-first initialization defaults', () => {
  it.each([true, false])('uses the current root, /workspace and the full path name (interactive=%s)', async interactive => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(workspace)
    try {
      const env = parseEnv((await init(scripted([], interactive))).written)
      expect(env.BUCKLE_WORKSPACE_ROOT).toBe(workspace)
      expect(env.BUCKLE_WORKSPACE_MOUNT).toBe('/workspace')
      expect(env.BUCKLE_SERVER_NAME).toBe(workspace.replace(/[\\/]/g, '-'))
    } finally { cwd.mockRestore() }
  })
  it('derives the name from an explicit root when accepting defaults with --yes', async () => {
    const env = parseEnv((await init(scripted([]), ['--root', workspace, '--yes'])).written)
    expect(env.BUCKLE_WORKSPACE_MOUNT).toBe('/workspace')
    expect(env.BUCKLE_SERVER_NAME).toBe(workspace.replace(/[\\/]/g, '-'))
  })
  it('preserves explicit mount and name overrides', async () => {
    const env = parseEnv((await init(scripted([]), ['--root', workspace, '--mount', '/project', '--name', 'Demo node', '--yes'])).written)
    expect(env.BUCKLE_WORKSPACE_MOUNT).toBe('/project')
    expect(env.BUCKLE_SERVER_NAME).toBe('Demo node')
  })
})
