import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RECORD_FAILED_EXIT } from '../cli/exit-codes.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'
import { actionsPath, approvalsPath, dangerouslyAllowPath, grantsPath, type BuckleConfig } from '../common/runtime/config.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { runCli } from './support/cli.js'
import { recordActivity } from './support/activity.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The owner's own command waits for its record, so a broken log stops it, naming the error, unless the owner
// passes --ignore-warning, which runs it and hands the record to the log service. A tool call never runs without its
// own record, whatever flag it is given.

afterEach(() => { vi.restoreAllMocks() })

function node(): { config: BuckleConfig; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), 'buckle-broken-audit-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' })
  return { config, workspace }
}

/** The node's log and the workspace's become directories: every append fails, as on a full or read-only disk. */
function breakLogs(config: BuckleConfig): void {
  for (const log of [actionsPath(config), join(config.nodeStateDirectory ?? config.stateDirectory, 'actions.jsonl')]) {
    rmSync(log, { force: true })
    mkdirSync(log, { recursive: true })
  }
}

function capture(): { stderr: () => string } {
  let stderr = ''
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr += String(chunk); return true })
  return { stderr: () => stderr }
}

function registry(config: BuckleConfig) {
  return createApprovalRegistry(createFileGrantStore({ filePath: grantsPath(config), workspace: config.workspaceId }), approvalsPath(config))
}

function switches(config: BuckleConfig): object {
  return existsSync(dangerouslyAllowPath(config)) ? (JSON.parse(readFileSync(dangerouslyAllowPath(config), 'utf8')) as { workspaces: object }).workspaces : {}
}

async function waitingAsk(config: BuckleConfig): Promise<string> {
  const [request] = (await registry(config).ask({
    tool: 'fs_write', sessionId: 'chat-1', call: { arguments: { path: '/outside/report.md', content: 'x' }, cwd: '/workspace', description: 'Write "/outside/report.md"', effects: ['write /outside/report.md'], complete: true },
    asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: '/outside/report.md', reason: 'outside the workspace', offeredScopes: ['once', 'session'] }],
  })).requests
  await recordActivity(config, { sessionId: 'chat-1' })
  return request!.token
}

describe('a broken audit log', () => {
  it('stops buckle policy dangerously-allow off, naming the error and --ignore-warning, and the switch stays on', async () => {
    const { config } = node()
    const output = capture()
    expect((await runCli({ argv: ['policy', 'dangerously-allow', 'on'], config, confirm: null })).exitCode).toBe(0)
    breakLogs(config)

    expect((await runCli({ argv: ['policy', 'dangerously-allow', 'off'], config, confirm: null })).exitCode).toBe(RECORD_FAILED_EXIT)
    expect(switches(config)).not.toEqual({})
    expect(output.stderr()).toMatch(/could not write the record of this change to its audit log, so the change did not run: .*(EISDIR|directory)/)
    expect(output.stderr()).toContain('--ignore-warning')
  })

  it('stops buckle grants revoke and buckle approve, and changes nothing', async () => {
    const { config } = node()
    const grant = await registry(config).grants.grant({ sessionId: 's', rule: 'read_scope', subject: '/shots', scope: 'always' })
    const token = await waitingAsk(config)
    breakLogs(config)
    capture()

    expect((await runCli({ argv: ['grants', 'revoke', grant.id], config })).exitCode).toBe(RECORD_FAILED_EXIT)
    expect((await runCli({ argv: ['approve', token, '--scope', 'once'], config, confirm: async () => true })).exitCode).toBe(RECORD_FAILED_EXIT)
    expect(registry(config).grants.list().map(item => item.id)).toEqual([grant.id])
    expect(registry(config).waiting().map(ask => ask.request.token)).toEqual([token])
  })

  it('turns the switch off with --ignore-warning', async () => {
    const { config } = node()
    capture()
    expect((await runCli({ argv: ['policy', 'dangerously-allow', 'on'], config, confirm: null })).exitCode).toBe(0)
    breakLogs(config)

    expect((await runCli({ argv: ['policy', 'dangerously-allow', 'off'], config, confirm: null, ignoreWarning: true })).exitCode).toBe(0)
    expect(switches(config)).toEqual({})
  })

  it('revokes a grant and decides with buckle approve under --ignore-warning', async () => {
    const { config } = node()
    const grant = await registry(config).grants.grant({ sessionId: 's', rule: 'read_scope', subject: '/shots', scope: 'always' })
    const token = await waitingAsk(config)
    breakLogs(config)
    capture()

    expect((await runCli({ argv: ['grants', 'revoke', grant.id], config, ignoreWarning: true })).exitCode).toBe(0)
    expect((await runCli({ argv: ['approve', token, '--scope', 'once'], config, confirm: async () => true, ignoreWarning: true })).exitCode).toBe(0)
    expect(registry(config).grants.list()).toEqual([])
    expect(registry(config).waiting()).toEqual([])
  })

  it('still refuses a tool call, which runs nothing without its record', async () => {
    const { config, workspace } = node()
    breakLogs(config)
    capture()

    await expect(runCli({ argv: ['call', 'fs_write', '--json', JSON.stringify({ path: 'never.md', content: 'x' })], config })).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' })
    expect(existsSync(join(workspace, 'never.md'))).toBe(false)
  })

  it('refuses --ignore-warning on a tool call, which it never lets run without its record', async () => {
    const { config, workspace } = node()
    breakLogs(config)
    const output = capture()

    expect((await runCli({ argv: ['call', 'fs_write', '--json', JSON.stringify({ path: 'never.md', content: 'x' })], config, ignoreWarning: true })).exitCode).toBe(1)
    expect((await runCli({ argv: ['fs', 'write', 'never.md', 'x'], config, ignoreWarning: true })).exitCode).toBe(1)
    expect(existsSync(join(workspace, 'never.md'))).toBe(false)
    expect(output.stderr()).toContain('--ignore-warning')
  })
})
