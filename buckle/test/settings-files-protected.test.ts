import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { emptyWorkspacePolicy, type InvokeResponse, type JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, protectedStateRoots } from '../common/runtime/config.js'
import { environmentFilesPath, recordEnvironmentFile, recordedEnvironmentFiles } from '../common/runtime/environment-files.js'
import { collectShellHiddenPaths } from '../common/services/shell/shell-filesystem.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { settleAuditLogs } from './support/action-log-writer.js'
import { runsNativeTerminal } from './support/native-terminal.js'
import { byName, registerWorkspace, workspacesOf } from './support/workspaces.js'

// The node's settings live in its state directory and in buckle.env, or the file BUCKLE_ENV_FILE names, which may lie
// outside it. With the log service on, a failed record no longer stops an owner
// command, so nothing but these protections stands between a tool and the settings. The env file joins the protected
// set, typed and real, on every route: the file tools, code mode, the browser, secret references, the history, the
// shell's sandbox, and a workbench terminal. No bwrap runs here: a fake one on PATH records the layout.

const ADMIN = 'decoy-admin-token-0123456789'
const SETTINGS = `BUCKLE_ADMIN_TOKEN=${ADMIN}\nBUCKLE_APPROVAL_FORMS=false\n`
const OWN_STATE = 'Buckle\'s own state'

const roots: string[] = []
const runtimes: CoreRuntime[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const runtime of runtimes.splice(0)) { runtime.closeWatchers(); await runtime.approvalService.close(); await runtime.history.close() }
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-settings-files-')))
  roots.push(root)
  return root
}

function writeSettings(file: string): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, SETTINGS, { mode: 0o600 })
}

interface Node { root: string; workspace: string; envFile: string; runtime: CoreRuntime; call: (tool: string, args: JsonObject) => Promise<InvokeResponse> }

/** A node whose env file `at` places, written unless `missing`, with `environment` over the defaults the rows share. */
async function node(input: { at: (root: string, workspace: string) => string; environment?: (root: string) => Record<string, string>; missing?: boolean }): Promise<Node> {
  const root = scratch()
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const envFile = input.at(root, workspace)
  if (input.missing) mkdirSync(dirname(envFile), { recursive: true })
  else writeSettings(envFile)
  const config = configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ENV_FILE: envFile, BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs',
    ...input.environment?.(root),
  })
  const runtime = await createRuntime({ config })
  runtimes.push(runtime)
  const call = (tool: string, args: JsonObject) => runtime.invoke({ sessionId: 'agent', request: { requestId: randomUUID(), tool, args, approvalTokens: [], context: { approvalWait: { mode: 'none' } } } })
  return { root, workspace, envFile, runtime, call }
}

function refusedAsState(response: InvokeResponse): void {
  expect(response, JSON.stringify(response)).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining(OWN_STATE) } })
}

/**
 * A bwrap on PATH that records the arguments of each run, one per line, and runs nothing; with `write`, it writes that
 * path below the first folder bound writable, as a command in the sandbox would.
 */
