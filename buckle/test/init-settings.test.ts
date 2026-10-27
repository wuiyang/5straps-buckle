import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { parseEnv } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { runInit, serveCommand, type InitPrompt } from '../cli/init.js'
import type { ProgramSearch } from '../common/domain/executable.js'
import { createRuntimeOwner } from '@5straps/runtime'
import { loadConfig } from '../common/runtime/config.js'
import { logger } from '../common/runtime/log.js'
import { holdServe, serviceDirectory, type ServeManagerKind } from '../common/services/node-service/serve-record.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { workspaceIdOf } from './support/workspaces.js'
import { defaultEnvironmentFile } from '../common/runtime/environment.js'
import { openSettingsFile, settingsPath, type WorkspaceSettings } from '../common/services/workspaces/workspace-settings.js'

let workspace: string
let out: string
let state: string

beforeEach(() => {
  // A real path: the paths a program resolves to are real, and on macOS the temp folder is reached through a link.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-init-settings-')))
  workspace = join(root, 'workspace')
  out = join(root, 'node.env')
  // The node's state, and so its registry, beside the workspace rather than in the machine's own.
  state = join(root, 'state')
  mkdirSync(workspace)
  vi.stubEnv('BUCKLE_STATE_DIR', state)
})
afterEach(() => { vi.unstubAllEnvs() })

/** The registry entry and workspace.json of the workspace serving `dir` (D83 (2)): init writes its choices there. */
function served(dir = workspace): { id: string; name: string; dir: string; settings: WorkspaceSettings } {
  const registry = JSON.parse(readFileSync(join(state, 'workspaces.json'), 'utf8')) as { workspaces: { id: string; name: string; dir: string }[] }
  const entry = registry.workspaces.find(item => item.dir === dir)
  if (!entry) throw new Error(`No workspace serves ${dir}`)
  return { ...entry, settings: openSettingsFile({ filePath: settingsPath(state, entry.id) }).read() }
}

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

async function init(prompt: InitPrompt, extra: string[] = [], platform?: NodeJS.Platform) {
  let printed = ''
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { printed += String(chunk); return true })
  try {
    const result = await runInit(['--out', out, '--port', '4399', ...extra], prompt, platform ? { platform } : {})
    return { ...result, printed, written: readFileSync(out, 'utf8') }
  } finally { stdout.mockRestore() }
}

