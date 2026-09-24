import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileActionLog } from '../src/adapters/action-log/file-action-log.js'
import { runProcess } from '../src/adapters/process-runner.js'
import { createPathView } from '../src/domain/path-view.js'
import { editEnvironmentVariable } from '../src/faces/cli/environment-file.js'
import { settingsCommand } from '../src/faces/cli/settings.js'
import { BUILTIN_PACKS, createBuiltinPacks } from '../src/packs/index.js'

const SECRET = 'fixture-secret-value-never-printed-7f3a'

let root: string
let workspace: string
let state: string
let file: string
let original: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'buckle-settings-'))
  workspace = join(root, 'workspace')
  state = join(root, 'state')
  mkdirSync(workspace)
  file = join(root, 'node.env')
  original = [
    '# Written by a fixture; this comment must survive.',
    'BUCKLE_SERVER_NAME=Fixture node',
    `BUCKLE_AUTH_TOKEN=${SECRET}`,
    `BUCKLE_ADMIN_TOKEN=admin-${SECRET}`,
    `BUCKLE_STATE_DIR=${state}`,
    '',
    '#   an indented comment, spacing kept',
    'BUCKLE_ALLOW_SHELL=true',
    '# BUCKLE_ALLOW_HOST_GIT=true',
    `OTHER_TOOL_TOKEN="quoted ${SECRET}"`,
    '',
  ].join('\n')
  writeFileSync(file, original, { mode: 0o640 })
  chmodSync(file, 0o640)
})

async function settings(argv: string[], environment: NodeJS.ProcessEnv = {}) {
  let out = ''
  let err = ''
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true })
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true })
  try {
    const result = await settingsCommand({ argv, environment, environmentFile: file, cwd: root })
    return { ...result, out, err, printed: out + err }
  } finally { stdout.mockRestore(); stderr.mockRestore() }
}

/** The file with one line swapped, so a test states exactly which bytes may change. */
function withLine(from: string, to: string): string {
  expect(original).toContain(from)
  return original.replace(from, to)
}

describe('buckle settings show', () => {
  it('prints each allow-listed setting with its value and source, and every other key by name alone', async () => {
    const result = await settings(['show'], { BUCKLE_ALLOW_HOST_GIT: 'true' })

    expect(result.exitCode).toBe(0)
    expect(result.out).toMatch(/name\s+BUCKLE_SERVER_NAME\s+Fixture node\s+environment file/)
    expect(result.out).toMatch(/shell\s+BUCKLE_ALLOW_SHELL\s+true\s+environment file/)
    expect(result.out).toMatch(/host-git\s+BUCKLE_ALLOW_HOST_GIT\s+true\s+process environment\n/)
    expect(result.out).toMatch(/packs\s+BUCKLE_PACKS\s+\(every built-in pack, and plugins\)\s+default/)
    expect(result.out).toContain('BUCKLE_AUTH_TOKEN (set, hidden)')
    expect(result.out).toContain('BUCKLE_ADMIN_TOKEN (set, hidden)')
    expect(result.out).toContain('OTHER_TOOL_TOKEN (set, hidden)')
    expect(result.printed).not.toContain(SECRET)
  })

  it('names the process environment when it overrides the file', async () => {
    const result = await settings(['show'], { BUCKLE_ALLOW_SHELL: 'false' })

    expect(result.out).toMatch(/shell\s+BUCKLE_ALLOW_SHELL\s+false\s+process environment, over the file/)
  })

  it('never prints a secret that sits in the process environment either', async () => {
    const result = await settings(['show'], { BUCKLE_AUTH_TOKEN: `env-${SECRET}`, BUCKLE_FORGE_GITHUB_TOKEN: `forge-${SECRET}` })

    expect(result.printed).not.toContain(SECRET)
  })
})

