import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonObject } from '@5straps/protocol'
import { createNoneSandbox } from '../common/adapters/sandbox/none-sandbox.js'
import { findExecutable, resolveProgram, runnableCommand, type ExecutableLookup } from '../common/domain/executable.js'
import type { Pack } from '../common/domain/pack.js'
import { createPathView } from '../common/domain/path-view.js'
import { BROWSER_UNTRUSTED } from '../common/services/packs/browser/index.js'
import { createBuiltinPacks } from '../common/services/packs/index.js'
import type { ProcessRequest } from '../common/types/ports/process-runner.js'

// On Windows a program spawned by its bare name is looked for in the child's working directory before PATH, so an
// `rg.exe` the agent writes into the workspace would run with Buckle's rights. Buckle resolves each program once and
// spawns it by that path. These tests put a lookup in PATH's place and imitate Windows through the platform it takes.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'buckle-windows-programs-'))
  roots.push(root)
  return root
}

/** A lookup that answers from a table, as findExecutable would from PATH, and records the platform it was asked for. */
function lookupFrom(table: Record<string, string>): ExecutableLookup & { platforms: NodeJS.Platform[] } {
  const platforms: NodeJS.Platform[] = []
  return Object.assign((name: string, _environment: NodeJS.ProcessEnv, platform: NodeJS.Platform) => { platforms.push(platform); return table[name] ?? null }, { platforms })
}

describe('a program resolved on Windows, imitated', () => {
  const untrustedRoots = ['C:/ws', 'D:/scratch']

  it('is spawned by the absolute path PATH gives, in pathe\'s form', () => {
    const lookup = lookupFrom({ rg: 'C:\\Tools\\rg.exe' })
    expect(resolveProgram('rg', { untrustedRoots, lookup, platform: 'win32' })).toEqual({ path: 'C:/Tools/rg.exe' })
    expect(lookup.platforms).toEqual(['win32'])
  })

  it('is refused where the agent writes: the workspace, a scratch root, or a case variant of either', () => {
    for (const found of ['C:\\ws\\rg.exe', 'c:\\WS\\bin\\rg.exe', 'D:\\Scratch\\rg.exe']) {
      expect(resolveProgram('rg', { untrustedRoots, lookup: lookupFrom({ rg: found }), platform: 'win32' })).toEqual({ path: null, reason: 'rg is found inside the workspace or a scratch root, where an agent can write, so Buckle does not run it', untrusted: true })
    }
  })

  it('is not run when PATH has none, or names it by a relative path', () => {
    expect(resolveProgram('rg', { untrustedRoots, lookup: lookupFrom({}), platform: 'win32' })).toMatchObject({ path: null, reason: 'rg is not installed on this node', untrusted: false })
    expect(resolveProgram('tools\\rg.exe', { untrustedRoots, lookup: lookupFrom({ 'tools\\rg.exe': 'tools\\rg.exe' }), platform: 'win32' })).toMatchObject({ path: null, untrusted: false })
  })

  it('reads PATH with Windows\' separator and searches only its absolute entries', () => {
    const root = scratch()
    writeFileSync(join(root, 'tool.exe'), '')
    chmodSync(join(root, 'tool.exe'), 0o755)
    expect(findExecutable('tool', { PATH: `bin;${root}` }, 'win32')).toBe(join(root, 'tool.exe'))
    expect(findExecutable('tool', { PATH: 'bin' }, 'win32')).toBeNull()
  })

  it('leaves a command word the agent wrote as a path as written, and resolves a bare one', () => {
    const lookup = lookupFrom({ git: 'C:\\Program Files\\Git\\cmd\\git.exe', node: 'C:\\ws\\node.exe' })
    expect(runnableCommand('git', { untrustedRoots, lookup, platform: 'win32' })).toBe('C:/Program Files/Git/cmd/git.exe')
    expect(runnableCommand('.\\tools\\git.exe', { untrustedRoots, lookup, platform: 'win32' })).toBe('.\\tools\\git.exe')
    expect(() => runnableCommand('node', { untrustedRoots, lookup, platform: 'win32' })).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }))
  })
})