describe('buckle init asks for the workspace\'s settings after its folder', () => {
  it('writes the choices it asks about as a list with the Oxford comma in its usage', async () => {
    const printed = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect((await runInit(['--help'], scripted([], false), {})).exitCode).toBe(0)
    expect(printed.mock.calls.map(call => String(call[0])).join('')).toContain('the shell, host Git, and the approved hosts;')
    printed.mockRestore()
  })

  it('shows each default, and Enter keeps the shipped ones', async () => {
    const prompt = scripted([workspace, '', '', 'Fixture'])
    const result = await init(prompt)

    expect(prompt.asked[2]).toBe('Mount another folder? local:sandbox[:ro], blank for none: ')
    expect(prompt.asked.slice(4)).toEqual([
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
    // Q3: the node's file holds the node's settings alone, and no agent token: the workspace's is in the registry, hashed.
    for (const key of ['BUCKLE_AUTH_TOKEN', 'BUCKLE_WORKSPACE_ROOT', 'BUCKLE_WORKSPACE_MOUNT', 'BUCKLE_ALLOW_SHELL', 'BUCKLE_PACKS', 'BUCKLE_ALLOW_HOST_GIT', 'BUCKLE_NETWORK_ALLOW', 'BUCKLE_ALLOWED_HOSTS']) expect(env[key]).toBeUndefined()
    expect(result.written).toContain('# BUCKLE_ALLOWED_HOSTS=db.internal')
    // D85, Q3: Enter leaves the setting unset, so the node's value applies, else Buckle's.
    const { settings } = served()
    expect(settings.packs).toEqual({})
    expect(settings.policy.network).toEqual({ allow: [] })
    expect(settings.mounts).toEqual([{ kind: 'workspace', target: '/workspace', access: 'rw' }])
    expect(result.printed).toMatch(/Packs\s+all, and plugins/)
    expect(result.printed).toMatch(/Shell\s+on/)
  })

  it('writes the answers that move off a default', async () => {
    const result = await init(scripted([workspace, '', '', 'Fixture', 'fs, shell', 'n', 'y', 'localhost:3000,*.example.com', 'db.internal']))

    expect(parseEnv(result.written)).toMatchObject({ BUCKLE_ALLOWED_HOSTS: 'db.internal' })
    const { settings } = served()
    expect(settings.packs).toMatchObject({ enabled: ['fs', 'shell'], shell: false, hostGit: true })
    expect(settings.policy.network).toEqual({ allow: ['localhost:3000', '*.example.com'] })
    expect(result.printed).toMatch(/Packs\s+fs, shell/)
    expect(result.printed).toMatch(/Host Git\s+on/)
  })

  it('asks again after an answer the settings check refuses, saying why', async () => {
    const prompt = scripted([workspace, '', '', 'Fixture', 'fs,rocket', 'fs', 'maybe', '', '', '*', '', '*.0.0.1', ''])
    const result = await init(prompt)

    expect(prompt.said).toContainEqual(expect.stringContaining('Unknown pack rocket'))
    expect(prompt.said).toContainEqual('Answer y or n, or press Enter for the default.')
    expect(prompt.said).toContainEqual(expect.stringContaining('Invalid approved list entry *'))
    expect(prompt.said).toContainEqual(expect.stringContaining('Invalid BUCKLE_ALLOWED_HOSTS entry'))
    expect(result.exitCode).toBe(0)
    const { settings } = served()
    expect(settings.packs).toEqual({ enabled: ['fs'] })
    expect(settings.policy.network).toEqual({ allow: [] })
  })

  it('asks again for the environment pack while BUCKLE_ENV_VALIDATOR_COMMAND is unset, naming it, and takes it once set', async () => {
    vi.stubEnv('BUCKLE_ENV_VALIDATOR_COMMAND', '')
    const refused = scripted([workspace, '', '', 'Fixture', 'fs,environment', 'fs'])
    await init(refused)
    expect(served().settings.packs.enabled).toEqual(['fs'])
    expect(refused.said).toContainEqual(expect.stringContaining('environment (BUCKLE_ENV_VALIDATOR_COMMAND is not set)'))

    vi.stubEnv('BUCKLE_ENV_VALIDATOR_COMMAND', 'varlock load')
    const other = join(workspace, '..', 'other')
    mkdirSync(other)
    // The node is set up already, so its name is not asked again.
    const accepted = scripted([other, '', '', 'fs,environment'])
    await init(accepted)
    expect(served(other).settings.packs.enabled).toEqual(['fs', 'environment'])
  })
})

// D83 (2): the node is set up once; each later init in another folder adds a workspace to it, and init in a folder a
// workspace serves already adds nothing and mints nothing.
describe('buckle init on a node set up already', () => {
  it('keeps the node\'s file, adds the new folder as a workspace with a token of its own, shown once', async () => {
    const first = await init(scripted([], false), ['--dir', workspace])
    const other = join(workspace, '..', 'other')
    mkdirSync(other)
    const second = await init(scripted([], false), ['--dir', other])

    expect(second.written).toBe(first.written)
    expect(second.printed).toContain(`The node is already set up in ${out}; its settings are unchanged.`)
    expect(second.printed).not.toContain('admin credential   ')
    const tokens = [first.printed, second.printed].map(printed => /agent token {8}(\S+)/.exec(printed)?.[1])
    expect(tokens[0]).toBeTruthy()
    expect(tokens[1]).toBeTruthy()
    expect(tokens[0]).not.toBe(tokens[1])
    expect(readFileSync(join(state, 'workspaces.json'), 'utf8')).not.toContain(tokens[1]!)
    expect(served(other).id).not.toBe(served().id)
  })

  // D85, Q3: an unanswered setting stays unset in the new workspace, so the node's value in buckle.env applies.
  it('leaves an unanswered setting to the node, and prints the node\'s value for it', async () => {
    await init(scripted([], false), ['--dir', workspace])
    writeFileSync(out, `${readFileSync(out, 'utf8')}BUCKLE_ALLOW_SHELL=false\n`)
    const other = join(workspace, '..', 'other')
    mkdirSync(other)
    const second = await init(scripted([], false), ['--dir', other])

    expect(second.printed).toMatch(/Shell\s+off/)
    expect(served(other).settings.packs).toEqual({})
  })

  it('adds nothing for a folder a workspace serves, and says how to mint a token for it', async () => {
    await init(scripted([], false), ['--dir', workspace])
    const before = readFileSync(join(state, 'workspaces.json'), 'utf8')
    const again = await init(scripted([], false), ['--dir', join(workspace, 'sub', '..')])

    expect(again.exitCode).toBe(0)
    expect(again.printed).toContain(`is already in workspace ${served().name}: nothing was added. Mint a token for it with buckle workspace token create --workspace ${served().name}.`)
    expect(again.printed).not.toMatch(/agent token {8}/)
    expect(readFileSync(join(state, 'workspaces.json'), 'utf8')).toBe(before)
  })

  it('keeps an empty standard-scripts list under --force, which names none where unset would bring back the built-in list', async () => {
    await init(scripted([], false), ['--dir', workspace])
    writeFileSync(out, `${readFileSync(out, 'utf8')}BUCKLE_APPROVAL_JUDGE_STANDARD_SCRIPTS=\n`, { mode: 0o600 })
    const again = await init(scripted([], false), ['--dir', workspace, '--force'])

    expect(again.exitCode).toBe(0)
    expect(parseEnv(again.written).BUCKLE_APPROVAL_JUDGE_STANDARD_SCRIPTS).toBe('')
    expect(loadConfig(parseEnv(again.written)).workspaceDefaults.approval.judgeStandardScripts).toEqual([])
  })

  it('writes the node\'s file again under --force, with a new admin credential, keeping the workspaces', async () => {
    const first = await init(scripted([], false), ['--dir', workspace])
    const again = await init(scripted([], false), ['--dir', workspace, '--force'])

    expect(parseEnv(again.written).BUCKLE_ADMIN_TOKEN).not.toBe(parseEnv(first.written).BUCKLE_ADMIN_TOKEN)
    expect(again.printed).toContain(`Wrote ${out}`)
    expect(existsSync(settingsPath(state, served().id))).toBe(true)
  })
})

describe('the command init prints to start the node', () => {
  it('sets the variable before the command on Linux and macOS', () => {
    expect(serveCommand('/srv/node/buckle.env', {}, 'linux')).toEqual([{ shell: null, lines: ['BUCKLE_ENV_FILE=/srv/node/buckle.env buckle serve'] }])
    expect(serveCommand('/srv/state/buckle.env', { BUCKLE_STATE_DIR: '/srv/state' }, 'darwin')).toEqual([{ shell: null, lines: ['BUCKLE_STATE_DIR=/srv/state buckle serve'] }])
  })

  it('sets it as PowerShell and cmd do on Windows, each its own form, with cmd\'s quoted whole so no space ends the value', () => {
    expect(serveCommand("/srv/O'Neil/node.env", {}, 'win32')).toEqual([
      { shell: 'PowerShell', lines: ["$env:BUCKLE_ENV_FILE = '/srv/O''Neil/node.env'; buckle serve"] },
      { shell: 'cmd', lines: [`set "BUCKLE_ENV_FILE=/srv/O'Neil/node.env" && buckle serve`] },
    ])
    expect(serveCommand('/srv/state/buckle.env', { BUCKLE_STATE_DIR: '/srv/state' }, 'win32')).toEqual([
      { shell: 'PowerShell', lines: ["$env:BUCKLE_STATE_DIR = '/srv/state'; buckle serve"] },
      { shell: 'cmd', lines: ['set "BUCKLE_STATE_DIR=/srv/state" && buckle serve'] },
    ])
  })

  // D85 Q4, owner ruling of 2026-10-17: the launchd agent on macOS; nothing on a platform Buckle drives no service manager on.
  it('offers the service on macOS too', async () => {
    const { printed } = await init(scripted([workspace, '', '', 'Fixture']), [], 'darwin')
    expect(printed).toContain(`  1. Start the node:            BUCKLE_ENV_FILE=${out} buckle serve\n     Or at every login:         BUCKLE_ENV_FILE=${out} buckle service install --now\n`)
  })

  it('offers no service where Buckle drives no service manager', async () => {
    const { printed } = await init(scripted([workspace, '', '', 'Fixture']), [], 'freebsd')
    expect(printed).not.toContain('buckle service install')
  })

  it('names no variable for the file in the default state directory, on any platform', () => {
    for (const platform of ['linux', 'win32'] as const) expect(serveCommand(defaultEnvironmentFile({}), {}, platform)).toEqual([{ shell: null, lines: ['buckle serve'] }])
  })

  it('prints each Windows form on its own labelled line, the restrict example quoted as each shell reads it', async () => {
    const { printed } = await init(scripted([workspace, '', '', 'Fixture']), [], 'win32')
    expect(printed).toContain([
      '  1. Start the node:',
      `       PowerShell   $env:BUCKLE_ENV_FILE = '${out}'; buckle serve`,
      `       cmd          set "BUCKLE_ENV_FILE=${out}" && buckle serve`,
    ].join('\n'))
    expect(printed).toContain([
      '     Or at every login:',
      `       PowerShell   $env:BUCKLE_ENV_FILE = '${out}'; buckle service install --now`,
      `       cmd          set "BUCKLE_ENV_FILE=${out}" && buckle service install --now`,
    ].join('\n'))
    expect(printed).toContain([
      '  3. Restrict it:',
      "       PowerShell   buckle policy allow-command 'pnpm {build,test} *'",
      '                    buckle policy allow-url localhost:3000',
      '       cmd          buckle policy allow-command "pnpm {build,test} *"',
      '                    buckle policy allow-url localhost:3000',
    ].join('\n'))
  })

  it('keeps one form on the step\'s own line on Linux', async () => {
    const { printed } = await init(scripted([workspace, '', '', 'Fixture']), [], 'linux')
    expect(printed).toContain(`  1. Start the node:            BUCKLE_ENV_FILE=${out} buckle serve\n`)
    // Phase 3, item 7: init offers the service on Linux and Windows.
    expect(printed).toContain(`     Or at every login:         BUCKLE_ENV_FILE=${out} buckle service install --now\n`)
    expect(printed).toContain("  3. Restrict it:               buckle policy allow-command 'pnpm {build,test} *'\n                                buckle policy allow-url localhost:3000\n")
  })
})

// Finding 33 of the fourth recheck: Next always said `buckle serve`, which the guard beside a running node refuses, and
// offered `service install --now` beside a node it would refuse or an installed service it would write again.
describe('the Next step beside a node that runs or a service that is installed', () => {
  const second = () => { const folder = join(workspace, '..', 'second'); mkdirSync(folder); return folder }

  /** A node serving the state directory in this process, as service-command.test.ts imitates one. */
  async function serving(manager: ServeManagerKind, pid: number): Promise<{ close(): Promise<void> }> {
    const owner = createRuntimeOwner({ name: 'fake-node', services: [] })
    await holdServe({ stateDirectory: state, owner })
    writeFileSync(join(serviceDirectory(state), 'serve.json'), JSON.stringify({ pid, manager, version: '0.1.4', host: '127.0.0.1', port: 4399, startedAt: '2026-10-16T00:00:00.000Z' }))
    return { close: () => owner.close() }
  }

  it('says a node running in service mode serves the new workspace now, names the command that answers it, and offers neither serve nor install', async () => {
    await init(scripted([], false), ['--dir', workspace])
    const running = await serving('background', 424_242)
    try {
      const { printed, exitCode } = await init(scripted([], false), ['--dir', second()], 'linux')
      expect(exitCode).toBe(0)
      expect(printed).toContain('  1. The node runs in service mode (pid 424242) and serves this workspace now; no restart is needed.\n     Answer its approvals here with: buckle approvals --watch --all\n')
      expect(printed).not.toContain('Start the node')
      expect(printed).not.toContain('buckle serve')
      expect(printed).not.toContain('service install')
      expect(printed).toContain('  3. Restrict it:')
    } finally { await running.close() }
  })

  it('says a serve at a terminal serves it now and is answered there', async () => {
    await init(scripted([], false), ['--dir', workspace])
    const running = await serving('terminal', 424_243)
    try {
      const { printed } = await init(scripted([], false), ['--dir', second()], 'linux')
      expect(printed).toContain('  1. The node runs at a terminal (pid 424243) and serves this workspace now; no restart is needed.\n     Its approvals are answered there.\n')
      expect(printed).not.toContain('Answer its approvals here')
      expect(printed).not.toContain('service install')
    } finally { await running.close() }
  })

  it('offers buckle service start, and not the install line, where a unit for this node is installed and nothing runs', async () => {
    await init(scripted([], false), ['--dir', workspace])
    const config = join(workspace, '..', 'config')
    vi.stubEnv('XDG_CONFIG_HOME', config)
    mkdirSync(join(config, 'systemd', 'user'), { recursive: true })
    writeFileSync(join(config, 'systemd', 'user', 'buckle.service'), `[Service]\nExecStart="/usr/bin/node" "/opt/buckle/dist/main.js" serve --service systemd --state-dir "${state}"\n`)
    const { printed } = await init(scripted([], false), ['--dir', second()], 'linux')
    expect(printed).toContain(`  1. Start the node:            BUCKLE_ENV_FILE=${out} buckle service start\n`)
    expect(printed).not.toContain('buckle serve')
    expect(printed).not.toContain('service install')
  })

  it('offers it on Windows, where the task keeps its copy in the state directory, in each shell\'s form', async () => {
    await init(scripted([], false), ['--dir', workspace], 'win32')
    mkdirSync(serviceDirectory(state), { recursive: true })
    writeFileSync(join(serviceDirectory(state), 'task.xml'), '<Task/>')
    const { printed } = await init(scripted([], false), ['--dir', second()], 'win32')
    expect(printed).toContain([
      '  1. Start the node:',
      `       PowerShell   $env:BUCKLE_ENV_FILE = '${out}'; buckle service start`,
      `       cmd          set "BUCKLE_ENV_FILE=${out}" && buckle service start`,
    ].join('\n'))
    expect(printed).not.toContain('service install')
  })

  it('keeps today\'s two lines where nothing runs and no unit is installed', async () => {
    await init(scripted([], false), ['--dir', workspace])
    const { printed } = await init(scripted([], false), ['--dir', second()], 'linux')
    expect(printed).toContain(`  1. Start the node:            BUCKLE_ENV_FILE=${out} buckle serve\n     Or at every login:         BUCKLE_ENV_FILE=${out} buckle service install --now\n`)
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
    expect(served().settings.packs).toEqual({})
    expect(parseEnv(result.written).BUCKLE_ALLOW_SHELL).toBeUndefined()
  })
})

// The workspace-model follow-up, M3 (Q6, after Docker's -v): buckle init offers the workspace's mounts beside its
// folder, checked as buckle workspace mount add checks one; a default install adds none (D83).
describe('buckle init and the workspace\'s mounts', () => {
  const MOUNT_QUESTION = 'Mount another folder? local:sandbox[:ro], blank for none: '
  let data: string
  let docs: string
  let errors: string
  beforeEach(() => {
    data = join(workspace, '..', 'data')
    docs = join(workspace, '..', 'docs')
    for (const folder of [data, docs]) mkdirSync(folder)
    errors = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { errors += String(chunk); return true })
  })
  afterEach(() => { vi.restoreAllMocks() })
  const folderOnly = () => [{ kind: 'workspace', target: '/workspace', access: 'rw' }]

  it('adds each --volume as a mount, read-write unless :ro, a relative source the current directory\'s, and ends the summary with the table', async () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(join(workspace, '..'))
    let result: Awaited<ReturnType<typeof init>>
    try { result = await init(scripted([], false), ['--dir', workspace, '--yes', '--volume', `${data}:/data`, '--volume', './docs:/docs:ro']) } finally { cwd.mockRestore() }
    expect(result.exitCode).toBe(0)
    expect(served().settings.mounts).toEqual([...folderOnly(), { source: data, target: '/data', access: 'rw' }, { source: docs, target: '/docs', access: 'ro' }])
    expect(result.printed).toContain(`  Network     no approved list\n  Mounts      ${workspace}:/workspace:rw\n              ${data}:/data:rw\n              ${docs}:/docs:ro\n`)
    expect(result.printed).toContain('These are the defaults, kept because nothing was asked, beside the mounts --volume named.')
  })

  it.each([
    ['--yes', true, ['--yes']],
    ['no terminal', false, []],
  ])('adds no mount under %s without --volume, as a default install grants nothing more, and prints the folder\'s row alone', async (_label, interactive, flags) => {
    const prompt = scripted([`${data}:/data`], interactive)
    const result = await init(prompt, ['--dir', workspace, ...flags])
    expect(result.exitCode).toBe(0)
    expect(prompt.asked).toEqual([])
    expect(served().settings.mounts).toEqual(folderOnly())
    expect(result.printed).toContain(`  Mounts      ${workspace}:/workspace:rw\nThese are the defaults, kept because nothing was asked. Change one`)
  })

  it('asks after where the agent sees the folder, again until a blank answer, and again after one that names no mount', async () => {
    const prompt = scripted([workspace, '', `${data}:/data`, 'nonsense', `${docs}:/docs:ro`, '', 'Fixture'])
    const result = await init(prompt)
    expect(result.exitCode).toBe(0)
    expect(prompt.asked.slice(1, 6)).toEqual([expect.stringContaining('Where the agent sees it'), MOUNT_QUESTION, MOUNT_QUESTION, MOUNT_QUESTION, MOUNT_QUESTION])
    expect(prompt.asked[6]).toContain('Name for this node')
    expect(prompt.said).toContain('nonsense names no mount: write it as <local>:<sandbox>, such as ./data:/data, with :ro to share it read-only')
    expect(served().settings.mounts).toEqual([...folderOnly(), { source: data, target: '/data', access: 'rw' }, { source: docs, target: '/docs', access: 'ro' }])
    expect(result.printed).toContain(`  Mounts      ${workspace}:/workspace:rw\n              ${data}:/data:rw\n              ${docs}:/docs:ro\n`)
  })

  it.each([
    ['a target that is no plain absolute path', () => ['--volume', `${data}:/a/../b`], 'is not an absolute sandbox path with plain names'],
    ['a target with no sandbox path', () => ['--volume', `${data}:data`], '/data:data names no mount: write it as <local>:<sandbox>'],
    ['the folder\'s target', () => ['--volume', `${data}:/workspace`], 'overlaps /workspace, where the workspace\'s folder shows'],
    ['a system folder', () => ['--volume', `${data}:/usr/data`], 'for the host\'s own programs'],
    ['a source that does not exist', () => ['--volume', `${join(data, 'missing')}:/data`], 'A mount\'s source must be an existing folder or file'],
    ['the workspace\'s own folder as a source', () => ['--volume', `${workspace}:/again`], 'the workspace\'s own folder'],
    ['a target taken twice', () => ['--volume', `${data}:/data`, '--volume', `${docs}:/data`], 'A mount already shows at /data'],
    ['a mount beside a folder at its real path', () => ['--mount', '', '--volume', `${data}:/data`], 'A mount needs the workspace\'s folder mounted'],
  ])('refuses %s before anything is written, naming the entry and the rule', async (_name, flags, reason) => {
    const given = flags()
    const result = await runInit(['--out', out, '--port', '4399', '--dir', workspace, '--yes', ...given], scripted([], false), {})
    expect(result.exitCode).toBe(1)
    expect(errors).toContain(reason)
    expect(errors).toContain(given.at(-1)!)
    expect(errors).toContain('Nothing was written.')
    expect(existsSync(out)).toBe(false)
    expect(existsSync(state)).toBe(false)
  })

  it('checks the mounts typed at a terminal too, writing nothing when one is refused', async () => {
    const result = await runInit(['--out', out, '--port', '4399'], scripted([workspace, '', `${data}:/proc/data`, '', 'Fixture']), {})
    expect(result.exitCode).toBe(1)
    expect(errors).toContain(`The mount ${data}:/proc/data is refused:`)
    expect(existsSync(out)).toBe(false)
  })

  // The mounts follow-up, first fix round: the folder is looked up in the registry before the mounts are checked, so a mount is never checked
  // against a folder that is not the workspace's own, and a request that adds nothing is refused instead of dropped.
  describe('on a folder a workspace serves already', () => {
    const refusal = (name: string) => `The folder is already served by workspace ${name}; add mounts with buckle workspace mount add <local>:<sandbox>[:ro] --workspace ${name}. Nothing was written.`
    const filesOf = () => ({ registry: readFileSync(join(state, 'workspaces.json'), 'utf8'), settings: readFileSync(settingsPath(state, served().id), 'utf8'), env: readFileSync(out, 'utf8') })

    it.each([
      ['its own folder', [] as string[], () => workspace],
      ['a folder inside it', [] as string[], () => join(workspace, 'sub')],
      ['its own folder, with --yes', ['--yes'], () => workspace],
      ['its own folder, with --force', ['--force'], () => workspace],
    ])('refuses --volume for %s, writing nothing', async (_name, flags, folder) => {
      await init(scripted([], false), ['--dir', workspace])
      mkdirSync(join(workspace, 'sub'))
      const before = filesOf()
      const again = await init(scripted([], false), ['--dir', folder(), ...flags, '--volume', `${data}:/data`])
      expect(again.exitCode).toBe(1)
      expect(again.printed).toBe('')
      expect(errors).toContain(refusal(served().name))
      expect(filesOf()).toEqual(before)
    })

    it('names the workspace\'s own rule, not the one for a folder it does not show at --mount', async () => {
      await init(scripted([], false), ['--dir', workspace, '--mount', '/code'])
      const before = filesOf()
      const again = await init(scripted([], false), ['--dir', workspace, '--yes', '--volume', `${data}:/workspace/x`])
      expect(again.exitCode).toBe(1)
      expect(errors).toContain(refusal(served().name))
      expect(errors).not.toContain('overlaps /workspace')
      expect(filesOf()).toEqual(before)
    })

    it('refuses a folder served at its real path as well, where mount add would refuse the mount', async () => {
      await init(scripted([], false), ['--dir', workspace, '--mount', ''])
      const before = filesOf()
      const again = await init(scripted([], false), ['--dir', workspace, '--yes', '--volume', `${data}:/data`])
      expect(again.exitCode).toBe(1)
      expect(errors).toContain(refusal(served().name))
      expect(filesOf()).toEqual(before)
    })

    it('still mints nothing and exits 0 without --volume, saying how to mint a token', async () => {
      await init(scripted([], false), ['--dir', workspace])
      const before = filesOf()
      const again = await init(scripted([], false), ['--dir', workspace, '--yes'])
      expect(again.exitCode).toBe(0)
      expect(again.printed).toContain(`is already in workspace ${served().name}: nothing was added. Mint a token for it with buckle workspace token create --workspace ${served().name}.`)
      expect(again.printed).not.toContain('The mounts named were not added')
      expect(filesOf()).toEqual(before)
    })

    it('does not ask the mount question at a terminal', async () => {
      await init(scripted([], false), ['--dir', workspace])
      const before = filesOf()
      const prompt = scripted([workspace, ''])
      const again = await init(prompt)
      expect(again.exitCode).toBe(0)
      expect(prompt.asked).not.toContain(MOUNT_QUESTION)
      expect(prompt.asked[0]).toContain('Folder to serve')
      expect(prompt.asked[1]).toContain('Where the agent sees it')
      expect(prompt.asked[2]).toContain('Packs to offer')
      expect(again.printed).toContain('is already in workspace')
      expect(filesOf()).toEqual(before)
    })

    it('refuses --volume at a terminal after the folder is named, without asking the mount question', async () => {
      await init(scripted([], false), ['--dir', workspace])
      const before = filesOf()
      const prompt = scripted([workspace, ''])
      const again = await init(prompt, ['--volume', `${data}:/data`])
      expect(again.exitCode).toBe(1)
      expect(prompt.asked).not.toContain(MOUNT_QUESTION)
      expect(errors).toContain(refusal(served().name))
      expect(filesOf()).toEqual(before)
    })

    it('adds --volume to another folder of a node set up already, as for a first folder', async () => {
      await init(scripted([], false), ['--dir', workspace])
      const other = join(workspace, '..', 'other')
      mkdirSync(other)
      const again = await init(scripted([], false), ['--dir', other, '--volume', `${data}:/data`])
      expect(again.exitCode).toBe(0)
      expect(served(other).settings.mounts).toEqual([{ kind: 'workspace', target: '/workspace', access: 'rw' }, { source: data, target: '/data', access: 'rw' }])
    })
  })

  // The mounts follow-up, second fix round, item F5: the read-only lookup of the folder reads the registry apart from the
  // manager, so a registry that parses with one invalid field was reported by the lookup and then by the manager.
  describe('with a workspaces.json that parses but holds one invalid field', () => {
    const REPORT = 'State file cannot be read safely'
    let reported: MockInstance<typeof logger.error>
    const reports = () => reported.mock.calls.filter(([message]) => message === REPORT).length
    beforeEach(async () => {
      await init(scripted([], false), ['--dir', workspace])
      const file = join(state, 'workspaces.json')
      const registry = JSON.parse(readFileSync(file, 'utf8')) as { workspaces: { online: unknown }[] }
      registry.workspaces[0]!.online = 'yes'
      writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`)
      errors = ''
      reported = vi.spyOn(logger, 'error').mockImplementation(() => {})
    })

    it.each([
      ['--volume and no terminal', () => scripted([], false), () => ['--dir', workspace, '--yes', '--volume', `${data}:/data`]],
      ['--volume at a terminal, after the folder is named', () => scripted([workspace, '']), () => ['--volume', `${data}:/data`]],
      ['a terminal and no --volume', () => scripted([workspace, '']), () => [] as string[]],
      ['--yes and no --volume', () => scripted([], false), () => ['--dir', workspace, '--yes']],
    ])('logs the failure once with %s, and refuses as before', async (_name, prompt, flags) => {
      const again = await init(prompt(), flags())
      expect(again.exitCode).toBe(1)
      expect(errors).toContain('State file is unreadable or invalid')
      expect(errors).toContain('workspaces.0.online')
      expect(errors).not.toContain('already served')
      expect(reports()).toBe(1)
    })
  })
})

describe.skipIf(process.platform === 'win32')('buckle init writes the environment file owner-only (RINGS-D20)', () => {
  it('narrows a world-readable file it replaces with --force', async () => {
    writeFileSync(out, 'BUCKLE_PORT=1\n')
    chmodSync(out, 0o644)
    await init(scripted([workspace, '', '', 'Fixture'], false), ['--force', '--root', workspace])
    expect(statSync(out).mode & 0o777).toBe(0o600)
  })
})

// The node's hosts apply to a workspace with no approved list of its own, and the question, asked just after the
// workspace's own list, says so as the comment above the line it writes does.
describe('the node hosts question', () => {
  it('is for a workspace with no list of its own, as the buckle.env comment above the line says', async () => {
    const prompt = scripted([workspace, '', '', 'Fixture', '', '', '', 'example.com', 'db.internal'])
    const result = await init(prompt)

    expect(prompt.asked[7]).toContain('Approved hosts and URLs')
    expect(prompt.asked[8]).toContain('Hosts a workspace with no approved list of its own may reach, which turns that list on')
    expect(prompt.asked[8]).not.toContain('every workspace')
    expect(result.written).toContain('# Hosts a workspace with no approved list of its own may reach, which turns that list on')
    expect(parseEnv(result.written).BUCKLE_ALLOWED_HOSTS).toBe('db.internal')
    // This workspace keeps the list it was just given; the node's hosts serve the others.
    expect(served().settings.policy.network.allow).toEqual(['example.com'])
  })
})

// Finding 4 of the fourth recheck: --force asked the hosts question, then wrote the old file's value over the answer.
describe('the node hosts question under --force', () => {
  const earlier = 'BUCKLE_ADMIN_TOKEN=old-admin-fixture\nBUCKLE_ALLOW_SHELL=false\nBUCKLE_ALLOWED_HOSTS=old.example,second.example\nBUCKLE_SANDBOX=none\n'
  const hostsQuestion = (prompt: { asked: string[] }) => prompt.asked.find(text => text.startsWith('Hosts a workspace with no approved list'))

  it('writes the owner\'s answer, not the old file\'s value, and does not list the key as kept', async () => {
    writeFileSync(out, earlier, { mode: 0o600 })
    const prompt = scripted([workspace, '', '', 'Fixture', '', '', '', '', 'new.example'])
    const result = await init(prompt, ['--force'])

    expect(result.exitCode).toBe(0)
    expect(parseEnv(result.written).BUCKLE_ALLOWED_HOSTS).toBe('new.example')
    expect(result.printed).toMatch(/Kept {8}BUCKLE_ALLOW_SHELL, every workspace's defaults/)
    expect(result.printed).not.toMatch(/Kept[^\n]*BUCKLE_ALLOWED_HOSTS/)
  })

  it('offers the old value as the question\'s default, so Enter keeps it and says it kept it', async () => {
    writeFileSync(out, earlier, { mode: 0o600 })
    const prompt = scripted([workspace, '', '', 'Fixture', '', '', '', '', ''])
    const result = await init(prompt, ['--force'])

    expect(hostsQuestion(prompt)).toMatch(/\[old\.example,second\.example\]: $/)
    expect(parseEnv(result.written).BUCKLE_ALLOWED_HOSTS).toBe('old.example,second.example')
    expect(result.printed).toMatch(/Kept {8}BUCKLE_ALLOW_SHELL, BUCKLE_ALLOWED_HOSTS.*every workspace's defaults/)
  })

  it('still shows [none] when the file written again holds no hosts', async () => {
    writeFileSync(out, 'BUCKLE_ADMIN_TOKEN=old-admin-fixture\nBUCKLE_SANDBOX=none\n', { mode: 0o600 })
    const forced = scripted([workspace, '', '', 'Fixture', '', '', '', '', ''])
    await init(forced, ['--force'])
    expect(hostsQuestion(forced)).toMatch(/\[none\]: $/)
  })
})

describe('workspace-first initialization defaults', () => {
  it.each([true, false])('uses the current folder, /workspace and the full path name (interactive=%s)', async interactive => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(workspace)
    try {
      const env = parseEnv((await init(scripted([], interactive))).written)
      expect(served().settings.mounts).toEqual([{ kind: 'workspace', target: '/workspace', access: 'rw' }])
      expect(env.BUCKLE_SERVER_NAME).toBe(workspace.replace(/[\\/]/g, '-'))
    } finally { cwd.mockRestore() }
  })
  it('derives the name from an explicit folder when accepting defaults with --yes, and takes --root as --dir', async () => {
    const env = parseEnv((await init(scripted([]), ['--root', workspace, '--yes'])).written)
    expect(served()).toMatchObject({ id: workspaceIdOf(workspace), name: 'workspace' })
    expect(env.BUCKLE_SERVER_NAME).toBe(workspace.replace(/[\\/]/g, '-'))
  })
  it('preserves explicit mount and name overrides', async () => {
    const env = parseEnv((await init(scripted([]), ['--dir', workspace, '--mount', '/project', '--name', 'Demo node', '--yes'])).written)
    expect(served().settings.mounts).toEqual([{ kind: 'workspace', target: '/project', access: 'rw' }])
    expect(env.BUCKLE_SERVER_NAME).toBe('Demo node')
  })
})

// Finding 34 of the workspace-model Phase 1 review: buckle init on a 0.1 node moves it from the file's own values.
describe('buckle init on a node set up before workspaces', () => {
  it('moves the node from its file alone, refusing a shell that sets its token otherwise, and writes nothing', async () => {
    const before = `BUCKLE_ADMIN_TOKEN=init-move-admin-fixture\nBUCKLE_AUTH_TOKEN=init-move-agent-fixture\nBUCKLE_WORKSPACE_ROOT=${workspace}\nBUCKLE_COMMAND_DENY=curl *\n`
    writeFileSync(out, before, { mode: 0o600 })
    vi.stubEnv('BUCKLE_AUTH_TOKEN', 'init-move-other-agent-fixture')
    let failed = ''
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { failed += String(chunk); return true })
    try {
      expect((await runInit(['--out', out, '--yes'], scripted([], false))).exitCode).toBe(1)
    } finally { stderr.mockRestore() }
    expect(failed).toContain(`BUCKLE_AUTH_TOKEN is set in this command's environment to another value than ${out} holds`)
    expect(failed).not.toContain('init-move-other-agent-fixture')
    expect(readFileSync(out, 'utf8')).toBe(before)
    expect(existsSync(join(state, 'workspaces.json'))).toBe(false)
  })

  // The mounts follow-up, first fix round: a folder the move itself makes a workspace is not in the registry to be found
  // before init opens the node, so the mounts named are checked first and then left out, and init says so.
  it('says the --volume mounts were not added where the move itself makes the folder a workspace', async () => {
    const data = join(workspace, '..', 'data')
    mkdirSync(data)
    writeFileSync(out, `BUCKLE_ADMIN_TOKEN=init-move-admin-fixture\nBUCKLE_AUTH_TOKEN=init-move-agent-fixture\nBUCKLE_WORKSPACE_ROOT=${workspace}\n`, { mode: 0o600 })

    const result = await init(scripted([], false), ['--yes', '--dir', workspace, '--volume', `${data}:/data`])
    expect(result.exitCode).toBe(0)
    expect(result.printed).toContain(`The mounts named were not added either; add them with buckle workspace mount add <local>:<sandbox>[:ro] --workspace ${basename(workspace)}.`)
    expect(JSON.stringify(served().settings)).not.toContain(data)
  })

  // Findings 11 and 21: --force as the first command used to rewrite the file before migration read it. D85, Q3: the
  // node's workspace defaults stay the node's, so the file written again keeps them, its deny list every workspace's floor.
  it('with --force, moves the node from the file it replaces first, so its folder\'s workspace keeps its folder, token, policy, and grants, and the node its defaults', async () => {
    const root = join(workspace, '..')
    vi.stubEnv('HOME', root)
    writeFileSync(out, `BUCKLE_ADMIN_TOKEN=old-admin-fixture\nBUCKLE_AUTH_TOKEN=init-force-agent-fixture\nBUCKLE_WORKSPACE_ROOT=${workspace}\nBUCKLE_COMMAND_DENY="curl *\nwget *"\nBUCKLE_ALLOW_SHELL=false\nBUCKLE_SANDBOX=none\n`, { mode: 0o600 })
    mkdirSync(state, { mode: 0o700 })
    const grant = { id: 'grant-1', workspace, rule: 'network_egress', subject: 'localhost:3000', scope: 'always', sessionId: null, createdAt: '2026-10-01T00:00:00.000Z', expiresAt: null }
    writeFileSync(join(state, 'grants.json'), JSON.stringify({ version: 1, grants: [grant] }))
    writeFileSync(join(state, 'policy.json'), JSON.stringify({ version: 1, workspaces: { [workspace]: { version: 1, commands: { allow: [], deny: ['rm -rf *'] }, network: { allow: [] }, mount: null, updatedAt: null } } }))

    const result = await init(scripted([], false), ['--force', '--yes', '--name', 'Fixture', '--dir', workspace])
    expect(result.exitCode).toBe(0)
    expect(result.printed).toContain(`${workspace} is already in workspace ${basename(workspace)}: nothing was added`)
    const registry = JSON.parse(readFileSync(join(state, 'workspaces.json'), 'utf8')) as { workspaces: Array<{ id: string; dir: string; tokens: Array<{ id: string }> }> }
    expect(registry.workspaces).toMatchObject([{ id: workspaceIdOf(workspace), dir: workspace, tokens: [{ id: 'node' }] }])
    expect(served().settings.policy.commands.deny).toEqual(['rm -rf *'])
    expect(parseEnv(result.written)).toMatchObject({ BUCKLE_COMMAND_DENY: 'curl *;;wget *', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_SANDBOX: 'auto' })
    expect(result.printed).toContain('Kept        BUCKLE_ALLOW_SHELL, BUCKLE_COMMAND_DENY, every workspace\'s defaults, from the file written again')
    expect(configFromEnvironment({ ...parseEnv(result.written), BUCKLE_STATE_DIR: state, BUCKLE_WORKSPACE_ROOT: workspace }).policy.commands.deny).toEqual(['curl *', 'wget *'])
    // The records moved to the workspace's own directory (D85, Q15), keyed by its id.
    expect(JSON.parse(readFileSync(join(state, 'workspaces', workspaceIdOf(workspace), 'grants.json'), 'utf8')).grants.map((item: { workspace: string }) => item.workspace)).toEqual([workspaceIdOf(workspace)])
    expect(parseEnv(result.written).BUCKLE_ADMIN_TOKEN).not.toBe('old-admin-fixture')
  })
})

// Finding 13 of the third recheck: --force kept the defaults NODE_SETTINGS named and dropped the node's mounts and browser.
describe('buckle init --force keeps every workspace default of the file it replaces', () => {
  it('writes the node\'s mounts and browser lines again and names them on the Kept line', async () => {
    const shared = join(workspace, '..', 'shared')
    mkdirSync(shared)
    const mounts = JSON.stringify([{ source: shared, target: '/tmp/home/.config', readOnly: true }])
    const profile = join(workspace, '..', 'browser-profile')
    writeFileSync(out, `BUCKLE_ADMIN_TOKEN=old-admin-fixture\nBUCKLE_ALLOW_SHELL=false\nBUCKLE_MOUNTS=${mounts}\nBUCKLE_BROWSER_PROFILE=${profile}\nBUCKLE_BROWSER_ARGS=--lang=en\nBUCKLE_BROWSER_HEADED=true\nBUCKLE_SANDBOX=none\n`, { mode: 0o600 })

    let failed = ''
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { failed += String(chunk); return true })
    const result = await init(scripted([], false), ['--force', '--yes', '--name', 'Fixture', '--dir', workspace])
    stderr.mockRestore()

    expect(failed).toBe('')
    expect(result.exitCode).toBe(0)
    expect(parseEnv(result.written)).toMatchObject({ BUCKLE_ALLOW_SHELL: 'false', BUCKLE_MOUNTS: mounts, BUCKLE_BROWSER_PROFILE: profile, BUCKLE_BROWSER_ARGS: '--lang=en', BUCKLE_BROWSER_HEADED: 'true' })
    expect(result.printed).toMatch(/Kept {8}BUCKLE_ALLOW_SHELL,.*BUCKLE_MOUNTS.*BUCKLE_BROWSER_PROFILE.*BUCKLE_BROWSER_ARGS.*BUCKLE_BROWSER_HEADED.*every workspace's defaults/)
    // The node reads them from the file written again.
    const defaults = loadConfig({ ...parseEnv(result.written), BUCKLE_STATE_DIR: state }).workspaceDefaults
    expect(defaults.browser).toEqual({ profile, args: '--lang=en', headed: true })
    expect(defaults.mounts).toMatchObject([{ source: shared, target: '/tmp/home/.config', access: 'ro' }])
  })

  it('carries an attached Chrome, and refuses nothing for a value only the file holds', async () => {
    writeFileSync(out, 'BUCKLE_ADMIN_TOKEN=old-admin-fixture\nBUCKLE_BROWSER_CDP=9222\nBUCKLE_SANDBOX=none\n', { mode: 0o600 })
    const result = await init(scripted([], false), ['--force', '--yes', '--name', 'Fixture', '--dir', workspace])
    expect(result.exitCode).toBe(0)
    expect(parseEnv(result.written).BUCKLE_BROWSER_CDP).toBe('9222')
    expect(result.printed).toContain('Kept        BUCKLE_BROWSER_CDP, every workspace\'s defaults')
  })
})

// buckle init checks the programs Buckle runs, so a missing agent-browser shows at setup rather than as a withheld
// pack later. The owner's terminal, unlike a pack's reason, shows the paths. Each program is resolved as the node that
// reads the file resolves it (review of 2026-10-14), so each test keeps the node's state, and so its workspace
// registry, beside its workspace rather than in the machine's own.
describe('buckle init checks the programs Buckle runs', () => {
  beforeEach(() => {
    vi.stubEnv('BUCKLE_AGENT_BROWSER_COMMAND', undefined)
    vi.stubEnv('BUCKLE_SCRATCH_ROOTS', undefined)
  })

  async function programs(input: { platform: NodeJS.Platform; programSearch: ProgramSearch; interactive?: boolean; root?: string }): Promise<string> {
    let printed = ''
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { printed += String(chunk); return true })
    const root = input.root ?? workspace
    // A node of its own each time, so each run sets the folder up anew.
    vi.stubEnv('BUCKLE_STATE_DIR', mkdtempSync(join(workspace, '..', 'state-')))
    try {
      const prompt = scripted(input.interactive ? [root, '', '', 'Fixture'] : [], input.interactive ?? false)
      const result = await runInit(['--root', root, '--out', out, '--port', '4399', '--force', ...input.interactive ? [] : ['--yes']], prompt, { platform: input.platform, programSearch: input.programSearch })
      expect(result.exitCode).toBe(0)
    } finally { stdout.mockRestore() }
    // The interactive branch ran when nothing says the defaults were kept unasked.
    expect(printed.includes('These are the defaults, kept because nothing was asked')).toBe(!input.interactive)
    return printed.slice(printed.indexOf('Programs\n'), printed.indexOf('\nNext:'))
  }
  function executable(path: string): string {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '#!/bin/sh\nexit 0\n')
    chmodSync(path, 0o755)
    return path
  }

  it.each([false, true])('says where each is found, and for each one missing where it looked and what it unlocks, after the settings (interactive: %s)', async (interactive) => {
    const bin = join(workspace, '..', 'bin')
    const nodeBin = join(workspace, '..', 'node-bin')
    executable(join(bin, 'git'))
    executable(join(nodeBin, 'rg'))
    const printed = await programs({ platform: 'linux', interactive, programSearch: { environment: { PATH: bin }, places: [{ directory: nodeBin, label: 'beside node' }] } })
    expect(printed).toBe([
      'Programs',
      '  bwrap           not found on PATH (1 directory) or beside node; it unlocks the sandboxed shell pack',
      `  rg              found at ${join(nodeBin, 'rg')} (beside node)`,
      `  git             found at ${join(bin, 'git')}`,
      '  agent-browser   not found on PATH (1 directory) or beside node; it unlocks the browser pack; install it with npm i -g agent-browser, then run agent-browser install',
      '',
    ].join('\n'))
  })

  it('looks the browser up by BUCKLE_AGENT_BROWSER_COMMAND, and says why one it found is not run', async () => {
    const planted = executable(join(workspace, 'bin', 'git'))
    vi.stubEnv('BUCKLE_AGENT_BROWSER_COMMAND', join(workspace, '..', 'tools', 'agent-browser'))
    const printed = await programs({ platform: 'linux', programSearch: { environment: { PATH: join(workspace, 'bin') }, places: [] } })
    expect(printed).toContain(`  git             found at ${planted}, not run: git is found in or through a workspace of this node, where an agent can write, so Buckle does not run it\n`)
    expect(printed).toContain(`  agent-browser   not found at ${join(workspace, '..', 'tools', 'agent-browser')}; it unlocks the browser pack;`)
  })

  // Review of 2026-10-14: init checked the root as typed alone, and read an empty setting otherwise than serve did.
  it('refuses as the node does: through the folder\'s link, or in a scratch root', async () => {
    const base = join(workspace, '..')
    const real = join(base, 'data', 'proj')
    mkdirSync(real, { recursive: true })
    symlinkSync(real, join(base, 'proj'))
    executable(join(real, 'node_modules', '.bin', 'agent-browser'))
    executable(join(base, 'scratch', 'rg'))
    // A node default now, which the node reads from its file alone, so the file --force writes again carries it.
    writeFileSync(out, `BUCKLE_SCRATCH_ROOTS=${join(base, 'scratch')}\n`)
    const search = { environment: { PATH: [join(real, 'node_modules', '.bin'), join(base, 'scratch')].join(':') }, places: [] }
    const printed = await programs({ platform: 'linux', root: join(base, 'proj'), programSearch: search })
    expect(printed).toContain(`  agent-browser   found at ${join(real, 'node_modules', '.bin', 'agent-browser')}, not run: agent-browser is found in or through a workspace of this node, where an agent can write, so Buckle does not run it\n`)
    expect(printed).toContain(`  rg              found at ${join(base, 'scratch', 'rg')}, not run: rg is found in or through a scratch root of this node, where an agent can write, so Buckle does not run it\n`)
  })

  it('refuses, changing nothing, while the registry cannot be read', async () => {
    mkdirSync(state)
    const broken = '{"version": 1, "workspaces": "not a list"}\n'
    writeFileSync(join(state, 'workspaces.json'), broken)
    let failed = ''
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { failed += String(chunk); return true })
    try {
      const result = await init(scripted([], false), ['--dir', workspace])
      expect(result.exitCode).toBe(1)
    } finally { stderr.mockRestore() }
    expect(failed).toContain('workspaces.json')
    expect(readFileSync(join(state, 'workspaces.json'), 'utf8')).toBe(broken)
  })

  it('reads an empty BUCKLE_AGENT_BROWSER_COMMAND as unset, as the node reads it', async () => {
    vi.stubEnv('BUCKLE_AGENT_BROWSER_COMMAND', '')
    expect(await programs({ platform: 'linux', programSearch: { environment: { PATH: '' }, places: [] } })).toContain('  agent-browser   not found on PATH (0 directories); it unlocks the browser pack;')
    expect(await programs({ platform: 'linux', programSearch: { environment: { PATH: '' }, places: [] } })).toContain('  rg              not found on PATH (0 directories); it unlocks a faster fs_search_content, which Buckle runs with its own walker without it\n')
    expect(configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: state, BUCKLE_AGENT_BROWSER_COMMAND: '' }).agentBrowserCommand).toBe('agent-browser')
  })

  it('on Windows, imitated, names a script a shim starts, the native program behind one, and a shim it cannot read, leaving bwrap out', async () => {
    const npm = join(workspace, '..', 'npm')
    const script = join(npm, 'node_modules', 'agent-browser', 'bin', 'agent-browser.js')
    const exe = join(npm, 'node_modules', 'rg', 'rg.exe')
    for (const file of [script, exe]) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, '') }
    // npm's own shim, the one shape in which Buckle runs a script with its Node.
    writeFileSync(join(npm, 'agent-browser.cmd'), [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\agent-browser\\bin\\agent-browser.js" %*', '',
    ].join('\r\n'))
    writeFileSync(join(npm, 'rg.cmd'), '@ECHO off\r\n"%~dp0node_modules\\rg\\rg.exe" %*\r\n')
    writeFileSync(join(npm, 'git.cmd'), '@ECHO off\r\n"%~dp0\\git" %*\r\n')
    const table: Record<string, string> = { 'agent-browser': join(npm, 'agent-browser.cmd'), 'rg': join(npm, 'rg.cmd'), 'git': join(npm, 'git.cmd') }
    const printed = await programs({ platform: 'win32', interactive: true, programSearch: { lookup: name => table[name] ?? null } })
    const windows = (path: string) => path.replaceAll('/', '\\')
    expect(printed).toBe([
      'Programs',
      `  rg              found at ${windows(exe)}, through a shim`,
      `  git             found ${windows(join(npm, 'git.cmd'))}, a shim Buckle cannot read`,
      `  agent-browser   found at ${windows(script)}, a script run with Buckle's Node`,
      '',
    ].join('\n'))
    writeFileSync(join(npm, 'agent-browser.cmd'), '@ECHO off\r\n"%~dp0node_modules\\agent-browser\\bin\\agent-browser" %*\r\n')
    expect(await programs({ platform: 'win32', programSearch: { lookup: name => table[name] ?? null } }))
      .toContain(`  agent-browser   found ${windows(join(npm, 'agent-browser.cmd'))}, a shim Buckle cannot read; set BUCKLE_AGENT_BROWSER_COMMAND to the agent-browser .exe or script inside its package\n`)
  })
})

