import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { loadConfig, type BuckleConfig } from '../src/config.js'
import { runCli } from '../src/faces/cli/main.js'
import { createRuntime, type BuckleRuntime } from '../src/runtime.js'
import { createApprovalDelivery, createChildApprovalDelivery } from '../src/services/approval-delivery.js'
import { createWorkspaceManager } from '../src/services/workspace-manager.js'
import type { ApprovalRegistry } from '../src/services/approval-registry.js'

const CHILD_AGENT_TOKEN = 'child-agent-token-fixture-only'
const CHILD_ADMIN_TOKEN = 'child-admin-token-fixture-only'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A node with the owner's callbacks configured, plus one registered child workspace. */
async function nodeWithChild(environment: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-child-approvals-'))
  roots.push(root)
  for (const directory of ['default', 'child']) mkdirSync(join(root, directory))
  const config = loadConfig({
    BUCKLE_WORKSPACE_ROOT: join(root, 'default'),
    BUCKLE_STATE_DIR: join(root, 'state'),
    BUCKLE_ALLOW_SHELL: 'false',
    BUCKLE_APPROVAL_WEBHOOK: 'http://127.0.0.1:9/approvals',
    BUCKLE_REPORT_URL: 'http://127.0.0.1:9/reports',
    BUCKLE_REPORT_TOKEN: 'node-report-token-fixture-only',
    ...environment,
  })
  const runtime = await createRuntime({ config, channel: approvals => createApprovalDelivery({ config, approvals, workspaceId: 'default', prompt: false }) })
  const manager = createWorkspaceManager({ config, runtime })
  manager.register({ id: 'child', name: 'Child', root: join(root, 'child'), authToken: CHILD_AGENT_TOKEN, adminToken: CHILD_ADMIN_TOKEN, policy: emptyWorkspacePolicy() })
  return { config, runtime, manager }
}

function pendingIn(runtime: BuckleRuntime): string {
  const [request] = runtime.approvals.issue({
    tool: 'fs_write', sessionId: 'chat-1',
    asks: [{ kind: 'ask', rule: 'write_scope', subject: '/outside/report.md', reason: 'outside the workspace', offeredScopes: ['once', 'session'] }],
  })
  return request!.token
}

async function capture(input: { argv: string[]; config: BuckleConfig }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = '', stderr = ''
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { stdout += String(chunk); return true })
  const error = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr += String(chunk); return true })
  try {
    const result = await runCli(input)
    return { exitCode: result.exitCode, stdout, stderr }
  } finally { out.mockRestore(); error.mockRestore() }
}

describe('what a child workspace runtime inherits from the node', () => {
  it('keeps the report endpoint and the approval webhook, so its calls are not invisible', async () => {
    const { manager } = await nodeWithChild()

    const child = await manager.resolve('child')

    expect(child.config.reportUrl).toBe('http://127.0.0.1:9/reports')
    expect(child.config.reportToken).toBeDefined()
    expect(child.config.approvalWebhook).toBe('http://127.0.0.1:9/approvals')
    expect(child.runtime.workspaceId).toBe('child')
  }, 30_000)

  it('holds a call open where a webhook can reach someone, and relays at once where none can', () => {
    const withWebhook = { approvalWebhook: 'http://127.0.0.1:9/approvals', approvalTimeoutMs: 15_000 } as BuckleConfig
    const withoutWebhook = { approvalTimeoutMs: 15_000 } as BuckleConfig
    const approvals = {} as ApprovalRegistry

    expect(createChildApprovalDelivery({ config: withWebhook, approvals, workspaceId: 'child' }).id).toBe('waiting')
    expect(createChildApprovalDelivery({ config: withoutWebhook, approvals, workspaceId: 'child' }).id).toBe('deferred')
    // The node's own faces hold the call either way: a `buckle approve` elsewhere can still land.
    expect(createApprovalDelivery({ config: withoutWebhook, approvals, workspaceId: 'default', prompt: false }).id).toBe('waiting')
  })
})

describe('answering a child workspace request from the terminal', () => {
  it('resolves it when the workspace is named, and says which workspace it answered', async () => {
    const { config, manager } = await nodeWithChild()
    const child = await manager.resolve('child')
    const token = pendingIn(child.runtime)

    const approved = await capture({ argv: ['approve', token, '--scope', 'once', '--workspace', 'child'], config })

    expect(approved.exitCode).toBe(0)
    expect(approved.stdout).toContain('in workspace child')
    expect((await manager.resolve('child')).runtime.approvals.pending()).toEqual([])
  }, 30_000)

  it('refuses the same token unnamed, because a token resolves in its own workspace alone', async () => {
    const { config, manager } = await nodeWithChild()
    const token = pendingIn((await manager.resolve('child')).runtime)

    const approved = await capture({ argv: ['approve', token, '--scope', 'once'], config })

    expect(approved.exitCode).toBe(1)
    expect(approved.stderr).toContain('in workspace default')
  }, 30_000)

  it('lists the child queue with the command that answers it there', async () => {
    const { config, manager } = await nodeWithChild()
    const token = pendingIn((await manager.resolve('child')).runtime)

    const listed = await capture({ argv: ['approvals', '--workspace', 'child'], config })

    expect(listed.stdout).toContain(token)
    expect(listed.stdout).toContain(`buckle approve ${token} --scope session --workspace child`)
  }, 30_000)

  it('names the workspace it could not find rather than reporting an empty queue', async () => {
    const { config } = await nodeWithChild()

    const listed = await capture({ argv: ['approvals', '--workspace', 'nowhere'], config })

    expect(listed.exitCode).toBe(1)
    expect(listed.stderr).toContain('Workspace not found')
  }, 30_000)
})