function fakeBwrap(root: string, write?: string): () => string[][] {
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const log = join(root, 'bwrap.args')
  const writes = write === undefined ? '' : `while [ $# -gt 0 ]; do if [ "$1" = --bind ]; then mkdir -p "$(dirname "$2/${write}")"; printf 'BUCKLE_APPROVAL_FORMS=true\\n' > "$2/${write}"; break; fi; shift; done\n`
  writeFileSync(join(bin, 'bwrap'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\nprintf '%s\\n' '--run-end--' >> '${log}'\n${writes}`)
  chmodSync(join(bin, 'bwrap'), 0o755)
  vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`)
  return () => existsSync(log) ? readFileSync(log, 'utf8').split('--run-end--\n').filter(Boolean).map(run => run.split('\n').filter(Boolean)) : []
}

/** Where a layout lays a file mask (/dev/null bound over it), and where a folder mask (a tmpfs). */
function masks(args: string[]): { files: string[]; folders: string[] } {
  return {
    files: args.flatMap((arg, index) => arg === '--ro-bind' && args[index + 1] === '/dev/null' ? [args[index + 2]!] : []),
    folders: args.flatMap((arg, index) => arg === '--tmpfs' ? [args[index + 1]!] : []),
  }
}

describe('the node\'s environment file in the protected set', () => {
  it('is the file BUCKLE_ENV_FILE names, protected as typed and where it really is', () => {
    const root = scratch()
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'link'))
    const typed = join(root, 'link', 'buckle.env')
    writeSettings(typed)
    const node = loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ENV_FILE: typed })
    expect(node.environmentFile).toBe(typed)
    expect(protectedStateRoots(node)).toEqual(expect.arrayContaining([typed, join(root, 'real', 'buckle.env')]))
  })

  it('is buckle.env in the state directory where BUCKLE_ENV_FILE names none', () => {
    const root = scratch()
    expect(loadConfig({ BUCKLE_STATE_DIR: join(root, 'state') }).environmentFile).toBe(join(root, 'state', 'buckle.env'))
  })
})

describe('an env file the state directory records, to a buckle mcp whose environment names none', () => {
  it('is refused read or changed, past always grants over the folder holding it', async () => {
    const root = scratch()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const state = join(root, 'state')
    const envFile = join(root, 'settings', 'buckle.env')
    writeSettings(envFile)
    // What init, a service install, or a serve start that named the file left for every other process.
    await recordEnvironmentFile({ stateDirectory: state, file: envFile })
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: state, BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' })
    expect(config.environmentFile).toBe(join(state, 'buckle.env'))
    const runtime = await createRuntime({ config })
    runtimes.push(runtime)
    const call = (tool: string, args: JsonObject) => runtime.invoke({ sessionId: 'agent', request: { requestId: randomUUID(), tool, args, approvalTokens: [], context: { approvalWait: { mode: 'none' } } } })
    for (const rule of ['read_scope', 'write_scope'] as const) await runtime.grants.grant({ sessionId: 'agent', rule, subject: join(root, 'settings'), scope: 'always' })
    refusedAsState(await call('fs_read', { path: envFile }))
    refusedAsState(await call('fs_write', { path: envFile, content: 'BUCKLE_APPROVAL_FORMS=true\n' }))
    expect(readFileSync(envFile, 'utf8')).toBe(SETTINGS)
  })

  it('keeps each file once, and none inside the state directory, which is protected whole', async () => {
    const root = scratch()
    const state = join(root, 'state')
    for (const file of [join(root, 'a.env'), join(root, 'b.env'), join(root, 'a.env'), join(state, 'buckle.env'), join(state, 'other.env')]) await recordEnvironmentFile({ stateDirectory: state, file })
    expect(recordedEnvironmentFiles(state)).toEqual([join(root, 'a.env'), join(root, 'b.env')])
    expect(loadConfig({ BUCKLE_STATE_DIR: state }).recordedEnvironmentFiles).toEqual([join(root, 'a.env'), join(root, 'b.env')])
    if (process.platform !== 'win32') expect(statSync(environmentFilesPath(state)).mode & 0o777).toBe(0o600)
  })

  it('refuses to load the node\'s config while the record will not read, naming it', () => {
    const root = scratch()
    const state = join(root, 'state')
    mkdirSync(state)
    writeFileSync(environmentFilesPath(state), '{ not json')
    expect(() => loadConfig({ BUCKLE_STATE_DIR: state })).toThrow(`${environmentFilesPath(state)} is not a record of environment files Buckle reads`)
  })
})

