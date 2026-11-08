import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'pathe'
import type { RequestCli } from '@5straps/runtime'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuckleConfig } from '../common/runtime/config.js'
import type { ConsoleWriter } from '../common/runtime/console.js'
import { startActionLogWriter } from './support/action-log-writer.js'

const config = { serverId: 'mode-dispatch', stateDirectory: '/nonexistent/buckle-mode-dispatch-state', environmentFile: '/nonexistent/buckle-mode-dispatch.env', cwd: process.cwd() } as BuckleConfig
const entry = vi.hoisted(() => ({
  loadEnvironmentFile: vi.fn(() => ({ file: null, openToOthers: false })),
  loadConfig: vi.fn(),
  runInitCommand: vi.fn(async () => ({ exitCode: 3 })),
  runSettingsCommand: vi.fn(async () => ({ exitCode: 4 })),
  runServiceCommand: vi.fn(async () => ({ exitCode: 6 })),
  runCli: vi.fn(async () => ({ exitCode: 5 })),
  serveHttp: vi.fn(async () => {}),
  setupServer: vi.fn(async () => ({ requestCli: vi.fn() })),
  serveMcpStdio: vi.fn(async () => {}),
  initializeCommon: vi.fn(() => ({ owner: { onClose: vi.fn(), close: vi.fn(async () => {}) }, bindRequester: vi.fn() })),
  configureOwnerOnlyCheck: vi.fn(),
  /** A node serving the state directory, as `buckle serve` sees one; none by default. */
  runningNode: vi.fn(async (): Promise<unknown> => null),
  /** The serve lock every serve takes, and the record it publishes once it listens. */
  holdServe: vi.fn(async () => ({ publish: entry.publish })),
  publish: vi.fn(async () => {}),
  recordEnvironmentFile: vi.fn(async () => {}),
  /** What the root logger main configures was told to warn about, by message. */
  warnings: [] as string[],
}))
vi.mock('../common/runtime/environment.js', async importOriginal => ({ ...await importOriginal<typeof import('../common/runtime/environment.js')>(), loadEnvironmentFile: entry.loadEnvironmentFile }))
vi.mock('../common/runtime/config.js', async importOriginal => ({ ...await importOriginal<typeof import('../common/runtime/config.js')>(), loadConfig: entry.loadConfig }))
vi.mock('../cli/main.js', () => ({ runInitCommand: entry.runInitCommand, runSettingsCommand: entry.runSettingsCommand, runServiceCommand: entry.runServiceCommand, runCli: entry.runCli, answerWithoutConfiguration: () => null }))
vi.mock('../server/serve.js', () => ({ serveHttp: entry.serveHttp }))
vi.mock('../server/setup-server.js', () => ({ setupServer: entry.setupServer, builtEntryPath: () => '/built/.output/server/index.mjs' }))
vi.mock('../mcp/stdio.js', async importOriginal => ({ serveMcpStdio: entry.serveMcpStdio, mcpTarget: (await importOriginal<typeof import('../mcp/stdio.js')>()).mcpTarget }))
vi.mock('../common/runtime/initialize.js', () => ({ initializeCommon: entry.initializeCommon }))
vi.mock('../common/runtime/environment-files.js', async importOriginal => ({ ...await importOriginal<typeof import('../common/runtime/environment-files.js')>(), recordEnvironmentFile: entry.recordEnvironmentFile }))
vi.mock('../common/services/node-service/serve-record.js', async importOriginal => ({ ...await importOriginal<typeof import('../common/services/node-service/serve-record.js')>(), runningNode: entry.runningNode, holdServe: entry.holdServe }))
vi.mock('../common/adapters/file-modes.js', async importOriginal => ({ ...await importOriginal<typeof import('../common/adapters/file-modes.js')>(), configureOwnerOnlyCheck: entry.configureOwnerOnlyCheck }))
vi.mock('../common/runtime/log.js', async importOriginal => {
  const original = await importOriginal<typeof import('../common/runtime/log.js')>()
  // The real root, with its warnings kept here: main warns on the root it configures, not on the shared logger.
  const configureRootLogger: typeof original.configureRootLogger = (config) => {
    const root = original.configureRootLogger(config)
    vi.spyOn(root.logger, 'warn').mockImplementation((message) => { entry.warnings.push(String(message)) })
    return root
  }
  return { ...original, configureRootLogger }
})
// The real requester, with what main hands it kept, so a test reads the terminal it attaches (fix brief 1, H6).
vi.mock('../cli/setup.js', async importOriginal => {
  const original = await importOriginal<typeof import('../cli/setup.js')>()
  return { ...original, setupCli: vi.fn(original.setupCli) }
})

