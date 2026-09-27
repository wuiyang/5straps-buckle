import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuckleConfig } from '../common/runtime/config.js'

const config = { serverId: 'mode-dispatch' } as BuckleConfig
const entry = vi.hoisted(() => ({
  loadEnvironmentFile: vi.fn(),
  loadConfig: vi.fn(),
  runInitCommand: vi.fn(async () => ({ exitCode: 3 })),
  runSettingsCommand: vi.fn(async () => ({ exitCode: 4 })),
  runCli: vi.fn(async () => ({ exitCode: 5 })),
  serveHttp: vi.fn(async () => {}),
  serveMcpStdio: vi.fn(async () => {}),
}))
vi.mock('../common/runtime/environment.js', () => ({ loadEnvironmentFile: entry.loadEnvironmentFile }))
vi.mock('../common/runtime/config.js', () => ({ loadConfig: entry.loadConfig }))
vi.mock('../cli/main.js', () => ({ runInitCommand: entry.runInitCommand, runSettingsCommand: entry.runSettingsCommand, runCli: entry.runCli }))
vi.mock('../server/hono/serve.js', () => ({ serveHttp: entry.serveHttp }))
vi.mock('../mcp/stdio.js', () => ({ serveMcpStdio: entry.serveMcpStdio }))

const { main, selectMode } = await import('../main.js')

beforeEach(() => {
  vi.clearAllMocks()
  entry.loadConfig.mockReturnValue(config)
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

  it('starts HTTP for serve with the config loaded after the environment file, and no CLI', async () => {
    expect(await main(['serve'])).toBeUndefined()
    expect(entry.serveHttp).toHaveBeenCalledWith(config)
    expect(entry.loadEnvironmentFile.mock.invocationCallOrder[0]).toBeLessThan(entry.loadConfig.mock.invocationCallOrder[0]!)
    expect(entry.serveMcpStdio).not.toHaveBeenCalled()
    expect(entry.runCli).not.toHaveBeenCalled()
  })

  it('starts the stdio MCP server for mcp, and no HTTP', async () => {
    expect(await main(['mcp'])).toBeUndefined()
    expect(entry.serveMcpStdio).toHaveBeenCalledWith(config)
    expect(entry.serveHttp).not.toHaveBeenCalled()
  })

  it('hands every other argument list to the CLI with the loaded config', async () => {
    expect(await main(['fs', 'read', 'notes.txt'])).toBe(5)
    expect(entry.runCli).toHaveBeenCalledWith({ argv: ['fs', 'read', 'notes.txt'], config })
    expect(await main([])).toBe(5)
    expect(entry.runCli).toHaveBeenLastCalledWith({ argv: [], config })
    expect(entry.loadEnvironmentFile).toHaveBeenCalledTimes(2)
  })
})