describe('an env file outside the state directory, to the file tools', () => {
  it('is refused read or changed, past always grants over the folder holding it, and stays as it was', async () => {
    const { root, envFile, runtime, call } = await node({ at: root => join(root, 'settings', 'buckle.env') })
    const folder = join(root, 'settings')
    const beside = join(folder, 'other.txt')
    await runtime.grants.grant({ sessionId: 'agent', rule: 'write_scope', subject: folder, scope: 'always' })
    await runtime.grants.grant({ sessionId: 'agent', rule: 'read_scope', subject: folder, scope: 'always' })
    // The grants open an ordinary file beside it, so each refusal below is the env file's own.
    expect(await call('fs_write', { path: beside, content: 'beside' })).toMatchObject({ outcome: 'ok' })
    expect(await call('fs_read', { path: beside })).toMatchObject({ outcome: 'ok' })
    for (const [tool, args] of [
      ['fs_read', { path: envFile }],
      ['fs_read_batch', { paths: [envFile] }],
      ['fs_write', { path: envFile, content: 'BUCKLE_APPROVAL_FORMS=true\n' }],
      ['fs_write_batch', { files: [{ path: envFile, content: 'BUCKLE_APPROVAL_FORMS=true\n' }] }],
      ['fs_patch', { path: envFile, edits: [{ oldText: 'BUCKLE_APPROVAL_FORMS=false', newText: 'BUCKLE_APPROVAL_FORMS=true' }] }],
      ['fs_delete', { paths: [envFile] }],
      ['fs_delete', { paths: [folder], recursive: true }],
      ['fs_move', { from: envFile, to: join(folder, 'moved.env') }],
      ['fs_move', { from: beside, to: envFile, replace: true }],
    ] as Array<[string, JsonObject]>) refusedAsState(await call(tool, args))
    expect(readFileSync(envFile, 'utf8')).toBe(SETTINGS)
  })
})

describe('an env file inside the workspace', () => {
  const inside = (_root: string, workspace: string) => join(workspace, 'config', 'buckle.env')

  it('is refused to the file tools, which read the workspace freely, and a search never shows a line of it', async () => {
    const { workspace, envFile, call } = await node({ at: inside })
    writeFileSync(join(workspace, 'notes.txt'), 'BUCKLE_ADMIN_TOKEN appears here too\n')
    expect(await call('fs_read', { path: 'notes.txt' })).toMatchObject({ outcome: 'ok' })
    refusedAsState(await call('fs_read', { path: 'config/buckle.env' }))
    refusedAsState(await call('fs_delete', { paths: ['config'], recursive: true }))
    const found = await call('fs_search_content', { path: '.', pattern: 'BUCKLE_ADMIN_TOKEN' })
    expect(found).toMatchObject({ outcome: 'ok' })
    expect(JSON.stringify(found)).toContain('notes.txt')
    expect(JSON.stringify(found)).not.toContain(ADMIN)
    expect(JSON.stringify(found)).not.toContain('buckle.env')
    expect(readFileSync(envFile, 'utf8')).toBe(SETTINGS)
  })

  it('is refused to a code mode script\'s calls', async () => {
    const { call } = await node({ at: inside, environment: () => ({ BUCKLE_PACKS: 'fs,code' }) })
    const response = await call('code_run', { script: 'try { return (await tools.fs_read({ path: "config/buckle.env" })).content } catch (error) { return error.code }' })
    expect(response, JSON.stringify(response)).toMatchObject({ outcome: 'ok', output: { value: 'PERMISSION_DENIED' } })
    expect(JSON.stringify(response)).not.toContain(ADMIN)
  })

  it('is refused as a secret reference\'s file, so no value of it fills a call', async () => {
    const { call } = await node({ at: inside, environment: () => ({ BUCKLE_PACKS: 'fs,web', BUCKLE_NETWORK_ALLOW: 'example.com' }) })
    refusedAsState(await call('web_fetch', { url: 'https://example.com/', headers: { Authorization: '{{file:config/buckle.env:BUCKLE_ADMIN_TOKEN}}' } }))
  })

  it('is refused to a browser upload before agent-browser runs', async () => {
    const browserLog = (root: string) => join(root, 'agent-browser.calls')
    const { root, call } = await node({
      at: inside,
      environment: (root) => {
        const binary = join(root, 'agent-browser')
        writeFileSync(binary, `#!/bin/sh\necho "$*" >> '${browserLog(root)}'\necho '{"success":true,"data":{}}'\n`)
        chmodSync(binary, 0o755)
        return { BUCKLE_PACKS: 'fs,browser', BUCKLE_AGENT_BROWSER_COMMAND: binary }
      },
    })
    refusedAsState(await call('browser_command', { command: 'upload', args: ['#file', 'config/buckle.env'] }))
    expect(existsSync(browserLog(root))).toBe(false)
  })

  it('keeps no version in the change history, so no restore puts one back', async () => {
    const { workspace, envFile, runtime, call } = await node({
      at: inside,
      environment: () => ({ BUCKLE_PACKS: 'fs,shell', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SANDBOX: 'none', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_ALLOW_HOST_GIT: 'true' }),
    })
    const policy = emptyWorkspacePolicy()
    policy.commands.allow = ['sh -c *']
    await runtime.policy.apply(policy)
    await runtime.grants.grant({ sessionId: 'agent', rule: 'write_scope', subject: workspace, scope: 'session' })
    // An unsandboxed shell reaches the file (the stated limit); the history still keeps none of it.
    const ran = await call('shell_exec', { command: 'sh', args: ['-c', 'printf "BUCKLE_APPROVAL_FORMS=true\\n" > config/buckle.env; printf x > other.txt'], cwd: '.' })
    expect(ran, JSON.stringify(ran)).toMatchObject({ outcome: 'ok' })
    const [newest] = (await runtime.history.recent(1)).checkpoints
    expect(newest!.changes.map(change => change.path)).toEqual([join(workspace, 'other.txt')])
    await runtime.history.rollback({ target: { steps: 1 }, by: { sessionId: 'agent', stageId: 'undo', tool: 'history_restore', requestId: 'undo' } })
    expect(existsSync(join(workspace, 'other.txt'))).toBe(false)
    expect(readFileSync(envFile, 'utf8')).toBe('BUCKLE_APPROVAL_FORMS=true\n')
  })
})

