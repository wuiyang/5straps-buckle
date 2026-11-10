import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonObject } from '@5straps/protocol'
import { runProcess } from '../common/adapters/process-runner.js'
import type { Program } from '../common/domain/executable.js'
import { hasExecutable } from './support/executable.js'
import type { Pack } from '../common/domain/pack.js'
import { createPathView } from '../common/domain/path-view.js'
import { forgeGitHost } from '../common/domain/forge.js'
import { createBrowserPack } from '../common/services/packs/browser/index.js'
import { discoverServers } from '../common/services/packs/dev/discovery.js'
import { spawnLspServer } from '../common/services/packs/dev/lsp-client.js'
import { createEnvironmentPack } from '../common/services/packs/environment/index.js'
import { createForgePack } from '../common/services/packs/forge/index.js'
import { searchContent } from '../common/services/packs/fs/search.js'
import { searchInput } from '../common/services/packs/fs/schemas.js'
import { createGitPack } from '../common/services/packs/git/index.js'
import type { ProcessRequest, ProcessResult } from '../common/types/ports/process-runner.js'

// A program a Windows shim starts can be a script Buckle's own Node runs, so the program carries the script as a
// leading argument (Program.args). Each spawn site puts those arguments before its own; one that dropped them would
// hand Node the call's first argument as its script.

const LEAD = ['/opt/tools/lead.js']
const program: Program = { path: '/opt/node/node', argv0: '/opt/node/node', args: LEAD }

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'buckle-program-arguments-'))
  roots.push(root)
  return root
}

function recorder(stdout: (request: ProcessRequest) => string = () => '') {
  const spawned: ProcessRequest[] = []
  const runProcess = async (request: ProcessRequest): Promise<ProcessResult> => {
    spawned.push(request)
    return { exitCode: 0, signal: null, stdout: stdout(request), stderr: '', truncated: false, timedOut: false }
  }
  return { spawned, runProcess }
}

function call(pack: Pack, name: string, args: JsonObject) {
  const tool = pack.tools.find(candidate => candidate.capability.name === name)
  if (!tool) throw new Error(`No such tool: ${name}`)
  return tool.prepare(args).execute({ requestId: 'r1', sessionId: 's1', timeoutMs: 5_000, signal: AbortSignal.timeout(5_000), authorizeRead: async () => true })
}

/** Every request spawned the program, its leading arguments first and the call's own after them. */
function expectLeading(spawned: ProcessRequest[], own: string[]): void {
  expect(spawned.length).toBeGreaterThan(0)
  for (const request of spawned) {
    expect(request.command).toBe(program.path)
    expect(request.args.slice(0, LEAD.length)).toEqual(LEAD)
  }
  expect(spawned.some(request => own.every((argument, index) => request.args[LEAD.length + index] === argument))).toBe(true)
}

describe('a program with leading arguments, at each spawn site', () => {
  it('the browser pack: a command, and the close at shutdown', async () => {
    const root = scratch()
    const { spawned, runProcess: recorded } = recorder(() => '{"success":true}')
    const pack = createBrowserPack({ cwd: root, paths: createPathView({ root, mount: null }), agentBrowserCommand: 'agent-browser', sessionDirectory: join(root, 'state'), headed: false, agentBrowser: program, approvedLists: [], runProcess: recorded })
    await call(pack, 'browser_command', { command: 'open', args: ['https://example.com'] })
    expectLeading(spawned, ['open', 'https://example.com/'])
    spawned.length = 0
    await pack.close?.()
    expectLeading(spawned, ['close', '--json', '--config'])
  })

  it('the dev pack\'s process list', async () => {
    const { spawned, runProcess: recorded } = recorder()
    await discoverServers({ runProcess: recorded, ps: program, environment: {}, timeoutMs: 5_000, signal: AbortSignal.timeout(5_000) })
    expectLeading(spawned, ['-eo', 'pid=,args='])
  })

  it('the environment validator', async () => {
    const { spawned, runProcess: recorded } = recorder()
    const pack = createEnvironmentPack({ command: '/opt/tools/varlock', validator: program, cwd: scratch(), runProcess: recorded, environment: () => ({}) })
    await call(pack, 'env_validate', {})
    expectLeading(spawned, ['load', '--agent'])
  })

  it('git, for the git pack', async () => {
    const root = scratch()
    const { spawned, runProcess: recorded } = recorder(request => request.args.includes('rev-parse') ? `${root}\n${root}/.git\n${root}/.git\n` : '')
    const pack = createGitPack({ paths: createPathView({ root, mount: null }), runProcess: recorded, stateDirectory: scratch(), git: program, environment: () => ({}) })
    await call(pack, 'git_status', {}).catch(() => {})
    expectLeading(spawned, ['rev-parse', '--path-format=absolute'])
  })

  // Run for real: the runner strips the leading arguments it was handed and runs the host's git with the rest.
  it.runIf(hasExecutable('git'))('git, for the forge pack', async () => {
    const root = scratch()
    execFileSync('git', ['init', '-b', 'main', root])
    writeFileSync(join(root, 'kept.txt'), 'kept\n')
    const spawned: ProcessRequest[] = []
    const apiUrl = 'https://api.github.com'
    const pack = createForgePack({
      paths: createPathView({ root, mount: null }), stateDirectory: scratch(), git: program,
      runProcess: request => { spawned.push(request); return runProcess({ ...request, command: 'git', argv0: 'git', args: request.args.slice(LEAD.length) }) },
      forge: { client: null, apiUrl, gitHost: forgeGitHost(new URL(apiUrl)), token: 'forge-token-fixture' },
      author: { name: 'test', email: 'test@example.com' }, approved: null, unavailableReason: null,
    })
    expect(await call(pack, 'git_commit', { message: 'add kept', paths: ['kept.txt'] })).toMatchObject({ subject: 'add kept', files: ['kept.txt'] })
    expectLeading(spawned, ['commit', '--message', 'add kept'])
  })

  it('ripgrep, for content search', async () => {
    const root = scratch()
    const { spawned, runProcess: recorded } = recorder()
    await searchContent({
      args: searchInput.parse({ pattern: 'needle' }), paths: createPathView({ root, mount: null }), runProcess: recorded, ripgrep: program,
      protectedRoots: [], timeoutMs: 5_000, signal: AbortSignal.timeout(5_000), authorizeRead: async () => true, environment: () => ({}),
    })
    expectLeading(spawned, ['--files', '--null'])
  })

  it('a language server, spawned for real: Node runs the script, which reads its own arguments', async () => {
    const root = scratch()
    const script = join(root, 'server.mjs')
    // Answers the first request with the arguments it was started with, its own path first.
    mkdirSync(root, { recursive: true })
    writeFileSync(script, [
      'process.stdin.once(\'data\', () => {',
      '  const body = JSON.stringify({ jsonrpc: \'2.0\', id: 1, result: process.argv.slice(1) })',
      '  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\\r\\n\\r\\n${body}`)',
      '})',
    ].join('\n'))
    const connection = spawnLspServer({ program: { path: process.execPath, argv0: process.execPath, args: [script] }, args: ['--stdio'], cwd: root, environment: process.env })
    try {
      expect(await connection.request('initialize', {}, 10_000)).toEqual([script, '--stdio'])
    } finally { connection.close() }
  })
})
