import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyWorkspacePolicy, type ToolCapability } from '@5straps/protocol'
import { createPiCodemodeVm } from '../common/adapters/script-vm/pi-codemode.js'
import { createNoneSandbox } from '../common/adapters/sandbox/none-sandbox.js'
import { createPathView } from '../common/domain/path-view.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { createBuiltinPacks } from '../common/services/packs/index.js'
import { CODE_TOOLS } from '../common/services/packs/code/index.js'
import { codeRunDescription, declare, DECLARATION_BUDGET_TOKENS, withinBudget } from '../common/services/packs/code/declarations.js'
import { createFsPack } from '../common/services/packs/fs/index.js'
import { createWebPack } from '../common/services/packs/web/index.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'

// What a script is told about the tools it can call (owner decision D82, point 9): TypeScript declarations from each
// tool's schema and description, within a budget in code_run's description, and whole from code_api.

const vm = createPiCodemodeVm()
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** Every tool the built-in packs define, available here or not, but the code tools. */
function builtinTools(): ToolCapability[] {
  const paths = createPathView({ root: '/work/project', mount: null })
  const runProcess = async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false })
  const packs = [
    ...createBuiltinPacks({
      allowHostGit: true, allowHostLsp: true, enableShell: true, cwd: '/work/project', paths, hiddenPaths: [], mountReadOnlyPaths: [], approvedUrls: null, approvedLists: [],
      runProcess, sandbox: createNoneSandbox(), writableRoots: ['/work/project'], 
      forge: { token: 'fixture-token', apiUrl: 'https://api.github.com', author: { name: 'test', email: 'test@example.com' } },
      stateDirectory: '/state', agentBrowserCommand: 'agent-browser', browserStateDirectory: '/state/browser', browserHeaded: false, environmentValidator: 'validate', sandboxUnavailableReason: null,
    }),
    createFsPack({ paths, runProcess, ripgrep: { path: 'rg', argv0: 'rg', args: [] }, protectedRoots: [] }),
    createWebPack({ braveSearchApiKey: 'fixture', approved: null }),
  ]
  const byName = new Map(packs.flatMap(pack => pack.tools.map(tool => [tool.capability.name, tool.capability] as const)))
  return [...byName.values()].filter(tool => !CODE_TOOLS.includes(tool.name)).sort((left, right) => left.name.localeCompare(right.name))
}

describe('declarations of the built-in tools', () => {
  const tools = builtinTools()

  it.each(tools.map(tool => [tool.name, tool] as const))('renders %s from its schema, its description, and what it resolves to', (name, tool) => {
    const declared = declare(vm, [tool])
    expect(declared.startsWith('declare const tools: {')).toBe(true)
    expect(declared).toContain(tool.description.trim().split('\n')[0]!)
    expect(declared).toMatch(new RegExp(`\\n  ${name}\\(args: [^)]`))
    expect(declared).not.toContain(`${name}(args: unknown)`)
    expect(declared).toContain('): Promise<unknown>;')
    // Every built-in tool names its result's fields; only a plugin's falls back to the generic line.
    expect(declared).toMatch(/Resolves to \{/)
  })

  it('fits every built-in tool\'s declaration in code_run\'s description, within the budget', () => {
    expect(tools.length).toBeGreaterThan(25)
    expect(declare(vm, tools).length).toBeLessThanOrEqual(DECLARATION_BUDGET_TOKENS * 4)
    expect(withinBudget(vm, tools).named).toEqual([])
    expect(codeRunDescription(vm, tools)).not.toContain('Also callable')
  })

  it('past the budget, declares the tools that fit and names the rest, never both and never neither', () => {
    // Plugins' tools with long descriptions, enough to pass the budget twice over.
    const plugins = Array.from({ length: 40 }, (_, index) => ({ ...tools[0]!, name: `plugin_tool_${index}`, description: `A plugin tool. ${'It does a great deal. '.repeat(40)}` }))
    const reachable = [...tools, ...plugins]
    const { declared, named } = withinBudget(vm, reachable)
    expect(declare(vm, declared).length).toBeLessThanOrEqual(DECLARATION_BUDGET_TOKENS * 4)
    expect(named.length).toBeGreaterThan(0)
    expect([...declared, ...named].map(tool => tool.name).sort()).toEqual(reachable.map(tool => tool.name).sort())

    const description = codeRunDescription(vm, reachable)
    expect(description).toContain(`Also callable, declared by code_api or describeTool(name): ${named.map(tool => tool.name).join(', ')}.`)
    for (const tool of declared) expect(description).toContain(`  ${tool.name}(args:`)
    for (const tool of named) expect(description).not.toContain(`  ${tool.name}(args:`)
  })

  it('declares them all and names none while they fit, and says so when a script reaches no tool', () => {
    const few = tools.filter(tool => tool.name.startsWith('fs_'))
    const description = codeRunDescription(vm, few)
    for (const tool of few) expect(description).toContain(`  ${tool.name}(args:`)
    expect(description).not.toContain('Also callable')
    expect(codeRunDescription(vm, [])).toContain('No other tool is reachable from a script here.')
  })
})

describe('code_api and the code_run description on a node', () => {
  async function node() {
    const root = mkdtempSync(join(tmpdir(), 'buckle-code-api-'))
    roots.push(root)
    mkdirSync(join(root, 'workspace'))
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs,code' })
    return createRuntime({ config })
  }
  const api = async (runtime: Awaited<ReturnType<typeof node>>, args: Record<string, unknown>) => {
    const response = await runtime.invoke({ sessionId: 'chat-1', request: { requestId: `api-${Math.random()}`, tool: 'code_api', args: args as never, approvalTokens: [] } })
    if (response.outcome !== 'ok') throw new Error(JSON.stringify(response))
    return response.output as { declarations: string; unreachable?: string[] }
  }

  it('returns every reachable tool\'s declaration, or the named ones, and names those a script cannot reach', async () => {
    const runtime = await node()
    const all = await api(runtime, {})
    for (const name of ['fs_read', 'fs_write', 'fs_list']) expect(all.declarations).toContain(`  ${name}(args:`)
    expect(all.declarations).not.toContain('code_run')
    expect(all.unreachable).toBeUndefined()

    const named = await api(runtime, { tools: ['fs_read', 'not_a_tool', 'code_run'] })
    expect(named.declarations).toContain('  fs_read(args:')
    expect(named.declarations).not.toContain('fs_write')
    expect(named.unreachable).toEqual(['not_a_tool', 'code_run'])
    await runtime.history.close()
  })

  it('reads the tools again once the policy changes them: a denied tool is neither declared nor offered', async () => {
    const runtime = await node()
    expect(runtime.registry().get('code_run').capability.description).toContain('  fs_write(args:')
    await runtime.policy.apply({ ...emptyWorkspacePolicy(), tools: { deny: ['fs_write'] } })

    expect(runtime.registry().get('code_run').capability.description).not.toContain('  fs_write(args:')
    expect(runtime.manifest().tools.find(tool => tool.name === 'code_run')?.description).not.toContain('  fs_write(args:')
    const response = await runtime.invoke({ sessionId: 'chat-1', request: { requestId: 'denied', tool: 'code_run', args: { script: 'return ALL_TOOLS.map(tool => tool.name)' }, approvalTokens: [] } })
    expect(response).toMatchObject({ outcome: 'ok', output: { value: expect.not.arrayContaining(['fs_write']) } })
    expect((await api(runtime, {})).declarations).not.toContain('  fs_write(args:')
    await runtime.history.close()
  })
})
