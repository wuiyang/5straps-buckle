import { execFile } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv, promisify } from 'node:util'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { runProcess } from '../common/adapters/process-runner.js'
import { createPathView } from '../common/domain/path-view.js'
import { acquireFileLock } from '@5straps/runtime/sqlite'
import { editEnvironmentVariable, environmentLockPath } from '../cli/environment-file.js'
import { settingsCommand } from '../cli/settings.js'
import { holdLockInProcess, killHolder } from './support/lock-holder.js'
import { BUILTIN_PACKS, createBuiltinPacks, unmetPackPrerequisite } from '../common/services/packs/index.js'

const SECRET = 'fixture-secret-value-never-printed-7f3a'

let root: string
let home: string
let workspace: string
let state: string
let file: string
let original: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'buckle-settings-'))
  home = mkdtempSync(join(tmpdir(), 'buckle-settings-home-'))
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
    'BUCKLE_EXPERIMENTAL_ADMIN_HTTP=false',
    '# BUCKLE_ALLOWED_HOSTS=db.internal',
    // A workspace setting a 0.1 node kept here, which migration copied and the node now ignores.
    'BUCKLE_ALLOW_SHELL=true',
    `OTHER_TOOL_TOKEN="quoted ${SECRET}"`,
    '',
  ].join('\n')
  writeFileSync(file, original, { mode: 0o640 })
  chmodSync(file, 0o640)
})

async function settings(argv: string[], environment: NodeJS.ProcessEnv = {}, environmentFile: string = file) {
  let out = ''
  let err = ''
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true })
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true })
  try {
    const result = await settingsCommand({ argv, environment, environmentFile, cwd: root, home })
    return { ...result, out, err, printed: out + err }
  } finally { stdout.mockRestore(); stderr.mockRestore() }
}

/** The file with one line swapped, so a test states exactly which bytes may change. */
function withLine(from: string, to: string): string {
  expect(original).toContain(from)
  return original.replace(from, to)
}