const { main, selectMode, stopSignals, takeGlobalFlags } = await import('../main.js')
const { setupCli } = await import('../cli/setup.js')
const { flushLogs, logger } = await import('../common/runtime/log.js')
const { questionFor } = await import('../common/adapters/approval/terminal-question.js')
const { createFileActionLog } = await import('../common/adapters/action-log/file-action-log.js')

beforeEach(() => {
  vi.clearAllMocks()
  entry.warnings.length = 0
  entry.loadConfig.mockReturnValue(config)
  // The service modes install process-wide signal and rejection handlers; none may reach this worker.
  vi.spyOn(process, 'once').mockReturnValue(process)
  vi.spyOn(process, 'on').mockReturnValue(process)
  vi.spyOn(process.stdin, 'once').mockReturnValue(process.stdin)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the signals that stop the service', () => {
  it('are SIGTERM and SIGINT on Linux and macOS, and on Windows, which delivers no SIGTERM, Ctrl-C, Ctrl-Break, and closing the console', () => {
    expect(stopSignals('linux')).toEqual(['SIGTERM', 'SIGINT'])
    expect(stopSignals('darwin')).toEqual(['SIGTERM', 'SIGINT'])
    expect(stopSignals('win32')).toEqual(['SIGINT', 'SIGBREAK', 'SIGHUP'])
  })
})

describe('selectMode', () => {
  it.each([
    [['init', '--yes'], { kind: 'init', argv: ['--yes'] }],
    [['settings', 'set', 'shell', 'off'], { kind: 'settings', argv: ['set', 'shell', 'off'] }],
    [['client', 'keygen'], { kind: 'client', argv: ['keygen'] }],
    [['cp', 'app.tgz', 'site:'], { kind: 'cp', argv: ['app.tgz', 'site:'] }],
    [['service', 'install', '--now'], { kind: 'service', argv: ['install', '--now'] }],
    [['serve'], { kind: 'serve', options: [] }],
    [['mcp'], { kind: 'mcp', options: [] }],
    [['mcp', '--workspace', 'site'], { kind: 'mcp', options: ['--workspace', 'site'] }],
    [[], { kind: 'cli', argv: [] }],
    [['--version'], { kind: 'cli', argv: ['--version'] }],
    [['fs', 'read', 'notes.txt'], { kind: 'cli', argv: ['fs', 'read', 'notes.txt'] }],
  ])('reads %j as %j', (argv, mode) => {
    expect(selectMode(argv)).toEqual(mode)
  })
})

describe('takeGlobalFlags', () => {
  it.each([
    [['--skip-owner-only-check', 'policy', 'show'], { argv: ['policy', 'show'], skipOwnerOnlyCheck: true, ignoreWarning: false }],
    [['policy', 'show', '--skip-owner-only-check'], { argv: ['policy', 'show'], skipOwnerOnlyCheck: true, ignoreWarning: false }],
    [['policy', '--skip-owner-only-check', 'show'], { argv: ['policy', 'show'], skipOwnerOnlyCheck: true, ignoreWarning: false }],
    [['serve', '--skip-owner-only-check'], { argv: ['serve'], skipOwnerOnlyCheck: true, ignoreWarning: false }],
    [['fs', 'read', 'notes.txt'], { argv: ['fs', 'read', 'notes.txt'], skipOwnerOnlyCheck: false, ignoreWarning: false }],
    // After a `--` every argument is the command's own, the flag's spelling included.
    [['fs', 'write', '--', '--skip-owner-only-check'], { argv: ['fs', 'write', '--', '--skip-owner-only-check'], skipOwnerOnlyCheck: false, ignoreWarning: false }],
    // APPROVAL-16: the owner's command runs where its record cannot be written.
    [['--ignore-warning', 'grants', 'revoke', 'g-1'], { argv: ['grants', 'revoke', 'g-1'], skipOwnerOnlyCheck: false, ignoreWarning: true }],
    [['grants', 'revoke', 'g-1', '--ignore-warning'], { argv: ['grants', 'revoke', 'g-1'], skipOwnerOnlyCheck: false, ignoreWarning: true }],
    [['--ignore-warning', 'settings', 'set', 'a', 'b', '--skip-owner-only-check'], { argv: ['settings', 'set', 'a', 'b'], skipOwnerOnlyCheck: true, ignoreWarning: true }],
    [['fs', 'write', '--', '--ignore-warning'], { argv: ['fs', 'write', '--', '--ignore-warning'], skipOwnerOnlyCheck: false, ignoreWarning: false }],
  ])('reads %j as %j', (argv, taken) => {
    expect(takeGlobalFlags(argv)).toEqual(taken)
  })
})

