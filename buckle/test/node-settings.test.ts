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
import { editEnvironmentVariable, environmentLockPath } from '../common/adapters/environment-file.js'
import { NODE_SETTINGS } from '../cli/node-settings.js'
import { settingsCommand } from '../cli/settings.js'
import { loadConfig, WORKSPACE_DEFAULT_KEYS } from '../common/runtime/config.js'
import { defaultSettings, resolveSettings } from '../common/services/workspaces/workspace-settings.js'
import { holdLockInProcess, killHolder } from './support/lock-holder.js'
import { BUILTIN_PACKS, createBuiltinPacks, unmetPackPrerequisite } from '../common/services/packs/index.js'
import { auditEntries, settleAuditLogs } from './support/action-log-writer.js'

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
    // A workspace default (D85, Q3): every workspace whose own settings leave packs.shell unset takes it.
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
    // As the command's process does before it exits: what it queued for its audit log is written.
    await settleAuditLogs()
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

  // A node with no file reads no workspace default from the environment (the process entry's layers), so show says a
  // shell's value is not read, as policy show and workspace show then print the defaults.
  it('shows a workspace default this shell sets as not read where the node has no environment file, and says so once', async () => {
    const absent = join(state, 'buckle.env')
    const shown = await settings(['show'], { BUCKLE_STATE_DIR: state, BUCKLE_COMMAND_DENY: 'curl *', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true' }, absent)
    expect(shown.exitCode).toBe(0)
    expect(shown.out).toMatch(/BUCKLE_COMMAND_DENY\s+\(none\)\s+default; this shell's value is not read\n/)
    expect(shown.out).toMatch(/BUCKLE_SHELL_ISOLATION\s+\S+\s+default; this shell's value is not read\n/)
    expect(shown.out).not.toContain('curl *')
    expect(shown.out.match(/This node has no buckle.env, so it reads none of these from the environment: run buckle init, then buckle settings set <key> <value>./g)).toHaveLength(1)
    // A node setting is still the process environment's.
    expect(shown.out).toMatch(/experimental-admin-http\s+BUCKLE_EXPERIMENTAL_ADMIN_HTTP\s+true\s+process environment\n/)
    const quiet = await settings(['show'], { BUCKLE_STATE_DIR: state }, absent)
    expect(quiet.out).not.toContain('This node has no buckle.env')
  })

  it('prints each allow-listed setting with its value and source, and every other key by name alone', async () => {
    const result = await settings(['show'], { BUCKLE_MOUNT_READ_ONLY: '/opt/tools', BUCKLE_ALLOWED_HOSTS: 'db.internal' })

    expect(result.exitCode).toBe(0)
    expect(result.out).toMatch(/name\s+BUCKLE_SERVER_NAME\s+Fixture node\s+environment file/)
    expect(result.out).toMatch(/experimental-admin-http\s+BUCKLE_EXPERIMENTAL_ADMIN_HTTP\s+false\s+environment file/)
    expect(result.out).toMatch(/read-only-paths\s+BUCKLE_MOUNT_READ_ONLY\s+\/opt\/tools\s+process environment\n/)
    // Phase 2 item 5: the node's URL list now, a workspace default read from the file alone.
    expect(result.out).toMatch(/allowed-hosts\s+BUCKLE_ALLOWED_HOSTS\s+\(none\)\s+default; this shell's value is not read\n/)
    // D85, Q3: a workspace default the file holds is listed among the defaults, with where it came from.
    expect(result.out).toContain('Workspace defaults, which a workspace\'s own settings replace (buckle workspace show); the command deny and destructive lists apply to every workspace:')
    expect(result.out.slice(result.out.indexOf('Workspace defaults'))).toMatch(/shell\s+BUCKLE_ALLOW_SHELL\s+true\s+environment file/)
    expect(result.out).not.toContain('ignores')
    expect(result.out).toContain('BUCKLE_AUTH_TOKEN (set, hidden)')
    expect(result.out).toContain('BUCKLE_ADMIN_TOKEN (set, hidden)')
    expect(result.out).toContain('OTHER_TOOL_TOKEN (set, hidden)')
    expect(result.printed).not.toContain(SECRET)
  })

  it('names the process environment when it overrides the file', async () => {
    const result = await settings(['show'], { BUCKLE_EXPERIMENTAL_ADMIN_HTTP: 'true' })

    expect(result.out).toMatch(/experimental-admin-http\s+BUCKLE_EXPERIMENTAL_ADMIN_HTTP\s+true\s+process environment, over the file/)
  })

  // D85, Q3: a workspace default is read from the file alone, so a shell's value is named as not read.
  it('names a workspace default this shell sets as not read, and the file\'s value as the one in force', async () => {
    const shown = await settings(['show'], { BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' })
    expect(shown.out).toMatch(/shell\s+BUCKLE_ALLOW_SHELL\s+true\s+environment file; this shell's value is not read\n/)
    expect(shown.out).toMatch(/packs\s+BUCKLE_PACKS\s+\(every built-in pack, and plugins\)\s+default; this shell's value is not read\n/)
    const set = await settings(['set', 'shell', 'off'], { BUCKLE_ALLOW_SHELL: 'true' })
    expect(set.out).toContain('BUCKLE_ALLOW_SHELL is also set in this shell\'s environment, which the node does not read for a workspace default: the file\'s value applies.')
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

  // D85, Q3: buckle.env holds the defaults every workspace takes where its own settings hold no value.
  it.each([
    ['shell', 'off', 'BUCKLE_ALLOW_SHELL', 'false'],
    ['code', 'on', 'BUCKLE_ALLOW_CODE', 'true'],
    ['history', 'off', 'BUCKLE_ALLOW_HISTORY', 'false'],
    ['host-git', 'yes', 'BUCKLE_ALLOW_HOST_GIT', 'true'],
    ['BUCKLE_ALLOW_HOST_LSP', 'on', 'BUCKLE_ALLOW_HOST_LSP', 'true'],
    ['packs', 'fs, web', 'BUCKLE_PACKS', 'fs,web'],
    ['approval-wait', '0', 'BUCKLE_APPROVAL_TIMEOUT_MS', '0'],
    ['mount', '/project', 'BUCKLE_WORKSPACE_MOUNT', '/project'],
    ['network-allow', 'example.com, docs.test', 'BUCKLE_NETWORK_ALLOW', 'example.com,docs.test'],
    ['allowed-interpreters', 'node,python3', 'BUCKLE_ALLOWED_INTERPRETERS', 'node,python3'],
    ['command-allow', 'pnpm {build,test} * ;; git status', 'BUCKLE_COMMAND_ALLOW', 'pnpm {build,test} *;;git status'],
    ['command-deny', 'curl *', 'BUCKLE_COMMAND_DENY', 'curl *'],
    ['command-destructive', 'make deploy*', 'BUCKLE_COMMAND_DESTRUCTIVE', 'make deploy*'],
    // The node's mounts and browser were hand edits; they are set and unset here now, written as the node reads them.
    ['mounts', () => `[ ${JSON.stringify({ source: workspace, target: '/tmp/home/.config', readOnly: true })} ]`, 'BUCKLE_MOUNTS', () => JSON.stringify([{ source: workspace, target: '/tmp/home/.config', readOnly: true }])],
    ['browser-cdp', 'wss://chrome.example.com/devtools/browser/abc', 'BUCKLE_BROWSER_CDP', 'wss://chrome.example.com/devtools/browser/abc'],
    ['BUCKLE_BROWSER_CDP', '9222', 'BUCKLE_BROWSER_CDP', '9222'],
    ['browser-profile', () => join(root, 'chrome-profile'), 'BUCKLE_BROWSER_PROFILE', () => join(root, 'chrome-profile')],
    ['browser-args', '--lang=en', 'BUCKLE_BROWSER_ARGS', '--lang=en'],
    ['browser-headed', 'on', 'BUCKLE_BROWSER_HEADED', 'true'],
  ])('takes %s as the node\'s default for every workspace, as the node reads it', async (key, given, variable, expected) => {
    const value = typeof given === 'function' ? given() : given
    const written = typeof expected === 'function' ? expected() : expected
    const result = await settings(['set', key, value])

    expect(result.exitCode).toBe(0)
    expect(parseEnv(readFileSync(file, 'utf8'))[variable]).toBe(written)
    expect(result.out).toMatch(/It (is the default of every workspace whose own settings leave \S+ unset|applies to every workspace, over each one's own \S+)\./)
    // A workspace that sets nothing of its own takes it, once the node starts again.
    const inForce = resolveSettings(defaultSettings(), loadConfig({ ...parseEnv(readFileSync(file, 'utf8')), BUCKLE_STATE_DIR: state }).workspaceDefaults)
    expect(Object.values(inForce.sources)).toContain('node')
  })

  it('removes a workspace default\'s line, so Buckle\'s own applies', async () => {
    const result = await settings(['unset', 'shell'])

    expect(result.exitCode).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(withLine('BUCKLE_ALLOW_SHELL=true\n', ''))
    expect(result.out).toContain('the default applies: true')
  })

  // Every workspace key a 0.1 node kept here is a node default now, listed with the others (D85, Q3).
  it('lists every workspace key a 0.1 node kept here among the workspace defaults, and removes each line', async () => {
    const keys = ['BUCKLE_COMMAND_ALLOW', 'BUCKLE_COMMAND_DENY', 'BUCKLE_COMMAND_DESTRUCTIVE', 'BUCKLE_ALLOWED_INTERPRETERS', 'BUCKLE_NETWORK_ALLOW', 'BUCKLE_WORKSPACE_MOUNT', 'BUCKLE_PACKS', 'BUCKLE_ALLOW_SHELL', 'BUCKLE_ALLOW_CODE', 'BUCKLE_ALLOW_HISTORY', 'BUCKLE_ALLOW_HOST_GIT', 'BUCKLE_ALLOW_HOST_LSP', 'BUCKLE_APPROVAL_TIMEOUT_MS', 'BUCKLE_SCRATCH_ROOTS', 'BUCKLE_SHELL_NETWORK', 'BUCKLE_SHELL_ISOLATION', 'BUCKLE_ALLOWED_HOSTS', 'BUCKLE_MOUNTS', 'BUCKLE_BROWSER_CDP', 'BUCKLE_BROWSER_PROFILE', 'BUCKLE_BROWSER_ARGS', 'BUCKLE_BROWSER_HEADED', 'BUCKLE_APPROVAL_JUDGE', 'BUCKLE_APPROVAL_JUDGE_PROVIDER', 'BUCKLE_APPROVAL_JUDGE_MODEL', 'BUCKLE_APPROVAL_JUDGE_STANDARD_SCRIPTS', 'BUCKLE_APPROVAL_QUICK_JUDGE', 'BUCKLE_APPROVAL_QUICK_JUDGE_MODEL', 'BUCKLE_APPROVAL_FORMS', 'BUCKLE_APPROVAL_SESSION_IDLE_MS', 'BUCKLE_DELETE_IN_WORKSPACE', 'BUCKLE_MASS_DELETE_LIMIT']
    expect(NODE_SETTINGS.filter(setting => setting.workspace).map(setting => setting.key).sort()).toEqual([...keys].sort())
    // The node reads these from its file alone (WORKSPACE_DEFAULT_KEYS), and buckle settings writes every one of them.
    expect([...WORKSPACE_DEFAULT_KEYS].sort()).toEqual([...keys].sort())
    const shown = await settings(['show'])
    const defaults = shown.out.slice(shown.out.indexOf('Workspace defaults'))
    for (const key of keys) expect(defaults).toContain(key)
    for (const key of keys) expect((await settings(['unset', key])).exitCode).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(withLine('BUCKLE_ALLOW_SHELL=true\n', ''))
  })

  // The 0.1 folder line is read once, when the node moves; the move's notice asks for it to be unset (fix brief 1, B).
  it('refuses to set root, names it as read at the move on a node not moved yet, and removes its line', async () => {
    writeFileSync(file, `${original}BUCKLE_WORKSPACE_ROOT=${workspace}\n`)
    const set = await settings(['set', 'root', workspace])
    expect(set.exitCode).toBe(1)
    expect(set.err).toContain('BUCKLE_WORKSPACE_ROOT is read only when a node set up before workspaces moves onto them. Serve a folder with buckle workspace init --dir <folder>.')
    // Recheck finding H3: before the move nothing says the node ignores it, as it is the move's input.
    expect((await settings(['show'])).out).toContain('BUCKLE_WORKSPACE_ROOT is read once, when this node moves onto workspaces at its next start')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'workspaces.json'), '{"version":2,"workspaces":[]}')
    expect((await settings(['show'])).out).toContain('the node no longer reads it (buckle settings unset root)')
    expect((await settings(['unset', 'root'])).exitCode).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(original)
  })

  it('leaves no temporary file behind', async () => {
    await settings(['set', 'name', 'Renamed'])

    expect(readdirSync(root).sort()).toEqual(['node.env', 'state', 'workspace'])
    expect(readFileSync(file, 'utf8')).toBe(withLine('BUCKLE_SERVER_NAME=Fixture node', 'BUCKLE_SERVER_NAME=Renamed'))
  })

  it('records an audit entry naming the key and the value', async () => {
    await settings(['set', 'allowed-hosts', 'db.internal,*.internal.test'])

    const entries = await auditEntries(createFileActionLog(join(state, 'actions.jsonl')), 10)
    expect(entries.at(-1)).toMatchObject({ tool: 'cli_settings', outcome: 'ok', detail: 'BUCKLE_ALLOWED_HOSTS=db.internal,*.internal.test' })
    expect(JSON.stringify(entries)).not.toContain(SECRET)
  })

  // A DevTools URL can carry a token and Chromium arguments a proxy password: the audit log and the confirmation name the key alone.
  it('audits the node\'s browser endpoint, profile, and arguments by key, never by value', async () => {
    const cdp = 'wss://chrome.example.com/devtools/browser/abc?token=settings-devtools-token'
    const args = '--proxy-server=http://user:settings-proxy-pass@proxy.example:8080'
    const profile = join(root, 'settings-profile-folder')
    const sets = [await settings(['set', 'browser-cdp', cdp]), await settings(['unset', 'browser-cdp']), await settings(['set', 'browser-args', args]), await settings(['set', 'browser-profile', profile]), await settings(['set', 'browser-headed', 'on'])]
    expect(sets.map(result => result.exitCode)).toEqual([0, 0, 0, 0, 0])
    for (const secret of ['settings-devtools-token', 'settings-proxy-pass', 'settings-profile-folder']) {
      expect(JSON.stringify(await auditEntries(createFileActionLog(join(state, 'actions.jsonl')), 50))).not.toContain(secret)
      expect(sets.map(result => result.printed).join('')).not.toContain(secret)
    }
    const entries = (await auditEntries(createFileActionLog(join(state, 'actions.jsonl')), 50)).filter(entry => entry.tool === 'cli_settings' && entry.event === 'result')
    expect(entries.map(entry => entry.detail)).toEqual(['BUCKLE_BROWSER_CDP set', 'BUCKLE_BROWSER_CDP unset', 'BUCKLE_BROWSER_ARGS set', 'BUCKLE_BROWSER_PROFILE set', 'BUCKLE_BROWSER_HEADED=true'])
    expect(sets[0]!.out).toContain('Set BUCKLE_BROWSER_CDP in')
  })

  // The node reads buckle.env's browser keys as one block at start (parseBrowserSettings), so a value that cannot stand beside the file's others is refused.
  it.each([
    [['set', 'mounts', 'not json'], 'BUCKLE_MOUNTS must be a JSON array'],
    [['set', 'mounts', '[]'], 'BUCKLE_MOUNTS needs at least one mount'],
    [['set', 'mounts', JSON.stringify([{ source: 'relative', target: '/x' }])], 'BUCKLE_MOUNTS must be a JSON array'],
    [['set', 'browser-cdp', 'chrome'], 'Invalid BUCKLE_BROWSER_CDP'],
    [['set', 'browser-profile', 'profiles/mine'], 'BUCKLE_BROWSER_PROFILE must be an absolute path'],
    [['set', 'browser-args', '--user-data-dir=/somewhere'], 'BUCKLE_BROWSER_ARGS may not pass --user-data-dir'],
    [['set', 'browser-headed', 'maybe'], 'BUCKLE_BROWSER_HEADED is on or off'],
  ])('refuses %j, saying why, and writes nothing', async (argv, reason) => {
    const result = await settings(argv)
    expect(result.exitCode).toBe(1)
    expect(result.err).toContain(reason)
    expect(readFileSync(file, 'utf8')).toBe(original)
  })

  it('refuses an attached Chrome beside a profile, arguments, or a window in the file, and the reverse, naming the variables and no value', async () => {
    writeFileSync(file, `${original}BUCKLE_BROWSER_CDP=9222\n`)
    for (const [key, value, name] of [['browser-profile', join(root, 'p'), 'BUCKLE_BROWSER_PROFILE'], ['browser-args', '--lang=en', 'BUCKLE_BROWSER_ARGS'], ['browser-headed', 'on', 'BUCKLE_BROWSER_HEADED']] as const) {
      const result = await settings(['set', key, value])
      expect(result.exitCode).toBe(1)
      expect(result.err).toContain(`BUCKLE_BROWSER_CDP cannot be set with ${name}`)
      expect(result.err).not.toContain('9222')
    }
    writeFileSync(file, `${original}BUCKLE_BROWSER_HEADED=true\n`)
    const reverse = await settings(['set', 'browser-cdp', '9333'])
    expect(reverse.exitCode).toBe(1)
    expect(reverse.err).toContain('BUCKLE_BROWSER_CDP cannot be set with BUCKLE_BROWSER_HEADED')
    expect(readFileSync(file, 'utf8')).toBe(`${original}BUCKLE_BROWSER_HEADED=true\n`)
    // Turning the window off is no conflict, and a block of profile and arguments is one the node loads.
    expect((await settings(['set', 'browser-headed', 'off'])).exitCode).toBe(0)
    expect((await settings(['set', 'browser-cdp', '9333'])).exitCode).toBe(0)
  })

  it('shows the node\'s browser and mounts among the workspace defaults, and removes each line', async () => {
    const mounts = JSON.stringify([{ source: workspace, target: '/tmp/home/.config', readOnly: true }])
    writeFileSync(file, `${original}BUCKLE_MOUNTS=${mounts}\nBUCKLE_BROWSER_PROFILE=${join(root, 'shown-profile')}\n`)
    const shown = (await settings(['show'])).out
    const defaults = shown.slice(shown.indexOf('Workspace defaults'))
    expect(defaults).toMatch(/mounts\s+BUCKLE_MOUNTS\s+\[\{"source"/)
    expect(defaults).toMatch(/browser-profile\s+BUCKLE_BROWSER_PROFILE\s+\S+shown-profile\s+environment file/)
    expect(defaults).toMatch(/browser-headed\s+BUCKLE_BROWSER_HEADED\s+false\s+default/)
    expect(shown.slice(shown.indexOf('Also in the file, not shown here'))).not.toMatch(/BUCKLE_MOUNTS|BUCKLE_BROWSER/)
    expect((await settings(['unset', 'mounts'])).exitCode).toBe(0)
    expect((await settings(['unset', 'BUCKLE_BROWSER_PROFILE'])).exitCode).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(original)
  })

  it('switches the experimental admin HTTP layer, off by default, and audits the change (owner decision D8)', async () => {
    expect((await settings(['show'])).out).toMatch(/experimental-admin-http +BUCKLE_EXPERIMENTAL_ADMIN_HTTP +false +environment file/)
    expect((await settings(['set', 'experimental-admin-http', 'on'])).exitCode).toBe(0)
    expect(parseEnv(readFileSync(file, 'utf8')).BUCKLE_EXPERIMENTAL_ADMIN_HTTP).toBe('true')
    expect((await settings(['show'])).out).toMatch(/experimental-admin-http +BUCKLE_EXPERIMENTAL_ADMIN_HTTP +true +environment file/)
    expect((await settings(['unset', 'experimental-admin-http'])).exitCode).toBe(0)
    const entries = (await auditEntries(createFileActionLog(join(state, 'actions.jsonl')), 10)).filter(entry => entry.tool === 'cli_settings' && entry.event === 'result')
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
    [['set', 'command-deny', 'curl (('], 'Invalid command pattern'],
    [['set', 'command-allow', ' ;; '], 'needs at least one glob'],
    [['set', 'packs', 'fs,rocket'], 'Unknown pack rocket'],
    [['set', 'packs', 'fs,environment'], 'environment (BUCKLE_ENV_VALIDATOR_COMMAND is not set)'],
    [['set', 'mount', '/usr/project'], 'Cannot mount the workspace under /usr'],
    [['set', 'network-allow', '*.127.0.0.1'], 'Invalid BUCKLE_NETWORK_ALLOW entry'],
    [['set', 'allowed-interpreters', 'bash'], 'Invalid BUCKLE_ALLOWED_INTERPRETERS entry bash'],
    [['set', 'approval-wait', 'forever'], 'Approval wait must be milliseconds'],
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
    expect((await auditEntries(createFileActionLog(join(state, 'actions.jsonl')), 10)).at(-1)).toMatchObject({ tool: 'cli_settings', outcome: 'error' })
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
      cwd: root, paths, runProcess, sandbox, writableRoots: [root], hiddenPaths: [], settingsFiles: [], mountReadOnlyPaths: [], approvedUrls: null, approvedLists: [],
      forge: { apiUrl: 'https://api.github.com', author: { name: 'a', email: 'a@b.c' } }, stateDirectory: state, 
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