describe('the shell\'s hidden paths', () => {
  it('mask a protected file as a file and a protected folder as a folder', async () => {
    const root = scratch()
    const file = join(root, 'settings', 'buckle.env')
    writeSettings(file)
    const folder = join(root, 'state')
    mkdirSync(folder)
    const hidden = await collectShellHiddenPaths({ roots: [], protectedPaths: [file, folder], signal: new AbortController().signal })
    expect(hidden).toEqual({ directories: [folder], files: [file], missingFiles: [] })
  })

  it('keep a settings file not made yet apart, to mask as no folder, and any other missing path a folder', async () => {
    const root = scratch()
    const [unmade, other] = [join(root, 'settings', 'buckle.env'), join(root, 'gone')]
    const hidden = await collectShellHiddenPaths({ roots: [], protectedPaths: [unmade, other], settingsFiles: [unmade], signal: new AbortController().signal })
    expect(hidden).toEqual({ directories: [other], files: [], missingFiles: [unmade] })
  })
})

describe('a sandboxed shell command and an env file outside the state directory', () => {
  async function sandboxed(input: { at: (root: string, workspace: string) => string; environment?: (root: string) => Record<string, string>; missing?: boolean; write?: string }) {
    let recorded: () => string[][] = () => []
    const made = await node({
      at: input.at,
      ...(input.missing ? { missing: true } : {}),
      environment: (root) => {
        recorded = fakeBwrap(root, input.write)
        return { BUCKLE_PACKS: 'fs,shell', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SANDBOX: 'bubblewrap', BUCKLE_SHELL_ISOLATION: 'false', ...input.environment?.(root) }
      },
    })
    const policy = emptyWorkspacePolicy()
    policy.commands.allow = ['sh -c *', 'buckle *']
    await made.runtime.policy.apply(policy)
    await made.runtime.grants.grant({ sessionId: 'agent', rule: 'write_scope', subject: made.workspace, scope: 'session' })
    // The command scan is a speed bump: a quoted subcommand word passes it once a shell wrapper is allowed.
    const response = await made.call('shell_exec', { command: 'sh', args: ['-c', `BUCKLE_ENV_FILE=${made.envFile} buckle 'settings' set approval-forms on`], cwd: '.' })
    return { ...made, response, runs: recorded() }
  }

  it.each([
    ['inside a scratch root, bound writable at its own path', (root: string) => join(root, 'scratch', 'buckle.env'), (root: string) => ({ BUCKLE_SCRATCH_ROOTS: join(root, 'scratch') }), (envFile: string) => [envFile]],
    ['inside a toolchain folder, bound read-only at its own path', (root: string) => join(root, 'tools', 'buckle.env'), (root: string) => ({ BUCKLE_MOUNT_READ_ONLY: join(root, 'tools') }), (envFile: string) => [envFile]],
  ])('runs with the file masked as a file where it shows, %s', async (_where, at, environment, shown) => {
    const { envFile, response, runs } = await sandboxed({ at, environment })
    expect(response, JSON.stringify(response)).toMatchObject({ outcome: 'ok' })
    expect(runs).toHaveLength(1)
    const laid = masks(runs[0]!)
    expect(laid.files).toEqual(expect.arrayContaining(shown(envFile)))
    expect(laid.folders).not.toContain(envFile)
  })

  it('runs with the file inside the workspace masked where the workspace shows it, never under a folder mask', async () => {
    const { response, runs } = await sandboxed({ at: (_root, workspace) => join(workspace, 'config', 'buckle.env') })
    expect(response, JSON.stringify(response)).toMatchObject({ outcome: 'ok' })
    const laid = masks(runs[0]!)
    expect(laid.files.some(path => path.endsWith('/config/buckle.env'))).toBe(true)
    expect(laid.folders.some(path => path.endsWith('/config/buckle.env'))).toBe(false)
  })

  it('binds nothing that holds the file where it lies outside every folder the sandbox binds', async () => {
    const { root, envFile, response, runs } = await sandboxed({ at: root => join(root, 'settings', 'buckle.env') })
    expect(response, JSON.stringify(response)).toMatchObject({ outcome: 'ok' })
    const args = runs[0]!
    const bound = args.flatMap((arg, index) => ['--bind', '--ro-bind', '--ro-bind-try'].includes(arg) ? [args[index + 1]!] : [])
    expect(bound.filter(source => source !== '/dev/null' && (envFile.startsWith(`${source}/`) || source === envFile))).toEqual([])
    expect(bound).not.toContain(join(root, 'settings'))
  })

  it('refuses an isolated call where a scratch root outside the folder holds the file, as it refuses one holding the state directory', async () => {
    const at = (root: string) => join(root, 'scratch', 'buckle.env')
    const { response, runs } = await sandboxed({ at, environment: root => ({ BUCKLE_SCRATCH_ROOTS: join(root, 'scratch'), BUCKLE_SHELL_ISOLATION: 'true' }) })
    expect(response, JSON.stringify(response)).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Buckle\'s protected state') } })
    expect(runs).toEqual([])
  })

  // The default: an isolated call runs in a copy of the folder, where no mask is laid over the file inside it. The copy
  // leaves the file out, and its publish refuses a change at it. The fake bwrap writes it in the copy as a command would.
  it.each([
    ['there', false],
    ['not made yet', true],
  ])('keeps an env file inside the workspace, %s, out of an isolated call\'s copy, and refuses the publish of a change that makes it there', async (_state, missing) => {
    const { runtime, envFile, response, runs } = await sandboxed({ at: (_root, workspace) => join(workspace, 'config', 'buckle.env'), environment: () => ({ BUCKLE_SHELL_ISOLATION: 'true' }), missing, write: 'config/buckle.env' })
    expect(runs).toHaveLength(1)
    expect(response, JSON.stringify(response)).toMatchObject({ outcome: 'error', error: { message: expect.stringContaining('need owner review') } })
    expect(runtime.shellWorkspaces.list().map(kept => [kept.status, kept.excluded.includes(envFile)])).toEqual([['needs_review', true]])
    expect(missing ? existsSync(envFile) : readFileSync(envFile, 'utf8')).toBe(missing ? false : SETTINGS)
  })

  it('refuses a call, running nothing, where the env file, not made yet, lies inside a folder the command writes, since a mask would make it', async () => {
    const { envFile, response, runs } = await sandboxed({ at: (_root, workspace) => join(workspace, 'config', 'buckle.env'), missing: true })
    expect(response, JSON.stringify(response)).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('not made yet inside a folder this command writes') } })
    expect(runs).toEqual([])
    expect(existsSync(envFile)).toBe(false)
  })

  it('runs where the env file, not made yet, lies only inside a folder bound read-only, laying no mask there', async () => {
    const { envFile, response, runs } = await sandboxed({ at: root => join(root, 'tools', 'buckle.env'), environment: root => ({ BUCKLE_MOUNT_READ_ONLY: join(root, 'tools') }), missing: true })
    expect(response, JSON.stringify(response)).toMatchObject({ outcome: 'ok' })
    const laid = masks(runs[0]!)
    expect([...laid.files, ...laid.folders]).not.toContain(envFile)
  })
})

