import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { TOOL_NAME_PATTERN } from '@5straps/protocol'
import { createPathView } from '../src/domain/path-view.js'
import { createBuiltinPacks } from '../src/packs/index.js'
import { availableTools } from '../src/domain/pack.js'
import { createToolRegistry } from '../src/domain/tool-registry.js'
import { loadConfig } from '../src/config.js'
import { hasExecutable } from '../src/domain/executable.js'
import { createNoneSandbox } from '../src/adapters/sandbox/none-sandbox.js'
import { defineTool } from '../src/domain/tool.js'
import { toolNameToCommand, commandToToolName, buildToolArgs, parseArgsOptions } from '../src/faces/cli/arguments.js'

function builtinRegistry(allowHostGit = false) {
  const packs = createBuiltinPacks({
    allowHostGit,
    cwd: '/work/project',
    paths: createPathView({ root: '/work/project', mount: null }),
    hiddenPaths: [],
    mountReadOnlyPaths: [],
    approvedUrls: null,
    approvedLists: [],
    runProcess: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false }),
    sandbox: createNoneSandbox(),
    writableRoots: ['/work/project'],
    allowedHosts: [],
    forge: { apiUrl: 'https://api.github.com', author: { name: 'test', email: 'test@example.com' } },
    stateDirectory: '/state',
    agentBrowserCommand: 'agent-browser',
    browserStateDirectory: '/state/browser-profiles/project',
    browserHeaded: false,
    enableShell: true,
    sandboxUnavailableReason: null,
  })
  return createToolRegistry(availableTools(packs))
}

describe('built-in tools', () => {
  it('withholds host Git and forge tools by default, including an explicit false setting', () => {
    expect(loadConfig({}).allowHostGit).toBe(false)
    expect(loadConfig({ BUCKLE_ALLOW_HOST_GIT: 'false' }).allowHostGit).toBe(false)
    expect(loadConfig({ BUCKLE_ALLOW_HOST_GIT: 'true' }).allowHostGit).toBe(true)
    expect(builtinRegistry().capabilities().some(tool => /^(git|forge)_/.test(tool.name))).toBe(false)
  })

  it.runIf(hasExecutable('git'))('allows host Git only after the owner opts in', () => {
    expect(builtinRegistry(true).capabilities().map(tool => tool.name)).toContain('git_diff')
  })

  it('every name is accepted by MCP clients', () => {
    for (const capability of builtinRegistry().capabilities()) {
      expect(capability.name, capability.name).toMatch(TOOL_NAME_PATTERN)
    }
  })

  it('derives a JSON Schema for every tool', () => {
    for (const capability of builtinRegistry().capabilities()) {
      expect(capability.inputSchema.type, capability.name).toBe('object')
    }
  })

  it('round-trips every name through the CLI command mapping', () => {
    for (const capability of builtinRegistry().capabilities()) {
      const { group, verb } = toolNameToCommand(capability.name)
      expect(commandToToolName(group, verb)).toBe(capability.name)
    }
  })

  it('rejects a duplicate tool name across packs', () => {
    const duplicate = () => defineTool('other', {
      name: 'fs_read',
      description: 'Clashing tool',
      risk: 'read',
      input: z.object({}),
      effects: () => [],
      run: async () => null,
    })
    expect(() => createToolRegistry([...availableTools([]), duplicate(), duplicate()])).toThrow(/Duplicate tool/)
  })
})

describe('defineTool', () => {
  it('refuses a name MCP clients would reject', () => {
    expect(() => defineTool('fs', {
      name: 'fs.read',
      description: 'Dotted name',
      risk: 'read',
      input: z.object({}),
      effects: () => [],
      run: async () => null,
    })).toThrow(/not MCP-safe/)
  })

  it('derives the JSON Schema from the Zod schema, so the two cannot drift', () => {
    const tool = defineTool('demo', {
      name: 'demo_tool',
      description: 'Demo',
      risk: 'read',
      input: z.object({ path: z.string().min(1), depth: z.number().int().default(1) }),
      effects: () => [],
      run: async () => null,
    })
    expect(tool.capability.inputSchema).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' }, depth: { type: 'integer' } },
      required: ['path'],
    })
  })

  it('rejects arguments the schema does not accept', () => {
    const tool = defineTool('demo', {
      name: 'demo_tool',
      description: 'Demo',
      risk: 'read',
      input: z.object({ depth: z.number() }),
      effects: () => [],
      run: async () => null,
    })
    expect(() => tool.prepare({ depth: 'three' })).toThrow()
  })
})

describe('CLI argument mapping', () => {
  it('fills required fields from positionals and coerces flags by schema type', () => {
    const capability = builtinRegistry().get('fs_read').capability
    const args = buildToolArgs({ capability, positionals: ['src/app.ts'], flags: { limit: '25', offset: '3' } })
    expect(args).toEqual({ path: 'src/app.ts', limit: 25, offset: 3 })
  })

  it('tells parseArgs which flags take a value, so numbers are not read as booleans', () => {
    const options = parseArgsOptions(builtinRegistry().get('fs_read').capability)
    expect(options.limit).toEqual({ type: 'string', multiple: false })
  })

  it('marks boolean fields as boolean flags', () => {
    const options = parseArgsOptions(builtinRegistry().get('fs_list').capability)
    expect(options['include-ignored']).toEqual({ type: 'boolean' })
  })

  it('passes a trailing argument list through to the command', () => {
    const capability = builtinRegistry().get('shell_exec').capability
    const args = buildToolArgs({ capability, positionals: ['pnpm', 'build', '--filter', 'web'], flags: {} })
    expect(args).toEqual({ command: 'pnpm', args: ['build', '--filter', 'web'] })
  })

  it('collects every positional when the required field is itself a list', () => {
    const capability = builtinRegistry().get('fs_read_batch').capability
    const args = buildToolArgs({ capability, positionals: ['a.ts', 'b.ts'], flags: {} })
    expect(args).toEqual({ paths: ['a.ts', 'b.ts'] })
  })

  it('refuses extra positionals instead of running a shorter command than asked', () => {
    const capability = builtinRegistry().get('fs_read').capability
    expect(() => buildToolArgs({ capability, positionals: ['a.ts', 'b.ts'], flags: {} }))
      .toThrow(/Unexpected extra arguments/)
  })
})
