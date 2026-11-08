import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'
import { actionsPath, approvalsPath, dangerouslyAllowPath, grantsPath, type BuckleConfig } from '../common/runtime/config.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { runCli } from './support/cli.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The owner's own changes are recorded through the log service, which never makes them wait; a tool call still does
// not run without its own record.

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

function quiet(): void {
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
}

function registry(config: BuckleConfig) {
  return createApprovalRegistry(createFileGrantStore({ filePath: grantsPath(config), workspace: config.workspaceId }), approvalsPath(config))
}

describe('a broken audit log', () => {
  it('still turns the dangerously-allow switch off', async () => {
    const { config } = node()
    quiet()
    expect((await runCli({ argv: ['policy', 'dangerously-allow', 'on'], config, confirm: null })).exitCode).toBe(0)
    breakLogs(config)

    expect((await runCli({ argv: ['policy', 'dangerously-allow', 'off'], config, confirm: null })).exitCode).toBe(0)
    const switches = existsSync(dangerouslyAllowPath(config)) ? (JSON.parse(readFileSync(dangerouslyAllowPath(config), 'utf8')) as { workspaces: object }).workspaces : {}
    expect(switches).toEqual({})
  })

  it('still revokes a grant', async () => {
    const { config } = node()
    const grant = await registry(config).grants.grant({ sessionId: 's', rule: 'read_scope', subject: '/shots', scope: 'always' })
    breakLogs(config)
    quiet()

    expect((await runCli({ argv: ['grants', 'revoke', grant.id], config })).exitCode).toBe(0)
    expect(registry(config).grants.list()).toEqual([])
  })

  it('still decides with buckle approve', async () => {
    const { config } = node()
    const [request] = (await registry(config).ask({
      tool: 'fs_write', sessionId: 'chat-1', call: { arguments: { path: '/outside/report.md', content: 'x' }, cwd: '/workspace', description: 'Write "/outside/report.md"', effects: ['write /outside/report.md'], complete: true },
      asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: '/outside/report.md', reason: 'outside the workspace', offeredScopes: ['once', 'session'] }],
    })).requests
    breakLogs(config)
    quiet()

    expect((await runCli({ argv: ['approve', request!.token, '--scope', 'once'], config, confirm: async () => true })).exitCode).toBe(0)
    expect(registry(config).waiting().map(ask => ask.request.token)).toEqual([])
  })

  it('still refuses a tool call, which runs nothing without its record', async () => {
    const { config, workspace } = node()
    breakLogs(config)
    quiet()

    await expect(runCli({ argv: ['call', 'fs_write', '--json', JSON.stringify({ path: 'never.md', content: 'x' })], config })).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' })
    expect(existsSync(join(workspace, 'never.md'))).toBe(false)
  })
})
