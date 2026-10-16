import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuckleConfig } from '../common/runtime/config.js'

const config = { serverId: 'mode-dispatch', stateDirectory: '/nonexistent/buckle-mode-dispatch-state', cwd: process.cwd() } as BuckleConfig
const entry = vi.hoisted(() => ({
  loadEnvironmentFile: vi.fn(() => ({ file: null, openToOthers: false })),
  loadConfig: vi.fn(),
  runInitCommand: vi.fn(async () => ({ exitCode: 3 })),
  runSettingsCommand: vi.fn(async () => ({ exitCode: 4 })),
  runCli: vi.fn(async () => ({ exitCode: 5 })),
  serveHttp: vi.fn(async () => {}),
  setupServer: vi.fn(async () => ({ requestCli: vi.fn() })),
  serveMcpStdio: vi.fn(async () => {}),
  initializeCommon: vi.fn(() => ({ owner: { onClose: vi.fn(), close: vi.fn(async () => {}) }, bindRequester: vi.fn() })),
  configureOwnerOnlyCheck: vi.fn(),
  /** What the root logger main configures was told to warn about, by message. */
  warnings: [] as string[],
}))
vi.mock('../common/runtime/environment.js', async importOriginal => ({ ...await importOriginal<typeof import('../common/runtime/environment.js')>(), loadEnvironmentFile: entry.loadEnvironmentFile }))
vi.mock('../common/runtime/config.js', async importOriginal => ({ ...await importOriginal<typeof import('../common/runtime/config.js')>(), loadConfig: entry.loadConfig }))
vi.mock('../cli/main.js', () => ({ runInitCommand: entry.runInitCommand, runSettingsCommand: entry.runSettingsCommand, runCli: entry.runCli, answerWithoutConfiguration: () => null }))
vi.mock('../server/serve.js', () => ({ serveHttp: entry.serveHttp }))
vi.mock('../server/setup-server.js', () => ({ setupServer: entry.setupServer, builtEntryPath: () => '/built/.output/server/index.mjs' }))
vi.mock('../mcp/stdio.js', async importOriginal => ({ serveMcpStdio: entry.serveMcpStdio, mcpTarget: (await importOriginal<typeof import('../mcp/stdio.js')>()).mcpTarget }))
vi.mock('../common/runtime/initialize.js', () => ({ initializeCommon: entry.initializeCommon }))
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

const { main, selectMode, stopSignals, takeGlobalFlags } = await import('../main.js')

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
    [['--skip-owner-only-check', 'policy', 'show'], { argv: ['policy', 'show'], skipOwnerOnlyCheck: true }],
    [['policy', 'show', '--skip-owner-only-check'], { argv: ['policy', 'show'], skipOwnerOnlyCheck: true }],
    [['policy', '--skip-owner-only-check', 'show'], { argv: ['policy', 'show'], skipOwnerOnlyCheck: true }],
    [['serve', '--skip-owner-only-check'], { argv: ['serve'], skipOwnerOnlyCheck: true }],
    [['fs', 'read', 'notes.txt'], { argv: ['fs', 'read', 'notes.txt'], skipOwnerOnlyCheck: false }],
    // After a `--` every argument is the command's own, the flag's spelling included.
    [['fs', 'write', '--', '--skip-owner-only-check'], { argv: ['fs', 'write', '--', '--skip-owner-only-check'], skipOwnerOnlyCheck: false }],
  ])('reads %j as %j', (argv, taken) => {
    expect(takeGlobalFlags(argv)).toEqual(taken)
  })
})

describe('main', () => {
  it('takes --skip-owner-only-check before or after the command word, so buckle policy never sees it', async () => {
    for (const argv of [['--skip-owner-only-check', 'policy', 'show'], ['policy', 'show', '--skip-owner-only-check']]) {
      expect(await main(argv)).toBe(5)
      expect(entry.runCli).toHaveBeenLastCalledWith({ argv: ['policy', 'show'], config })
      expect(entry.configureOwnerOnlyCheck).toHaveBeenLastCalledWith({ skip: true })
    }
    expect(await main(['--skip-owner-only-check', 'init', '--yes'])).toBe(3)
    expect(entry.runInitCommand).toHaveBeenCalledWith(['--yes'])
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
      expect(entry.warnings).toContainEqual('Not read: BUCKLE_PACKS, BUCKLE_ALLOW_SHELL are set in this command\'s environment, but this node has no buckle.env. A node takes every workspace\'s defaults from its environment file alone, so a shell\'s or an MCP config\'s env cannot change them; run buckle init to write the file, then set them with buckle settings set.')
      expect(entry.loadConfig).toHaveBeenLastCalledWith(process.env, process.platform, expect.objectContaining({ file: null, defaultsFromFileAlone: true }))
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
      expect(entry.warnings).toContainEqual('Not read: BUCKLE_COMMAND_DENY, BUCKLE_ALLOW_SHELL are set in this command\'s environment to another value than /state/buckle.env holds. A node takes every workspace\'s defaults from its environment file alone, so a shell\'s or an MCP config\'s env cannot change them; change them with buckle settings set.')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('runs init and settings before, and without, the environment file and the node config', async () => {
    expect(await main(['init', '--yes'])).toBe(3)
    expect(entry.runInitCommand).toHaveBeenCalledWith(['--yes'])
    expect(await main(['settings', 'show'])).toBe(4)
    expect(entry.runSettingsCommand).toHaveBeenCalledWith(['show'])
    expect(entry.loadEnvironmentFile).not.toHaveBeenCalled()
    expect(entry.loadConfig).not.toHaveBeenCalled()
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

  // Fix brief 4, findings 34 and 49: a workspace is typed by its name, not the UUID Buckle assigns.
  it('names the workspace buckle mcp serves by --workspace <name>', async () => {
    const printed = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await main(['mcp', '--help'])).toBe(0)
    expect(String(printed.mock.calls[0]![0])).toContain('Usage: buckle mcp [--workspace <name> | --dir <path>]')
  })

  it('hands every other argument list to the CLI with the loaded config', async () => {
    expect(await main(['fs', 'read', 'notes.txt'])).toBe(5)
    expect(entry.runCli).toHaveBeenCalledWith({ argv: ['fs', 'read', 'notes.txt'], config })
    expect(await main([])).toBe(5)
    expect(entry.runCli).toHaveBeenLastCalledWith({ argv: [], config })
    expect(entry.loadEnvironmentFile).toHaveBeenCalledTimes(2)
    // The CLI builds its own command-scoped runtime; main starts no service runtime for it.
    expect(entry.initializeCommon).not.toHaveBeenCalled()
  })
})
