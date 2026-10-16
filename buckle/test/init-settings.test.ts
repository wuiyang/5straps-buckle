import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { parseEnv } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runInit, serveCommand, type InitPrompt } from '../cli/init.js'
import type { ProgramSearch } from '../common/domain/executable.js'
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
    // Q3: the node's file holds the node's settings alone, and no agent token: the workspace's is in the registry, hashed.
    for (const key of ['BUCKLE_AUTH_TOKEN', 'BUCKLE_WORKSPACE_ROOT', 'BUCKLE_WORKSPACE_MOUNT', 'BUCKLE_ALLOW_SHELL', 'BUCKLE_PACKS', 'BUCKLE_ALLOW_HOST_GIT', 'BUCKLE_NETWORK_ALLOW', 'BUCKLE_ALLOWED_HOSTS']) expect(env[key]).toBeUndefined()
    expect(result.written).toContain('# BUCKLE_ALLOWED_HOSTS=db.internal')
    // D85, Q3: Enter leaves the setting unset, so the node's value applies, else Buckle's.
    const { settings } = served()
    expect(settings.packs).toEqual({})
    expect(settings.policy.network).toEqual({ allow: [] })
    expect(settings.mounts).toEqual([{ kind: 'workspace', target: '/workspace', access: 'write' }])
    expect(result.printed).toMatch(/Packs\s+all, and plugins/)
    expect(result.printed).toMatch(/Shell\s+on/)
  })

  it('writes the answers that move off a default', async () => {
    const result = await init(scripted([workspace, '', 'Fixture', 'fs, shell', 'n', 'y', 'localhost:3000,*.example.com', 'db.internal']))

    expect(parseEnv(result.written)).toMatchObject({ BUCKLE_ALLOWED_HOSTS: 'db.internal' })
    const { settings } = served()
    expect(settings.packs).toMatchObject({ enabled: ['fs', 'shell'], shell: false, hostGit: true })
    expect(settings.policy.network).toEqual({ allow: ['localhost:3000', '*.example.com'] })
    expect(result.printed).toMatch(/Packs\s+fs, shell/)
    expect(result.printed).toMatch(/Host Git\s+on/)
  })

  it('asks again after an answer the settings check refuses, saying why', async () => {
    const prompt = scripted([workspace, '', 'Fixture', 'fs,rocket', 'fs', 'maybe', '', '', '*', '', '*.0.0.1', ''])
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
    const refused = scripted([workspace, '', 'Fixture', 'fs,environment', 'fs'])
    await init(refused)
    expect(served().settings.packs.enabled).toEqual(['fs'])
    expect(refused.said).toContainEqual(expect.stringContaining('environment (BUCKLE_ENV_VALIDATOR_COMMAND is not set)'))

    vi.stubEnv('BUCKLE_ENV_VALIDATOR_COMMAND', 'varlock load')
    const other = join(workspace, '..', 'other')
    mkdirSync(other)
    // The node is set up already, so its name is not asked again.
    const accepted = scripted([other, '', 'fs,environment'])
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

  it('names no variable for the file in the default state directory, on any platform', () => {
    for (const platform of ['linux', 'win32'] as const) expect(serveCommand(defaultEnvironmentFile({}), {}, platform)).toEqual([{ shell: null, lines: ['buckle serve'] }])
  })

  it('prints each Windows form on its own labelled line, the restrict example quoted as each shell reads it', async () => {
    const { printed } = await init(scripted([workspace, '', 'Fixture']), [], 'win32')
    expect(printed).toContain([
      '  1. Start the node:',
      `       PowerShell   $env:BUCKLE_ENV_FILE = '${out}'; buckle serve`,
      `       cmd          set "BUCKLE_ENV_FILE=${out}" && buckle serve`,
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
    const { printed } = await init(scripted([workspace, '', 'Fixture']), [], 'linux')
    expect(printed).toContain(`  1. Start the node:            BUCKLE_ENV_FILE=${out} buckle serve\n`)
    expect(printed).toContain("  3. Restrict it:               buckle policy allow-command 'pnpm {build,test} *'\n                                buckle policy allow-url localhost:3000\n")
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

describe.skipIf(process.platform === 'win32')('buckle init writes the environment file owner-only (RINGS-D20)', () => {
  it('narrows a world-readable file it replaces with --force', async () => {
    writeFileSync(out, 'BUCKLE_PORT=1\n')
    chmodSync(out, 0o644)
    await init(scripted([workspace, '', 'Fixture'], false), ['--force', '--root', workspace])
    expect(statSync(out).mode & 0o777).toBe(0o600)
  })
})

describe('workspace-first initialization defaults', () => {
  it.each([true, false])('uses the current folder, /workspace and the full path name (interactive=%s)', async interactive => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(workspace)
    try {
      const env = parseEnv((await init(scripted([], interactive))).written)
      expect(served().settings.mounts).toEqual([{ kind: 'workspace', target: '/workspace', access: 'write' }])
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
    expect(served().settings.mounts).toEqual([{ kind: 'workspace', target: '/project', access: 'write' }])
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
      const prompt = scripted(input.interactive ? [root, '', 'Fixture'] : [], input.interactive ?? false)
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
    vi.stubEnv('BUCKLE_SCRATCH_ROOTS', join(base, 'scratch'))
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
    const prompt = scripted([folder, '', 'Fixture', '', '', '', '', '', 'nodejs'])
    const result = await init(prompt)

    expect(result.exitCode).toBe(0)
    expect(prompt.asked.at(-1)).toContain('cannot be a workspace name')
    expect(served(folder).name).toBe('nodejs')
  })
})
