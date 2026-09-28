import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy, type ActionReport, type PermissionRuleId, type WorkspacePolicy } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { policyCommand } from '../cli/policy.js'
import type { ToolEffect } from '../common/domain/effect.js'
import { dangerousUses, isDangerouslyAllowed, redactedSubject } from '../common/domain/permission/rules/dangerously-allow.js'
import { loadConfig } from '../common/runtime/config.js'
import type { WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { Reporter } from '../common/types/ports/reporter.js'

// B20, rulings 11 and H1 of 2026-09-28: one local switch per workspace turns every ask into an allow,
// sensitive files and file writes included; denies, the node's own switch over a registered
// workspace and the mount boundary still refuse, and every use is audited.

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

interface Node { root: string; workspace: string; runtime: BuckleRuntime; reports: ActionReport[] }

async function node(input: { nodeDangerouslyAllowed?: () => boolean } = {}): Promise<Node> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-dangerously-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, 'private'), { recursive: true })
  mkdirSync(join(root, 'outside'))
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  writeFileSync(join(workspace, '.env'), 'FIXTURE=synthetic\n')
  const config = loadConfig({
    BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false',
    BUCKLE_PACKS: 'fs,shell,web', BUCKLE_APPROVAL_TIMEOUT_MS: '1',
  })
  const reports: ActionReport[] = []
  const reporter: Reporter = { configured: true, record: entry => { reports.push(entry) }, report: async () => {}, flush: async () => {} }
  const runtime = await createRuntime({ config, reporter, ...(input.nodeDangerouslyAllowed ? { nodeDangerouslyAllowed: input.nodeDangerouslyAllowed } : {}) })
  return { root, workspace, runtime, reports }
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

function policy(change: (value: WorkspacePolicy) => void): WorkspacePolicy {
  const value = emptyWorkspacePolicy()
  change(value)
  return value
}

function uses(runtime: BuckleRuntime, requestId: string) {
  return runtime.actions.read(200).filter(entry => entry.tool === 'policy_dangerously_allowed' && entry.requestId === requestId)
}

/** Every ask kind the permission engine raises, from the tool that raises it (plan section C; H1). */
function coverage(node: Node): Array<{ kind: string; tool: string; effects: ToolEffect[]; rule: PermissionRuleId }> {
  const { workspace, root } = node
  return [
    { kind: 'a destructive command', tool: 'shell_exec', effects: [{ kind: 'exec', command: 'rm', args: ['-rf', 'build'] }], rule: 'destructive_command' },
    { kind: 'the working-directory write of a shell command', tool: 'shell_exec', effects: [{ kind: 'exec', command: 'ls', args: [] }, { kind: 'write_path', path: workspace }], rule: 'write_scope' },
    { kind: 'the working-directory write of a script', tool: 'script_run', effects: [{ kind: 'exec', command: 'node', args: ['script.mjs'] }, { kind: 'write_path', path: workspace }], rule: 'write_scope' },
    { kind: 'a read outside the workspace', tool: 'fs_read', effects: [{ kind: 'read_path', path: join(root, 'outside', 'notes.md') }], rule: 'read_scope' },
    { kind: 'a read the filesystem policy asks about', tool: 'fs_read', effects: [{ kind: 'read_path', path: join(workspace, 'private', 'notes.md') }], rule: 'filesystem_policy' },
    { kind: 'a sensitive file', tool: 'fs_read', effects: [{ kind: 'read_path', path: join(workspace, '.env') }], rule: 'sensitive_path' },
    { kind: 'fs_write', tool: 'fs_write', effects: [{ kind: 'write_path', path: join(workspace, 'note.md') }], rule: 'write_scope' },
    { kind: 'fs_patch', tool: 'fs_patch', effects: [{ kind: 'write_path', path: join(workspace, 'note.md') }], rule: 'write_scope' },
    { kind: 'a batch write', tool: 'fs_write_batch', effects: [{ kind: 'write_path', path: join(workspace, 'a.md') }, { kind: 'write_path', path: join(root, 'outside', 'b.md') }], rule: 'write_scope' },
    { kind: 'a private network address', tool: 'web_fetch', effects: [{ kind: 'network', url: 'http://127.0.0.1:9/probe' }], rule: 'network_egress' },
    // lsp_discover's effect; the dev pack needs a host language-server setup this test does not have.
    { kind: 'a process listing', tool: 'fs_list', effects: [{ kind: 'process_probe' }], rule: 'process_probe' },
  ]
}

