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
}))
vi.mock('../common/runtime/environment.js', async importOriginal => ({ ...await importOriginal<typeof import('../common/runtime/environment.js')>(), loadEnvironmentFile: entry.loadEnvironmentFile }))
vi.mock('../common/runtime/config.js', async importOriginal => ({ ...await importOriginal<typeof import('../common/runtime/config.js')>(), loadConfig: entry.loadConfig }))
vi.mock('../cli/main.js', async importOriginal => ({ runInitCommand: entry.runInitCommand, runSettingsCommand: entry.runSettingsCommand, runCli: entry.runCli, answerWithoutConfiguration: () => null, runsTool: (await importOriginal<typeof import('../cli/main.js')>()).runsTool }))
vi.mock('../server/serve.js', () => ({ serveHttp: entry.serveHttp }))
vi.mock('../server/setup-server.js', () => ({ setupServer: entry.setupServer, builtEntryPath: () => '/built/.output/server/index.mjs' }))
vi.mock('../mcp/stdio.js', () => ({ serveMcpStdio: entry.serveMcpStdio }))
vi.mock('../common/runtime/initialize.js', () => ({ initializeCommon: entry.initializeCommon }))

const { main, selectMode } = await import('../main.js')

beforeEach(() => {
  vi.clearAllMocks()
  entry.loadConfig.mockReturnValue(config)
  // The service modes install process-wide signal and rejection handlers; none may reach this worker.
  vi.spyOn(process, 'once').mockReturnValue(process)
  vi.spyOn(process, 'on').mockReturnValue(process)
  vi.spyOn(process.stdin, 'once').mockReturnValue(process.stdin)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('selectMode', () => {
  it.each([
    [['init', '--yes'], { kind: 'init', argv: ['--yes'] }],
    [['settings', 'set', 'shell', 'off'], { kind: 'settings', argv: ['set', 'shell', 'off'] }],
    [['serve'], { kind: 'serve' }],
    [['mcp'], { kind: 'mcp' }],
    [[], { kind: 'cli', argv: [] }],
    [['--version'], { kind: 'cli', argv: ['--version'] }],
    [['fs', 'read', 'notes.txt'], { kind: 'cli', argv: ['fs', 'read', 'notes.txt'] }],
  ])('reads %j as %j', (argv, mode) => {
    expect(selectMode(argv)).toEqual(mode)
  })
})

describe('main', () => {
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

  it('starts the stdio MCP server for mcp on one mcp-role common runtime, and no HTTP', async () => {
    expect(await main(['mcp'])).toBeUndefined()
    expect(entry.initializeCommon).toHaveBeenCalledWith(expect.objectContaining({ config, role: 'mcp' }))
    expect(entry.serveMcpStdio).toHaveBeenCalledWith(expect.objectContaining({ config, common: entry.initializeCommon.mock.results[0]!.value }))
    expect(entry.initializeCommon.mock.results[0]!.value.bindRequester).toHaveBeenCalledTimes(1)
    expect(entry.serveHttp).not.toHaveBeenCalled()
    expect(entry.setupServer).not.toHaveBeenCalled()
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