describe('buckle settings show', () => {
  it('shows the process environment and the defaults before the environment file is written, and only a write needs it', async () => {
    const absent = join(state, 'buckle.env')
    const shown = await settings(['show'], { BUCKLE_STATE_DIR: state, BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true' }, absent)

    expect(shown.exitCode).toBe(0)
    expect(shown.out).toContain(`from the process environment and the defaults (${absent} is not written yet; buckle init writes it)`)
    expect(shown.out).toMatch(/experimental-admin-http\s+BUCKLE_EXPERIMENTAL_ADMIN_HTTP\s+true\s+process environment\n/)
    expect(shown.out).toMatch(/name\s+BUCKLE_SERVER_NAME\s+.+default\n/)
    expect((await settings([], { BUCKLE_STATE_DIR: state }, absent)).exitCode).toBe(0)
    const refused = await settings(['set', 'name', 'Later'], { BUCKLE_STATE_DIR: state }, absent)
    expect(refused.exitCode).toBe(1)
    expect(refused.printed).toContain(`${absent} does not exist. Run buckle init first, or point BUCKLE_ENV_FILE at the node's environment file.`)
  })

  it('prints each allow-listed setting with its value and source, and every other key by name alone', async () => {
    const result = await settings(['show'], { BUCKLE_ALLOWED_HOSTS: 'db.internal' })

    expect(result.exitCode).toBe(0)
    expect(result.out).toMatch(/name\s+BUCKLE_SERVER_NAME\s+Fixture node\s+environment file/)
    expect(result.out).toMatch(/experimental-admin-http\s+BUCKLE_EXPERIMENTAL_ADMIN_HTTP\s+false\s+environment file/)
    expect(result.out).toMatch(/allowed-hosts\s+BUCKLE_ALLOWED_HOSTS\s+db.internal\s+process environment\n/)
    expect(result.out).toMatch(/read-only-paths\s+BUCKLE_MOUNT_READ_ONLY\s+\(none\)\s+default/)
    // Q14: a workspace setting the file still holds is named as ignored, with the command that changes it now.
    expect(result.out).toMatch(/which the node ignores here \(unset them\):\n\s+BUCKLE_ALLOW_SHELL\s+buckle workspace set packs.shell on\|off\n/)
    expect(result.out).toContain('BUCKLE_AUTH_TOKEN (set, hidden)')
    expect(result.out).toContain('BUCKLE_ADMIN_TOKEN (set, hidden)')
    expect(result.out).toContain('OTHER_TOOL_TOKEN (set, hidden)')
    expect(result.printed).not.toContain(SECRET)
  })

  it('names the process environment when it overrides the file', async () => {
    const result = await settings(['show'], { BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true' })

    expect(result.out).toMatch(/experimental-admin-http\s+BUCKLE_EXPERIMENTAL_ADMIN_HTTP\s+true\s+process environment, over the file/)
  })

  it('never prints a secret that sits in the process environment either', async () => {
    const result = await settings(['show'], { BUCKLE_AUTH_TOKEN: `env-${SECRET}`, BUCKLE_FORGE_GITHUB_TOKEN: `forge-${SECRET}` })

    expect(result.printed).not.toContain(SECRET)
  })
})

describe('buckle settings set', () => {
  it('writes one key, keeps every other byte, comments and secrets included, and says a restart is needed', async () => {
    const result = await settings(['set', 'allowed-hosts', 'db.internal'])

    expect(result.exitCode).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(withLine('# BUCKLE_ALLOWED_HOSTS=db.internal', 'BUCKLE_ALLOWED_HOSTS=db.internal'))
    expect(result.out).toContain('Restart buckle serve')
    expect(result.printed).not.toContain(SECRET)
  })

  it('replaces the value in place and leaves the file owner-only (RINGS-D20)', async () => {
    await settings(['set', 'BUCKLE_EXPERIMENTAL_ADMIN_HTTP', 'on'])

    expect(readFileSync(file, 'utf8')).toBe(withLine('BUCKLE_EXPERIMENTAL_ADMIN_HTTP=false', 'BUCKLE_EXPERIMENTAL_ADMIN_HTTP=true'))
    expect(statSync(file).mode & 0o7777).toBe(0o600)
  })

  // Q14: each workspace holds these in its workspace.json now; the file's line is migration input alone.
  it.each([
    ['shell', 'buckle workspace set packs.shell on|off'],
    ['code', 'buckle workspace set packs.code on|off'],
    ['packs', 'buckle workspace set packs.enabled <packs>'],
    ['approval-wait', 'buckle workspace set approvalWaitMs <milliseconds>'],
    ['network-allow', 'buckle policy allow-url <host>'],
    ['allowed-interpreters', 'buckle policy allow-interpreter <name>'],
    ['root', 'buckle workspace init --dir <folder>'],
    ['mount', 'buckle policy mount <path>'],
    ['BUCKLE_ALLOW_HOST_GIT', 'buckle workspace set packs.hostGit on|off'],
  ])('refuses to set %s, a workspace setting now, naming the command that changes it', async (key, replacement) => {
    const result = await settings(['set', key, 'x'])

    expect(result.exitCode).toBe(1)
    expect(result.err).toContain(`is a workspace setting since the workspace model, and the node ignores it in ${file}. Change it with ${replacement}.`)
    expect(readFileSync(file, 'utf8')).toBe(original)
  })

  it('removes a workspace setting\'s line, which migration already copied', async () => {
    const result = await settings(['unset', 'shell'])

    expect(result.exitCode).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(withLine('BUCKLE_ALLOW_SHELL=true\n', ''))
  })

  it('leaves no temporary file behind', async () => {
    await settings(['set', 'name', 'Renamed'])

    expect(readdirSync(root).sort()).toEqual(['node.env', 'state', 'workspace'])
    expect(readFileSync(file, 'utf8')).toBe(withLine('BUCKLE_SERVER_NAME=Fixture node', 'BUCKLE_SERVER_NAME=Renamed'))
  })

  it('records an audit entry naming the key and the value', async () => {
    await settings(['set', 'allowed-hosts', 'db.internal,*.internal.test'])

    const entries = createFileActionLog(join(state, 'actions.jsonl')).read(10)
    expect(entries.at(-1)).toMatchObject({ tool: 'cli_settings', outcome: 'ok', detail: 'BUCKLE_ALLOWED_HOSTS=db.internal,*.internal.test' })
    expect(JSON.stringify(entries)).not.toContain(SECRET)
  })

  it('switches the experimental admin HTTP layer, off by default, and audits the change (owner decision D8)', async () => {
    expect((await settings(['show'])).out).toMatch(/experimental-admin-http +BUCKLE_EXPERIMENTAL_ADMIN_HTTP +false +environment file/)
    expect((await settings(['set', 'experimental-admin-http', 'on'])).exitCode).toBe(0)
    expect(parseEnv(readFileSync(file, 'utf8')).BUCKLE_EXPERIMENTAL_ADMIN_HTTP).toBe('true')
    expect((await settings(['show'])).out).toMatch(/experimental-admin-http +BUCKLE_EXPERIMENTAL_ADMIN_HTTP +true +environment file/)
    expect((await settings(['unset', 'experimental-admin-http'])).exitCode).toBe(0)
    const entries = createFileActionLog(join(state, 'actions.jsonl')).read(10).filter(entry => entry.tool === 'cli_settings' && entry.event === 'result')
    expect(entries.map(entry => entry.detail)).toEqual([undefined, 'BUCKLE_EXPERIMENTAL_ADMIN_HTTP=true', undefined, 'BUCKLE_EXPERIMENTAL_ADMIN_HTTP unset'])
  })

  it('writes directories as absolute paths, resolved from where it runs', async () => {
    await settings(['set', 'read-only-paths', 'workspace'])

    expect(readFileSync(file, 'utf8')).toContain(`BUCKLE_MOUNT_READ_ONLY=${workspace}\n`)
  })

  it('quotes a value the plain form would read differently', async () => {
    await settings(['set', 'name', 'Build box # two'])

    expect(readFileSync(file, 'utf8')).toBe(withLine('BUCKLE_SERVER_NAME=Fixture node', 'BUCKLE_SERVER_NAME="Build box # two"'))
  })

  it('warns when the process environment will still override the file', async () => {
    const result = await settings(['set', 'experimental-admin-http', 'on'], { BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'false' })

    expect(result.exitCode).toBe(0)
    expect(result.out).toContain('also set in this shell')
  })

  it.each([
    [['set', 'BUCKLE_AUTH_TOKEN', 'x'], 'is not a node setting'],
    [['set', 'BUCKLE_SANDBOX', 'none'], 'is not a node setting'],
    [['set', 'OTHER_TOOL_TOKEN', 'x'], 'is not a node setting'],
    [['unset', 'BUCKLE_ADMIN_TOKEN'], 'is not a node setting'],
    [['set', 'experimental-admin-http', 'maybe'], 'on or off'],
    [['set', 'allowed-hosts', '*'], 'Invalid BUCKLE_ALLOWED_HOSTS entry'],
    [['set', 'allowed-hosts', '*.127.0.0.1'], 'Invalid BUCKLE_ALLOWED_HOSTS entry'],
    [['set', 'allowed-hosts', ','], 'needs at least one entry'],
    [['set', 'scratch-roots', `${workspace},nowhere`], 'is not an existing directory'],
    [['set', 'name', 'two\nlines'], 'newline'],
    [['set', 'name', 'a "quoted" name'], 'double quote'],
    [['set', 'name'], 'Usage'],
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

  it('refuses when there is no environment file yet, and audits the refusal', async () => {
    file = join(root, 'absent.env')
    const result = await settings(['set', 'name', 'Later'], { BUCKLE_STATE_DIR: state })

    expect(result.exitCode).toBe(1)
    expect(result.err).toContain('buckle init')
    expect(createFileActionLog(join(state, 'actions.jsonl')).read(10).at(-1)).toMatchObject({ tool: 'cli_settings', outcome: 'error' })
  })
})

describe('buckle settings unset', () => {
  it('removes the line so the default applies, keeping the rest', async () => {
    const result = await settings(['unset', 'experimental-admin-http'])

    expect(result.exitCode).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(withLine('BUCKLE_EXPERIMENTAL_ADMIN_HTTP=false\n', ''))
    expect(result.out).toContain('the default applies: false')
  })

  it('reports a key that is not in the file and writes nothing', async () => {
    const before = statSync(file).mtimeMs
    const result = await settings(['unset', 'allowed-hosts'])

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

describe('buckle settings against other writers and links', () => {
  const entry = fileURLToPath(new URL('../main.ts', import.meta.url))

  function settingsProcess(...argv: string[]) {
    return promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), entry, 'settings', ...argv], {
      cwd: root, env: { PATH: process.env.PATH, HOME: home, BUCKLE_ENV_FILE: file },
    })
  }

  it('keeps every change when three set commands run at once', async () => {
    for (let round = 0; round < 2; round += 1) {
      writeFileSync(file, original)
      await Promise.all([
        settingsProcess('set', 'experimental-admin-http', 'on'),
        settingsProcess('set', 'allowed-hosts', 'db.internal'),
        settingsProcess('set', 'name', 'Concurrent'),
      ])

      expect(parseEnv(readFileSync(file, 'utf8'))).toMatchObject({ BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true', BUCKLE_ALLOWED_HOSTS: 'db.internal', BUCKLE_SERVER_NAME: 'Concurrent', BUCKLE_AUTH_TOKEN: SECRET })
      // The lock lives under ~/.5straps/locks, never beside the file.
      expect(readdirSync(root).sort()).toEqual(['node.env', 'state', 'workspace'])
      expect(readdirSync(join(home, '.5straps', 'locks'))).toEqual([basename(environmentLockPath({ target: realpathSync(file), home }))])
    }
  }, 30_000)

  it('waits for a writer holding the lock, then edits the text that writer left', async () => {
    const lock = await acquireFileLock({ path: environmentLockPath({ target: realpathSync(file), home }), wait: 'none' })
    const waiting = settingsProcess('set', 'experimental-admin-http', 'on')
    await new Promise(resolve => setTimeout(resolve, 1_500))
    expect(readFileSync(file, 'utf8')).toBe(original)

    const other = withLine('BUCKLE_SERVER_NAME=Fixture node', 'BUCKLE_SERVER_NAME=Written meanwhile')
    writeFileSync(file, other)
    await lock.release()
    await waiting

    expect(parseEnv(readFileSync(file, 'utf8'))).toMatchObject({ BUCKLE_SERVER_NAME: 'Written meanwhile', BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true' })
  }, 30_000)

  it('edits the target of a symlinked environment file and keeps the link', async () => {
    mkdirSync(join(root, 'real'))
    const target = join(root, 'real', 'target.env')
    writeFileSync(target, original, { mode: 0o640 })
    const link = join(root, 'linked.env')
    symlinkSync(target, link)
    file = link

    expect((await settings(['set', 'experimental-admin-http', 'on'])).exitCode).toBe(0)

    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe(withLine('BUCKLE_EXPERIMENTAL_ADMIN_HTTP=false', 'BUCKLE_EXPERIMENTAL_ADMIN_HTTP=true'))
    expect(statSync(target).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(root, 'real'))).toEqual(['target.env'])
  })

  it('writes at once after a writer holding the lock is killed, with no stale-lock wait', async () => {
    await killHolder(await holdLockInProcess(environmentLockPath({ target: realpathSync(file), home })))

    const started = Date.now()
    expect((await settings(['set', 'experimental-admin-http', 'on'])).exitCode).toBe(0)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(parseEnv(readFileSync(file, 'utf8')).BUCKLE_EXPERIMENTAL_ADMIN_HTTP).toBe('true')
  }, 30_000)
})

describe('the pack catalogue init and settings name', () => {
  function built(environmentValidator: string | undefined): string[] {
    const paths = createPathView({ root, mount: null, scratchRoots: [] })
    const sandbox = { mode: 'none', supportsMount: false, wrap: (input: never) => input } as never
    return createBuiltinPacks({
      cwd: root, paths, runProcess, sandbox, writableRoots: [root], hiddenPaths: [], mountReadOnlyPaths: [], approvedUrls: null, approvedLists: [],
      forge: { apiUrl: 'https://api.github.com', author: { name: 'a', email: 'a@b.c' } }, stateDirectory: state, allowedHosts: [],
      agentBrowserCommand: 'agent-browser', browserStateDirectory: state, browserHeaded: false, enableShell: false,
      environmentValidator, sandboxUnavailableReason: null,
    }).map(pack => pack.id)
  }

  it.each([['with', 'varlock'], ['without', undefined]])('builds exactly the catalogue packs whose prerequisites are met, %s a validator', (_, environmentValidator) => {
    expect(built(environmentValidator)).toEqual(BUILTIN_PACKS.filter(pack => unmetPackPrerequisite(pack.id, { environmentValidator }) === null).map(pack => pack.id))
  })

  it('builds the code pack whatever the settings: packs.code off withholds it with a reason instead', () => {
    expect(BUILTIN_PACKS.map(pack => pack.id)).toContain('code')
    expect(unmetPackPrerequisite('code', {})).toBeNull()
    expect(built(undefined)).toContain('code')
  })

})