// Fix brief 4, findings 2 and 41: init in a folder named node threw the registry's schema dump after it had written the
// folder's records, and every later init was refused over records that were never removed.
describe.each([['node'], ['3f2a1c2e-8b4d-4f0a-9c7e-2d5b1a8f3c6e']])('buckle init in a folder named %s', (folderName) => {
  let folder: string
  let errors: string
  beforeEach(() => {
    folder = join(workspace, '..', folderName)
    mkdirSync(folder)
    errors = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { errors += String(chunk); return true })
  })

  it('is refused without a name to ask for, naming the command that takes one, with no schema dump and no records written', async () => {
    const result = await runInit(['--out', out, '--port', '4399', '--dir', folder, '--yes'], scripted([], false), {})

    expect(result.exitCode).toBe(1)
    expect(errors).toContain('cannot be a workspace name')
    expect(errors).toContain('name it with buckle workspace init --dir <folder> --name <name>')
    expect(errors).not.toMatch(/"code"|workspaces\.\d/)
    expect(existsSync(join(state, 'workspaces'))).toBe(false)
    // The node itself is set up, so the command it names works at once.
    expect(existsSync(out)).toBe(true)
  })

  it('asks for the workspace\'s name at a terminal, and serves the folder under the answer', async () => {
    const prompt = scripted([folder, '', '', 'Fixture', '', '', '', '', '', 'nodejs'])
    const result = await init(prompt)

    expect(result.exitCode).toBe(0)
    expect(prompt.asked.at(-1)).toContain('cannot be a workspace name')
    expect(served(folder).name).toBe('nodejs')
  })
})