describe.runIf(runsNativeTerminal)('a workbench terminal', () => {
  /** The layout of a terminal on a node whose toolchain folder `tools` the sandbox binds at its own path. */
  async function terminalMasks(input: { envFile: (tools: string) => string; stateDirectory: (root: string) => string }) {
    const root = scratch()
    const folder = join(root, 'site')
    const tools = join(root, 'tools')
    mkdirSync(folder)
    mkdirSync(tools)
    const envFile = input.envFile(tools)
    writeSettings(envFile)
    const recorded = fakeBwrap(root)
    const manager = await workspacesOf(loadConfig({ BUCKLE_STATE_DIR: input.stateDirectory(root), BUCKLE_ENV_FILE: envFile, BUCKLE_SANDBOX: 'bubblewrap', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_MOUNT_READ_ONLY: tools }))
    try {
      await registerWorkspace(manager, { id: 'site', dir: folder })
      const { runtime } = await byName(manager, 'site')
      const grant = { id: randomUUID(), token: 'workbench-fixture-token-with-enough-bytes', projectId: 'project-a', chatId: 'chat-a', allowShell: true }
      await runtime.workbenches.provision(grant)
      await runtime.workbenches.startTerminal(grant.id, { actorId: 'alice', cwd: '.', cols: 80, rows: 24 })
      await vi.waitFor(() => expect(recorded()).toHaveLength(1))
      return { root, tools, envFile, laid: masks(recorded()[0]!) }
    } finally { await manager.close() }
  }

  it('masks an env file outside the state directory as a file where a toolchain folder shows it', async () => {
    const { envFile, laid } = await terminalMasks({ envFile: tools => join(tools, 'buckle.env'), stateDirectory: root => join(root, 'state') })
    expect(laid.files).toContain(envFile)
    expect(laid.folders).not.toContain(envFile)
  })

  it('masks the state directory that holds its copy where a toolchain folder shows it, and still works in the copy', async () => {
    const { tools, laid } = await terminalMasks({ envFile: tools => join(tools, 'state', 'buckle.env'), stateDirectory: root => join(root, 'tools', 'state') })
    expect(laid.folders).toContain(join(tools, 'state'))
    expect(laid.folders).not.toContain('/workspace')
  })
})