const privateAsks = policy(value => { value.filesystem = { rules: [{ path: 'private', read: 'ask' }] } })

describe('the dangerously-allow switch over every ask kind (coverage table)', () => {
  it('asks for each kind while off, and allows each while on, audited per use', async () => {
    const setup = await node()
    const { runtime } = setup
    await runtime.policy.apply(privateAsks)
    for (const row of coverage(setup)) {
      const off = await call(runtime, row.tool, row.effects)
      expect({ kind: row.kind, outcome: off.result.outcome }).toEqual({ kind: row.kind, outcome: 'approval_required' })
      expect(off.result.outcome === 'approval_required' && off.result.approvals.map(approval => approval.rule)).toContain(row.rule)
      expect(off.execute).not.toHaveBeenCalled()
    }

    await policyCommand(runtime, ['dangerously-allow', 'on'], {} as WorkspaceManager)
    for (const row of coverage(setup)) {
      const on = await call(runtime, row.tool, row.effects)
      expect({ kind: row.kind, outcome: on.result.outcome }).toEqual({ kind: row.kind, outcome: 'ok' })
      expect(on.execute).toHaveBeenCalledOnce()
      expect(uses(runtime, on.requestId).map(entry => entry.detail)).toContain(row.rule)
      const result = runtime.actions.read(200).find(entry => entry.event === 'result' && entry.requestId === on.requestId && entry.tool === row.tool)
      expect(result?.approvedBy).toContain('dangerously_allow')
    }
  })
})

describe('what the switch never turns (policy.md: a matched deny stays denied)', () => {
  it.each([
    ['an owner command deny rule', 'shell_exec', (setup: Node): ToolEffect[] => [{ kind: 'exec', command: 'rm', args: ['-rf', 'build'] }], policy(value => { value.commands.deny = ['rm *'] })],
    ['a filesystem deny rule', 'fs_read', (setup: Node): ToolEffect[] => [{ kind: 'read_path', path: join(setup.workspace, 'private', 'notes.md') }], policy(value => { value.filesystem = { rules: [{ path: 'private', read: 'deny' }] } })],
    ['the tool policy', 'fs_write', (setup: Node): ToolEffect[] => [{ kind: 'write_path', path: join(setup.workspace, 'note.md') }], policy(value => { value.tools = { deny: ['fs_write'] } })],
    ['the mount boundary', 'fs_read', (setup: Node): ToolEffect[] => [{ kind: 'read_path', path: join(setup.root, 'outside', 'notes.md') }], policy(value => { value.mount = '/workspace' })],
    ['Buckle\'s own state', 'fs_read', (setup: Node): ToolEffect[] => [{ kind: 'read_path', path: join(setup.root, 'state', 'policy.json') }], emptyWorkspacePolicy()],
  ])('keeps %s refusing', async (_, tool, effects, stored) => {
    const setup = await node()
    await setup.runtime.policy.apply(stored)
    await setup.runtime.policy.setDangerouslyAllow(true)
    const { result, execute } = await call(setup.runtime, tool, effects(setup))
    expect(result).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
    expect(execute).not.toHaveBeenCalled()
    expect(runtimeUses(setup.runtime)).toEqual([])
  })
})

function runtimeUses(runtime: BuckleRuntime) {
  return runtime.actions.read(200).filter(entry => entry.tool === 'policy_dangerously_allowed')
}