/** The built-in packs over a real workspace, with programs looked up in `table` as Windows would, and every spawn recorded. */
function builtins(input: { table: (root: string) => Record<string, string> }) {
  const root = scratch()
  const state = scratch()
  const spawned: ProcessRequest[] = []
  const packs = createBuiltinPacks({
    allowHostGit: true,
    allowHostLsp: true,
    cwd: root,
    paths: createPathView({ root, mount: null }),
    hiddenPaths: [state],
    mountReadOnlyPaths: [],
    approvedUrls: null,
    approvedLists: [],
    runProcess: async request => { spawned.push(request); return { exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false } },
    sandbox: createNoneSandbox(),
    writableRoots: [root],
    allowedHosts: [],
    forge: { apiUrl: 'https://api.github.com', author: { name: 'test', email: 'test@example.com' } },
    stateDirectory: state,
    agentBrowserCommand: 'agent-browser',
    browserStateDirectory: join(state, 'browser'),
    browserHeaded: false,
    enableShell: true,
    sandboxUnavailableReason: null,
    programSearch: { lookup: lookupFrom(input.table(root)), platform: 'win32' },
  })
  const pack = (id: string): Pack => packs.find(candidate => candidate.id === id)!
  const call = (id: string, name: string, args: JsonObject) => {
    const tool = pack(id).tools.find(candidate => candidate.capability.name === name)
    if (!tool) throw new Error(`No such tool: ${name}`)
    return tool.prepare(args).execute({ requestId: 'r1', sessionId: 's1', timeoutMs: 5_000, signal: AbortSignal.timeout(5_000), authorizeRead: async () => true })
  }
  return { root, pack, call, spawned }
}

const TRUSTED = { 'rg': '/opt/tools/rg.exe', 'git': '/opt/tools/git.exe', 'ps': '/opt/tools/ps.exe', 'agent-browser': '/opt/tools/agent-browser.exe' }

describe('the packs on Windows, imitated, with every program on PATH outside the workspace', () => {
  it('spawn rg, git, ps, and the unsandboxed shell\'s command word by the path PATH gave', async () => {
    const { call, spawned, pack } = builtins({ table: () => TRUSTED })
    await call('fs', 'fs_search_content', { pattern: 'x' })
    await call('git', 'git_status', {})
    await call('dev', 'lsp_discover', {})
    await call('shell', 'shell_exec', { command: 'git', args: ['status'] })
    expect([...new Set(spawned.map(request => request.command))].sort()).toEqual(['/opt/tools/git.exe', '/opt/tools/ps.exe', '/opt/tools/rg.exe'])
    expect(pack('browser').unavailableReason).toBeNull()
    expect(pack('git').unavailableReason).toBeNull()
  })
})

describe('the packs on Windows, imitated, with programs planted in the workspace', () => {
  it('withhold search, git, and the browser, and refuse the language server, ps, and the shell\'s command word', async () => {
    const planted = (root: string) => Object.fromEntries(['rg', 'git', 'ps', 'agent-browser', 'typescript-language-server', 'node'].map(name => [name, `${root}\\bin\\${name}.exe`]))
    const { root, call, spawned, pack } = builtins({ table: planted })
    mkdirSync(join(root, 'bin'))
    expect(pack('fs').tools.map(tool => tool.capability.name)).not.toContain('fs_search_content')
    expect(pack('git').unavailableReason).toBe('git is found inside the workspace or a scratch root, where an agent can write, so Buckle does not run it')
    expect(pack('forge').unavailableReason).toMatch(/BUCKLE_FORGE_GITHUB_TOKEN/)
    expect(pack('browser').unavailableReason).toBe(BROWSER_UNTRUSTED)
    writeFileSync(join(root, 'a.ts'), 'export const a = 1\n')
    await expect(call('dev', 'lsp_hover', { path: 'a.ts', language: 'typescript', line: 1 })).rejects.toThrow('typescript-language-server is found inside the workspace')
    await expect(call('dev', 'lsp_discover', {})).rejects.toThrow('ps is found inside the workspace')
    await expect(call('shell', 'shell_exec', { command: 'node', args: ['-e', '1'] })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(spawned).toEqual([])
  })
})