describe('buckle settings set', () => {
  it('writes one key, keeps every other byte, comments and secrets included, and says a restart is needed', async () => {
    const result = await settings(['set', 'host-git', 'on'])

    expect(result.exitCode).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(withLine('# BUCKLE_ALLOW_HOST_GIT=true', 'BUCKLE_ALLOW_HOST_GIT=true'))
    expect(result.out).toContain('Restart buckle serve')
    expect(result.printed).not.toContain(SECRET)
  })

  it('replaces the value in place and keeps the file mode bits', async () => {
    await settings(['set', 'BUCKLE_ALLOW_SHELL', 'off'])

    expect(readFileSync(file, 'utf8')).toBe(withLine('BUCKLE_ALLOW_SHELL=true', 'BUCKLE_ALLOW_SHELL=false'))
    expect(statSync(file).mode & 0o7777).toBe(0o640)
  })

  it('leaves no temporary file behind', async () => {
    await settings(['set', 'packs', 'fs, web,shell'])

    expect(readdirSync(root).sort()).toEqual(['node.env', 'state', 'workspace'])
    expect(readFileSync(file, 'utf8')).toBe(`${original}BUCKLE_PACKS=fs,web,shell\n`)
  })

  it('records an audit entry naming the key and the value', async () => {
    await settings(['set', 'network-allow', 'localhost:3000,*.example.com'])

    const entries = createFileActionLog(join(state, 'actions.jsonl')).read(10)
    expect(entries.at(-1)).toMatchObject({ tool: 'cli_settings', outcome: 'ok', detail: 'BUCKLE_NETWORK_ALLOW=localhost:3000,*.example.com' })
    expect(JSON.stringify(entries)).not.toContain(SECRET)
  })

  it('writes directories as absolute paths, resolved from where it runs', async () => {
    await settings(['set', 'root', 'workspace'])

    expect(readFileSync(file, 'utf8')).toContain(`BUCKLE_WORKSPACE_ROOT=${workspace}\n`)
  })

  it('quotes a value the plain form would read differently', async () => {
    await settings(['set', 'name', 'Build box # two'])

    expect(readFileSync(file, 'utf8')).toBe(withLine('BUCKLE_SERVER_NAME=Fixture node', 'BUCKLE_SERVER_NAME="Build box # two"'))
  })

  it('warns when the process environment will still override the file', async () => {
    const result = await settings(['set', 'shell', 'off'], { BUCKLE_ALLOW_SHELL: 'true' })

    expect(result.exitCode).toBe(0)
    expect(result.out).toContain('also set in this shell')
  })

  it.each([
    [['set', 'BUCKLE_AUTH_TOKEN', 'x'], 'is not a node setting'],
    [['set', 'BUCKLE_SANDBOX', 'none'], 'is not a node setting'],
    [['set', 'OTHER_TOOL_TOKEN', 'x'], 'is not a node setting'],
    [['unset', 'BUCKLE_ADMIN_TOKEN'], 'is not a node setting'],
    [['set', 'shell', 'maybe'], 'on or off'],
    [['set', 'packs', 'fs,rocket'], 'Unknown pack rocket'],
    [['set', 'packs', ','], 'at least one pack'],
    [['set', 'allowed-hosts', '*'], 'Invalid BUCKLE_ALLOWED_HOSTS entry'],
    [['set', 'allowed-hosts', '*.127.0.0.1'], 'Invalid BUCKLE_ALLOWED_HOSTS entry'],
    [['set', 'network-allow', 'not a host'], 'Invalid BUCKLE_NETWORK_ALLOW entry'],
    [['set', 'root', 'missing-directory'], 'is not an existing directory'],
    [['set', 'scratch-roots', `${workspace},nowhere`], 'is not an existing directory'],
    [['set', 'mount', '/usr'], 'Cannot mount the workspace under /usr'],
    [['set', 'mount', 'relative'], 'Invalid mount path'],
    [['set', 'name', 'two\nlines'], 'newline'],
    [['set', 'name', 'a "quoted" name'], 'double quote'],
    [['set', 'shell'], 'Usage'],
    [['frobnicate'], 'Usage'],
  ])('refuses %j without touching the file', async (argv, message) => {
    const result = await settings(argv)

    expect(result.exitCode).toBe(1)
    expect(result.err).toContain(message)
    expect(readFileSync(file, 'utf8')).toBe(original)
  })

  it('names the file to edit by hand when it refuses a key', async () => {
    const result = await settings(['set', 'BUCKLE_FORGE_GITHUB_TOKEN', 'x'])

    expect(result.err).toContain(`Edit ${file} by hand`)
  })

  it('refuses a workspace root that holds the state directory', async () => {
    const result = await settings(['set', 'root', root])

    expect(result.exitCode).toBe(1)
    expect(result.err).toContain('holds the state directory')
    expect(readFileSync(file, 'utf8')).toBe(original)
  })

  it('refuses when there is no environment file yet, and audits the refusal', async () => {
    file = join(root, 'absent.env')
    const result = await settings(['set', 'shell', 'off'], { BUCKLE_STATE_DIR: state })

    expect(result.exitCode).toBe(1)
    expect(result.err).toContain('buckle init')
    expect(createFileActionLog(join(state, 'actions.jsonl')).read(10).at(-1)).toMatchObject({ tool: 'cli_settings', outcome: 'error' })
  })
})