describe('a registered workspace under the node\'s own switch (the ceiling)', () => {
  it.each([[false, 'approval_required'], [true, 'ok']] as const)('takes effect only while the node\'s switch is on too (node on: %s)', async (nodeOn, outcome) => {
    const setup = await node({ nodeDangerouslyAllowed: () => nodeOn })
    await setup.runtime.policy.setDangerouslyAllow(true)
    expect(setup.runtime.policy.dangerouslyAllow()).toEqual({ on: true, allowedByNode: nodeOn, effective: nodeOn })
    const { result } = await call(setup.runtime, 'fs_write', [{ kind: 'write_path', path: join(setup.workspace, 'note.md') }])
    expect(result.outcome).toBe(outcome)
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

  it('records the switch itself, on and off, and applies off at once without a restart', async () => {
    const setup = await node()
    const { runtime } = setup
    await policyCommand(runtime, ['dangerously-allow', 'on'], {} as WorkspaceManager)
    expect((await call(runtime, 'fs_write', [{ kind: 'write_path', path: join(setup.workspace, 'note.md') }])).result.outcome).toBe('ok')
    await policyCommand(runtime, ['dangerously-allow', 'off'], {} as WorkspaceManager)
    expect((await call(runtime, 'fs_write', [{ kind: 'write_path', path: join(setup.workspace, 'note.md') }])).result.outcome).toBe('approval_required')
    const changes = runtime.actions.read(200).filter(entry => entry.tool === 'policy_dangerously_allow_changed' && entry.event === 'result')
    expect(changes.map(entry => entry.detail)).toEqual(['on', 'off'])
  })

  it('shows the switch in buckle policy show', async () => {
    const setup = await node()
    let printed = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { printed += String(chunk); return true })
    await policyCommand(setup.runtime, ['dangerously-allow', 'on'], {} as WorkspaceManager)
    expect(printed).toContain('WARNING: dangerously allow is on')
    printed = ''
    await policyCommand(setup.runtime, ['show'], {} as WorkspaceManager)
    expect(printed).toContain('Dangerously allow  ON')
    printed = ''
    await policyCommand(setup.runtime, ['show', '--json'], {} as WorkspaceManager)
    expect(JSON.parse(printed)).toMatchObject({ dangerouslyAllow: { on: true, allowedByNode: null, effective: true }, stored: { dangerouslyAllow: { commands: true, fileReads: true } } })
  })
})

describe('only the switch changes the switch (ruling H1e)', () => {
  it('keeps the stored switch through other policy writes and a clear, and refuses a write that asks for another value', async () => {
    const setup = await node()
    const { runtime } = setup
    await runtime.policy.setDangerouslyAllow(true)
    await runtime.policy.apply(policy(value => { value.network.allow = ['example.com'] }))
    expect(runtime.policy.dangerouslyAllow().on).toBe(true)
    await runtime.policy.clear()
    expect(runtime.policy.dangerouslyAllow().on).toBe(true)
    await expect(runtime.policy.apply({ ...emptyWorkspacePolicy(), dangerouslyAllow: { commands: false, fileReads: false } })).rejects.toMatchObject({ status: 409, code: 'POLICY_DANGEROUSLY_ALLOW_LOCAL_ONLY' })
    await runtime.policy.setDangerouslyAllow(false)
    await expect(runtime.policy.apply({ ...emptyWorkspacePolicy(), dangerouslyAllow: { commands: true, fileReads: true } })).rejects.toMatchObject({ status: 409 })
    expect(runtime.policy.dangerouslyAllow().on).toBe(false)
  })

  it('refuses usage other than on or off', async () => {
    const setup = await node()
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect((await policyCommand(setup.runtime, ['dangerously-allow'], {} as WorkspaceManager)).exitCode).toBe(1)
    expect((await policyCommand(setup.runtime, ['dangerously-allow', 'yes'], {} as WorkspaceManager)).exitCode).toBe(1)
    expect(setup.runtime.policy.dangerouslyAllow().on).toBe(false)
  })
})

describe('the switch as data', () => {
  it('is on only when both flags are, reads its uses back from allowedBy, and redacts command lines to the executable', () => {
    expect(isDangerouslyAllowed(undefined)).toBe(false)
    expect(isDangerouslyAllowed({ commands: true, fileReads: false })).toBe(false)
    expect(isDangerouslyAllowed({ commands: true, fileReads: true })).toBe(true)
    expect(dangerousUses(['write_scope:/a', 'dangerously_allow:network_egress:127.0.0.1:9'])).toEqual([{ rule: 'network_egress', subject: '127.0.0.1:9' }])
    expect(redactedSubject('destructive_command', 'curl -H Authorization: secret')).toBe('curl [29 characters]')
    expect(redactedSubject('read_scope', '/tmp/outside')).toBe('/tmp/outside')
    expect(redactedSubject('read_scope', 'x'.repeat(300))).toBe('[300 characters]')
  })
})