describe('main', () => {
  it('takes --skip-owner-only-check before or after the command word, so buckle policy never sees it', async () => {
    for (const argv of [['--skip-owner-only-check', 'policy', 'show'], ['policy', 'show', '--skip-owner-only-check']]) {
      expect(await main(argv)).toBe(5)
      expect(entry.runCli).toHaveBeenLastCalledWith({ argv: ['policy', 'show'], config, ignoreWarning: false })
      expect(entry.configureOwnerOnlyCheck).toHaveBeenLastCalledWith({ skip: true })
    }
    expect(await main(['--skip-owner-only-check', 'init', '--yes'])).toBe(3)
    expect(entry.runInitCommand).toHaveBeenCalledWith(['--yes'], { ignoreWarning: false })
    // Fix brief 6, item 11: buckle service install writes it into the definition, so it reaches the command, wherever it stands.
    for (const argv of [['--skip-owner-only-check', 'service', 'install'], ['service', 'install', '--skip-owner-only-check']]) {
      expect(await main(argv)).toBe(6)
      expect(entry.runServiceCommand).toHaveBeenLastCalledWith(['install'], { skipOwnerOnlyCheck: true, ignoreWarning: false })
    }
    expect(await main(['--skip-owner-only-check', 'serve'])).toBeUndefined()
    expect(entry.initializeCommon).toHaveBeenCalledWith(expect.objectContaining({ role: 'server' }))
    expect(await main(['policy', 'show'])).toBe(5)
    expect(entry.configureOwnerOnlyCheck).toHaveBeenLastCalledWith({ skip: false })
  })

  // D85, Q3, and fix brief 4, finding 42: a node reads every workspace's defaults from its environment file alone, so a
  // node with no file has none, and a start whose environment sets any says so, naming the keys and no value.
  it('warns at start, naming each workspace default the environment sets where the node has no file, which it does not read', async () => {
    vi.stubEnv('BUCKLE_ALLOW_SHELL', 'false')
    vi.stubEnv('BUCKLE_PACKS', 'fs')
    try {
      expect(await main(['policy', 'show'])).toBe(5)
      expect(entry.warnings).toContainEqual('Not read: BUCKLE_PACKS and BUCKLE_ALLOW_SHELL are set in this command\'s environment, but this node has no buckle.env. A node takes every workspace\'s defaults, and the decision AI\'s keys and addresses, from its environment file alone, so a shell\'s or an MCP config\'s env cannot change them; run buckle init to write the file, then set them with buckle settings set, or a decision AI key or address in buckle.env by hand.')
      expect(entry.loadConfig).toHaveBeenLastCalledWith(process.env, process.platform, expect.objectContaining({ file: null, defaultsFromFileAlone: true }))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  // Addendum A1 of Phase 3: the keys are listed as the pages list things, with the Oxford comma.
  it('lists three or more keys it does not read with the Oxford comma', async () => {
    vi.stubEnv('BUCKLE_ALLOW_SHELL', 'false')
    vi.stubEnv('BUCKLE_PACKS', 'fs')
    vi.stubEnv('BUCKLE_MOUNTS', '/srv/assets:/assets')
    try {
      expect(await main(['policy', 'show'])).toBe(5)
      expect(entry.warnings).toContainEqual(expect.stringMatching(/^Not read: BUCKLE_PACKS, BUCKLE_ALLOW_SHELL, and BUCKLE_MOUNTS are set in this command's environment, but this node has no buckle\.env\./))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  // D85, Q3: a workspace default the caller's env sets otherwise is not read, and the start says so, naming no value.
  it('warns at start, naming each workspace default the environment sets to another value than the file, which it does not read', async () => {
    entry.loadEnvironmentFile.mockReturnValueOnce({ file: '/state/buckle.env', openToOthers: false, values: { BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' } } as never)
    vi.stubEnv('BUCKLE_ALLOW_SHELL', 'true')
    vi.stubEnv('BUCKLE_PACKS', 'fs')
    vi.stubEnv('BUCKLE_COMMAND_DENY', '')
    try {
      expect(await main(['policy', 'show'])).toBe(5)
      expect(entry.warnings).toContainEqual('Not read: BUCKLE_COMMAND_DENY and BUCKLE_ALLOW_SHELL are set in this command\'s environment to another value than /state/buckle.env holds. A node takes every workspace\'s defaults, and the decision AI\'s keys and addresses, from its environment file alone, so a shell\'s or an MCP config\'s env cannot change them; change them with buckle settings set, or a decision AI key or address in buckle.env by hand.')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('hands --ignore-warning to the owner\'s commands, and refuses it where no owner\'s record is written', async () => {
    expect(await main(['grants', 'revoke', 'g-1', '--ignore-warning'])).toBe(5)
    expect(entry.runCli).toHaveBeenLastCalledWith({ argv: ['grants', 'revoke', 'g-1'], config, ignoreWarning: true })
    expect(await main(['--ignore-warning', 'init', '--yes'])).toBe(3)
    expect(entry.runInitCommand).toHaveBeenLastCalledWith(['--yes'], { ignoreWarning: true })
    expect(await main(['settings', 'set', 'a', 'b', '--ignore-warning'])).toBe(4)
    expect(entry.runSettingsCommand).toHaveBeenLastCalledWith(['set', 'a', 'b'], { ignoreWarning: true })
    expect(await main(['service', 'install', '--ignore-warning'])).toBe(6)
    expect(entry.runServiceCommand).toHaveBeenLastCalledWith(['install'], { skipOwnerOnlyCheck: false, ignoreWarning: true })
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    for (const argv of [['serve', '--ignore-warning'], ['mcp', '--ignore-warning'], ['cp', 'a', 'w:b', '--ignore-warning']]) {
      expect(await main(argv)).toBe(1)
      expect(String(stderr.mock.calls.at(-1)?.[0])).toContain('--ignore-warning')
    }
    expect(entry.initializeCommon).not.toHaveBeenCalled()
  })

  it('runs init, settings, and service before, and without, the environment file and the node config', async () => {
    expect(await main(['init', '--yes'])).toBe(3)
    expect(entry.runInitCommand).toHaveBeenCalledWith(['--yes'], { ignoreWarning: false })
    expect(await main(['settings', 'show'])).toBe(4)
    expect(entry.runSettingsCommand).toHaveBeenCalledWith(['show'], { ignoreWarning: false })
    // Phase 3: no credential is in the environment when buckle service starts systemctl or schtasks.exe.
    expect(await main(['service', 'install', '--now'])).toBe(6)
    expect(entry.runServiceCommand).toHaveBeenCalledWith(['install', '--now'], { skipOwnerOnlyCheck: false, ignoreWarning: false })
    expect(entry.loadEnvironmentFile).not.toHaveBeenCalled()
    expect(entry.loadConfig).not.toHaveBeenCalled()
  })

  // init, settings, and service open no owner whose close would write what they queue for the audit log: main does, before
  // it answers the exit code.
  describe('for a one-shot command that opens no owner', () => {
    beforeAll(startActionLogWriter)

    it.each([
      ['init', entry.runInitCommand, 3],
      ['settings', entry.runSettingsCommand, 4],
      ['service', entry.runServiceCommand, 6],
    ] as const)('writes what buckle %s queued for its audit log before it answers', async (command, run, exitCode) => {
      const folder = mkdtempSync(join(tmpdir(), 'buckle-main-audit-'))
      const file = join(folder, 'actions.jsonl')
      run.mockImplementationOnce(async () => {
        createFileActionLog(file).append({ event: 'result', at: new Date().toISOString(), requestId: command, sessionId: 'local-owner', tool: `cli_${command}`, outcome: 'ok', durationMs: 0, effects: [], args: {} })
        return { exitCode }
      })
      try {
        expect(await main([command, 'show'])).toBe(exitCode)
        expect(readFileSync(file, 'utf8')).toContain(`"tool":"cli_${command}"`)
      } finally { rmSync(folder, { recursive: true, force: true }) }
    })
  })

  it('starts HTTP for serve on one server-role common runtime, with the config loaded after the environment file, and no CLI', async () => {
    expect(await main(['serve'])).toBeUndefined()
    expect(entry.initializeCommon).toHaveBeenCalledTimes(1)
    expect(entry.initializeCommon).toHaveBeenCalledWith(expect.objectContaining({ config, role: 'server' }))
    const common = entry.initializeCommon.mock.results[0]!.value
    // The built app is bound before anything is served, and HTTP asks through its cli:call dispatcher.
    expect(entry.setupServer).toHaveBeenCalledWith(expect.objectContaining({ common, entryPath: '/built/.output/server/index.mjs' }))
    const server = await entry.setupServer.mock.results[0]!.value
    expect(common.bindRequester).toHaveBeenCalledWith(server.requestCli)
    expect(entry.serveHttp).toHaveBeenCalledWith(expect.objectContaining({ config, common, server }))
    expect(entry.loadEnvironmentFile.mock.invocationCallOrder[0]).toBeLessThan(entry.loadConfig.mock.invocationCallOrder[0]!)
    expect(entry.serveMcpStdio).not.toHaveBeenCalled()
    expect(entry.runCli).not.toHaveBeenCalled()
    // The process's one requester is bound before anything is served.
    expect(entry.initializeCommon.mock.results[0]!.value.bindRequester).toHaveBeenCalledTimes(1)
  })

  it('records the environment file it reads in its state directory once it holds the serve lock, before anything is built', async () => {
    expect(await main(['serve'])).toBeUndefined()
    expect(entry.recordEnvironmentFile).toHaveBeenCalledWith({ stateDirectory: config.stateDirectory, file: config.environmentFile })
    expect(entry.holdServe.mock.invocationCallOrder[0]).toBeLessThan(entry.recordEnvironmentFile.mock.invocationCallOrder[0]!)
    expect(entry.recordEnvironmentFile.mock.invocationCallOrder[0]).toBeLessThan(entry.setupServer.mock.invocationCallOrder[0]!)
  })

  it('records nothing for buckle mcp, which takes no file outside its state directory', async () => {
    await main(['mcp'])
    expect(entry.recordEnvironmentFile).not.toHaveBeenCalled()
  })

  // Fix brief 6, item 1: a serve at a terminal holds the state directory's serve lock as a service does, and records
  // itself as `terminal` once it listens, so the service family sees it; it keeps listing its workspaces at the terminal.
  it('holds the serve lock for a serve at a terminal, before anything is built, and records it as terminal once it listens', async () => {
    expect(await main(['serve'])).toBeUndefined()
    expect(entry.holdServe).toHaveBeenCalledWith(expect.objectContaining({ stateDirectory: config.stateDirectory }))
    expect(entry.holdServe.mock.invocationCallOrder[0]).toBeLessThan(entry.setupServer.mock.invocationCallOrder[0]!)
    const served = (entry.serveHttp.mock.calls as unknown[][])[0]![0] as { onListening?: (address: { address: string; port: number }) => Promise<void>; write?: unknown }
    expect(served.write).toBeUndefined()
    await served.onListening!({ address: '127.0.0.1', port: 4320 })
    expect(entry.publish).toHaveBeenCalledWith(expect.objectContaining({ manager: 'terminal', host: '127.0.0.1', port: 4320 }))
  })

  it('refuses buckle serve beside a serve at another terminal, saying to stop that one there with Ctrl-C', async () => {
    entry.runningNode.mockResolvedValueOnce({ record: { pid: 4243, manager: 'terminal', version: '0.1.4', host: '127.0.0.1', port: 4320, startedAt: '2026-10-16T00:00:00.000Z' } })
    const refused = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(await main(['serve'])).toBe(1)
    expect(String(refused.mock.calls[0]![0])).toBe('Buckle runs at a terminal (pid 4243); stop it there with Ctrl-C, then run buckle serve again.\n')
    expect(entry.initializeCommon).not.toHaveBeenCalled()
  })

  it('listens for the stop signals of this platform, so a stop always runs the close steps', async () => {
    await main(['serve'])
    const listened = vi.mocked(process.once).mock.calls.map(([event]) => event)
    expect(listened).toEqual(expect.arrayContaining(stopSignals()))
  })

  it('starts the stdio MCP server for mcp on one mcp-role common runtime, and no HTTP', async () => {
    expect(await main(['mcp'])).toBeUndefined()
    expect(entry.initializeCommon).toHaveBeenCalledWith(expect.objectContaining({ config, role: 'mcp' }))
    expect(entry.serveMcpStdio).toHaveBeenCalledWith(expect.objectContaining({ config, common: entry.initializeCommon.mock.results[0]!.value, target: {} }))
    expect(entry.initializeCommon.mock.results[0]!.value.bindRequester).toHaveBeenCalledTimes(1)
    expect(entry.serveHttp).not.toHaveBeenCalled()
    expect(entry.setupServer).not.toHaveBeenCalled()
  })

  // The workspace-model brief, item 3: buckle mcp serves the workspace it names, by id or by folder, relative to where it starts.
  it('hands buckle mcp the workspace its flags name, a folder resolved where it starts', async () => {
    await main(['mcp', '--workspace', 'site'])
    expect(entry.serveMcpStdio).toHaveBeenLastCalledWith(expect.objectContaining({ target: { workspace: 'site' } }))
    await main(['mcp', '--dir', 'project'])
    expect(entry.serveMcpStdio).toHaveBeenLastCalledWith(expect.objectContaining({ target: { dir: join(process.cwd(), 'project') } }))
  })

  // Migration reads the file alone (finding 34 of the workspace-model Phase 1 review): the config keeps the file's own
  // values apart from the environment the process was started with.
  it('loads the config with the environment file\'s own values and the caller\'s environment kept apart', async () => {
    entry.loadEnvironmentFile.mockReturnValueOnce({ file: '/state/buckle.env', openToOthers: false, values: { BUCKLE_ALLOW_SHELL: 'false' } } as never)
    vi.stubEnv('BUCKLE_ALLOW_SHELL', 'true')
    try {
      await main(['fs', 'read', 'notes.txt'])
      expect(entry.loadConfig).toHaveBeenCalledWith(process.env, process.platform, { file: { path: '/state/buckle.env', values: { BUCKLE_ALLOW_SHELL: 'false' } }, caller: expect.objectContaining({ BUCKLE_ALLOW_SHELL: 'true' }), defaultsFromFileAlone: true })
    } finally { vi.unstubAllEnvs() }
  })

  // Fix brief 4, finding 7: an MCP config's env, which an agent may be able to write, named another settings file, or
  // none, and so lifted every workspace's deny lists; buckle mcp now reads only the node's own.
  describe('with BUCKLE_ENV_FILE set', () => {
    let state: string
    let elsewhere: string
    beforeEach(() => {
      state = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-mode-state-')))
      elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-mode-elsewhere-')))
      vi.stubEnv('BUCKLE_STATE_DIR', state)
    })
    afterEach(() => {
      vi.unstubAllEnvs()
      for (const directory of [state, elsewhere]) rmSync(directory, { recursive: true, force: true })
    })
    const file = (directory: string, name: string) => { const path = join(directory, name); writeFileSync(path, 'BUCKLE_COMMAND_DENY=\n'); return path }

    it.each([
      ['a file outside the state directory', () => file(elsewhere, 'buckle.env')],
      ['a file outside it, spelled through it', () => { file(elsewhere, 'buckle.env'); return `${state}/../${basename(elsewhere)}/buckle.env` }],
      ['a link in it to a file outside it', () => { const link = join(state, 'linked.env'); symlinkSync(file(elsewhere, 'buckle.env'), link); return link }],
      ['no file, in the state directory', () => join(state, 'missing.env')],
      ['a relative path', () => 'project/settings.env'],
    ])('refuses buckle mcp %s, naming the variable and never the path, before it reads anything', async (_case, named) => {
      const path = named()
      vi.stubEnv('BUCKLE_ENV_FILE', path)
      const refused = await main(['mcp']).catch((error: unknown) => error)
      expect(refused).toBeInstanceOf(Error)
      expect((refused as Error).message).toContain('BUCKLE_ENV_FILE names a file outside the node\'s state directory, or no file')
      expect((refused as Error).message).not.toContain(path)
      expect(entry.loadEnvironmentFile).not.toHaveBeenCalled()
      expect(entry.serveMcpStdio).not.toHaveBeenCalled()
    })

    it.each([
      ['the default buckle.env, there or not', () => join(state, 'buckle.env')],
      ['a file in the state directory', () => { mkdirSync(join(state, 'settings')); return file(join(state, 'settings'), 'node.env') }],
    ])('lets buckle mcp read %s', async (_case, named) => {
      vi.stubEnv('BUCKLE_ENV_FILE', named())
      expect(await main(['mcp'])).toBeUndefined()
      expect(entry.serveMcpStdio).toHaveBeenCalledTimes(1)
    })

    it('lets buckle serve and the owner\'s commands read a file anywhere, as before', async () => {
      vi.stubEnv('BUCKLE_ENV_FILE', file(elsewhere, 'buckle.env'))
      expect(await main(['serve'])).toBeUndefined()
      expect(entry.serveHttp).toHaveBeenCalledTimes(1)
      expect(await main(['policy', 'show'])).toBe(5)
      expect(entry.loadEnvironmentFile).toHaveBeenCalledTimes(2)
    })
  })

  // Finding 24 of the workspace-model Phase 1 review: help starts nothing and reads no configuration.
  it.each([['serve', '--help'], ['serve', '-h'], ['mcp', '--help'], ['mcp', '-h'], ['mcp', '--workspace', 'site', '--help']])('prints the usage for %j and starts nothing', async (...argv) => {
    const printed = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await main(argv)).toBe(0)
    expect(String(printed.mock.calls[0]![0])).toContain(`Usage: buckle ${argv[0]}`)
    expect(entry.loadEnvironmentFile).not.toHaveBeenCalled()
    expect(entry.initializeCommon).not.toHaveBeenCalled()
  })

  // Q5 of the 2026-10-15 rulings (Phase 3, item 5): beside a node running with no terminal, serve attaches nothing and starts nothing.
  it('refuses buckle serve where a node already serves in service mode, naming the attach command, reading no configuration', async () => {
    entry.runningNode.mockResolvedValueOnce({ record: { pid: 4242, manager: 'systemd', version: '0.1.4', host: '127.0.0.1', port: 4320, startedAt: '2026-10-16T00:00:00.000Z' } })
    const refused = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(await main(['serve'])).toBe(1)
    expect(String(refused.mock.calls[0]![0])).toMatch(/^Buckle is already running in service mode \(pid 4242\), so buckle serve starts nothing\. Answer its approvals here with: buckle approvals --watch( --all)?\n$/)
    expect(entry.loadEnvironmentFile).not.toHaveBeenCalled()
    expect(entry.initializeCommon).not.toHaveBeenCalled()
    expect(entry.serveHttp).not.toHaveBeenCalled()
  })

  // The CLI display slice, C1: the log's format is read once buckle.env is, and a value it does not know is refused there.
  it('refuses a BUCKLE_LOG_FORMAT other than json or human before the command runs, with the fixed message', async () => {
    vi.stubEnv('BUCKLE_LOG_FORMAT', 'pretty')
    const refused = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(await main(['fs', 'read', 'notes.txt'])).toBe(1)
    } finally {
      vi.unstubAllEnvs()
    }
    expect(String(refused.mock.calls[0]![0])).toBe('BUCKLE_LOG_FORMAT must be json or human\n')
    expect(entry.runCli).not.toHaveBeenCalled()
  })

  // Phase 3, item 1: serve ignored every option it did not take, --background among them, and served in the foreground.
  it.each([[['serve', '--bogus'], "Unknown option '--bogus'"], [['serve', '--state-dir', '/srv/state'], 'what a service definition passes']])('refuses %j with the reason, reading no configuration and starting nothing', async (argv, reason) => {
    const refused = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(await main(argv)).toBe(1)
    expect(String(refused.mock.calls[0]![0])).toContain(reason)
    expect(entry.loadEnvironmentFile).not.toHaveBeenCalled()
    expect(entry.initializeCommon).not.toHaveBeenCalled()
  })

  // House rule: the Oxford comma in a list of three, in the text an owner reads first.
  it('writes the three faces buckle serve offers with the Oxford comma', async () => {
    const printed = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await main(['serve', '--help'])).toBe(0)
    expect(String(printed.mock.calls[0]![0])).toContain('over HTTP, native RPC, and MCP, at')
  })

  // Fix brief 4, finding 20: buckle serve was the first command after an upgrade and never asked for the node folder's name.
  describe('the question for the node folder\'s name while a 0.1 node moves', () => {
    const terminals = (isTTY: boolean) => {
      for (const stream of [process.stdin, process.stderr]) Object.defineProperty(stream, 'isTTY', { value: isTTY, configurable: true, writable: true })
    }
    afterEach(() => { for (const stream of [process.stdin, process.stderr]) Reflect.deleteProperty(stream, 'isTTY') })

    it('is asked at a terminal by buckle serve, which hands the runtime a way to ask', async () => {
      terminals(true)
      await main(['serve'])
      expect(entry.initializeCommon).toHaveBeenCalledWith(expect.objectContaining({ role: 'server', askName: expect.any(Function) }))
    })

    it.each([['serve without a terminal', ['serve'], false], ['mcp at a terminal, where stdin carries the protocol', ['mcp'], true]])('is never asked by %s', async (_how, argv, isTTY) => {
      terminals(isTTY)
      await main(argv)
      expect(entry.initializeCommon).toHaveBeenCalledTimes(1)
      expect((entry.initializeCommon.mock.calls as unknown[][])[0]![0]).not.toHaveProperty('askName')
    })
  })

  // The CLI display slice, C3: at a terminal, the log lines, the workspace list, and the questions share one writer.
  describe('the console of buckle serve', () => {
    const terminals = (isTTY: boolean) => {
      for (const stream of [process.stdin, process.stderr]) Object.defineProperty(stream, 'isTTY', { value: isTTY, configurable: true, writable: true })
    }
    afterEach(() => { for (const stream of [process.stdin, process.stderr]) Reflect.deleteProperty(stream, 'isTTY') })

    it('is one writer at a terminal, which the workspace list goes through', async () => {
      terminals(true)
      await main(['serve'])
      const served = (entry.serveHttp.mock.calls as unknown[][])[0]![0] as { console?: unknown; write?: unknown }
      expect(served.console).toEqual(expect.objectContaining({ write: expect.any(Function), block: expect.any(Function), asking: expect.any(Function) }))
      expect(served.write).toBeUndefined()
    })

    it('is none where stderr is no terminal, so the list is written as before', async () => {
      terminals(false)
      await main(['serve'])
      expect(((entry.serveHttp.mock.calls as unknown[][])[0]![0] as { console?: unknown }).console).toBeUndefined()
    })

    // Fix brief 1, H6: each line that joins the console to buckle serve, held by a test of its own.
    const served = () => ((entry.serveHttp.mock.calls as unknown[][])[0]![0] as { console: ConsoleWriter }).console
    const stderrText = (written: { mock: { calls: unknown[][] } }) => written.mock.calls.map(([chunk]) => String(chunk)).join('')

    it('writes the date separator before the first line it writes', async () => {
      terminals(true)
      const written = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      await main(['serve'])
      served().write(['14:22:00 [info] the first line'], new Date())
      await flushLogs()
      expect(String(written.mock.calls[0]![0])).toMatch(/^--- \d{4}-\d\d-\d\d ---\n/)
    })

    it('writes a block after the log lines logged before it', async () => {
      terminals(true)
      const written = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      await main(['serve'])
      for (let index = 1; index <= 20; index += 1) logger.info(`logged before the block, line ${index}`)
      await served().block(['one block of lines'], new Date())
      await flushLogs()
      const text = stderrText(written)
      expect(text).toContain('logged before the block, line 20\n')
      expect(text.indexOf('one block of lines\n')).toBeGreaterThan(text.indexOf('logged before the block, line 20\n'))
    })

    it('asks its approval questions through the same console', async () => {
      terminals(true)
      await main(['serve'])
      expect(vi.mocked(setupCli).mock.calls[0]![0].terminal?.console).toBe(served())
    })

    // The CLI display slice, C5: with nobody at its terminal, a node logs each question it cannot ask.
    it('logs Approval pending for a question a serve with no terminal cannot ask', async () => {
      terminals(false)
      const written = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      await main(['serve'])
      const { requestCli } = (entry.setupServer.mock.calls as unknown[][])[0]![0] as { requestCli: RequestCli }
      await requestCli(questionFor({
        approval: { token: 't-headless', rule: 'write_scope', subject: '/outside/a.md', reason: 'outside the workspace', tool: 'fs_write', offeredScopes: ['once'], expiresAt: new Date(Date.now() + 60_000).toISOString() },
        workspaceId: 'w-1', workspaceName: 'site', context: { correlationId: 'c-headless', sessionId: 's' },
      }))
      await flushLogs()
      const lines = stderrText(written).split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as { message: string })
      expect(lines).toContainEqual(expect.objectContaining({ level: 'info', message: 'Approval pending', fields: expect.objectContaining({ tool: 'fs_write', workspace: 'site' }) }))
    })
  })

  // Fix brief 4, findings 34 and 49: a workspace is typed by its name, not the UUID Buckle assigns.
  it('names the workspace buckle mcp serves by --workspace <name>', async () => {
    const printed = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await main(['mcp', '--help'])).toBe(0)
    expect(String(printed.mock.calls[0]![0])).toContain('Usage: buckle mcp [--workspace <name> | --dir <path>]')
  })

  it('hands every other argument list to the CLI with the loaded config', async () => {
    expect(await main(['fs', 'read', 'notes.txt'])).toBe(5)
    expect(entry.runCli).toHaveBeenCalledWith({ argv: ['fs', 'read', 'notes.txt'], config, ignoreWarning: false })
    expect(await main([])).toBe(5)
    expect(entry.runCli).toHaveBeenLastCalledWith({ argv: [], config, ignoreWarning: false })
    expect(entry.loadEnvironmentFile).toHaveBeenCalledTimes(2)
    // The CLI builds its own command-scoped runtime; main starts no service runtime for it.
    expect(entry.initializeCommon).not.toHaveBeenCalled()
  })
})