describe('buckle settings unset', () => {
  it('removes the line so the default applies, keeping the rest', async () => {
    const result = await settings(['unset', 'shell'])

    expect(result.exitCode).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(withLine('BUCKLE_ALLOW_SHELL=true\n', ''))
    expect(result.out).toContain('the default applies: true')
  })

  it('reports a key that is not in the file and writes nothing', async () => {
    const before = statSync(file).mtimeMs
    const result = await settings(['unset', 'packs'])

    expect(result.exitCode).toBe(0)
    expect(result.out).toContain('nothing to remove')
    expect(statSync(file).mtimeMs).toBe(before)
  })
})

describe('an environment file this command will not edit line by line', () => {
  it.each([
    ['written twice', 'BUCKLE_ALLOW_SHELL=true\nBUCKLE_ALLOW_SHELL=false\n'],
    ['exported', 'export BUCKLE_ALLOW_SHELL=true\n'],
    ['spaced', 'BUCKLE_ALLOW_SHELL = true\n'],
  ])('refuses a key %s', (_label, text) => {
    expect(editEnvironmentVariable({ text, name: 'BUCKLE_ALLOW_SHELL', value: 'false' }).ok).toBe(false)
  })

  it('refuses a value that spans quoted lines rather than cut it in half', () => {
    const text = `BUCKLE_NETWORK_ALLOW="a.test\nb.test"\nBUCKLE_AUTH_TOKEN=${SECRET}\n`

    expect(editEnvironmentVariable({ text, name: 'BUCKLE_NETWORK_ALLOW', value: 'c.test' }).ok).toBe(false)
    expect(editEnvironmentVariable({ text, name: 'BUCKLE_NETWORK_ALLOW', value: null }).ok).toBe(false)
  })
})

describe('the pack catalogue init and settings name', () => {
  it('lists every built-in pack createBuiltinPacks builds, in the same order', () => {
    const paths = createPathView({ root, mount: null, scratchRoots: [] })
    const sandbox = { mode: 'none', supportsMount: false, wrap: (input: never) => input } as never
    const packs = createBuiltinPacks({
      cwd: root, paths, runProcess, sandbox, writableRoots: [root], hiddenPaths: [], mountReadOnlyPaths: [], approvedUrls: null,
      forge: { apiUrl: 'https://api.github.com', author: { name: 'a', email: 'a@b.c' } }, stateDirectory: state, allowedHosts: [],
      agentBrowserCommand: 'agent-browser', browserStateDirectory: state, browserHeaded: false, enableShell: false,
      environmentValidator: 'varlock', sandboxUnavailableReason: null,
    })

    expect(packs.map(pack => pack.id)).toEqual(BUILTIN_PACKS.map(pack => pack.id))
  })
})
