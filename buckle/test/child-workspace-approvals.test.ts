import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import type { BuckleConfig } from '../common/runtime/config.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { runCli } from './support/cli.js'
import type { CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction } from './support/interaction.js'
import { byName, idOf, registerWorkspace, workspacesOf } from './support/workspaces.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'

const NODE_REPORT_TOKEN = 'node-report-token-fixture-only'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A node with the owner's callbacks configured, plus one registered child workspace. */
async function nodeWithChild(environment: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-child-approvals-'))
  roots.push(root)
  for (const directory of ['default', 'child']) mkdirSync(join(root, directory))
  const config = configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: join(root, 'default'),
    BUCKLE_STATE_DIR: join(root, 'state'),
    BUCKLE_ALLOW_SHELL: 'false',
    BUCKLE_APPROVAL_WEBHOOK: 'http://127.0.0.1:9/approvals',
    BUCKLE_REPORT_URL: 'http://127.0.0.1:9/reports',
    BUCKLE_REPORT_TOKEN: NODE_REPORT_TOKEN,
    ...environment,
  })
  const manager = await workspacesOf(config, { interaction: fixedInteraction() })
  await registerWorkspace(manager, { id: 'child', name: 'Child', dir: join(root, 'child'), policy: emptyWorkspacePolicy() })
  const runtime = (await byName(manager, 'default')).runtime
  return { config, runtime, manager }
}

async function pendingIn(runtime: CoreRuntime): Promise<string> {
  const [request] = (await runtime.approvals.ask({
    tool: 'fs_write', sessionId: 'chat-1', call: { arguments: { path: '/outside/report.md', content: 'x' }, cwd: '/workspace', description: 'Write "/outside/report.md"', effects: ['write /outside/report.md'], complete: true },
    asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: '/outside/report.md', reason: 'outside the workspace', offeredScopes: ['once', 'session'] }],
  })).requests
  return request!.token
}

async function capture(input: { argv: string[]; config: BuckleConfig; cwd?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = '', stderr = ''
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { stdout += String(chunk); return true })
  const error = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr += String(chunk); return true })
  try {
    // A person at a terminal who confirms each approval after reading the action (owner decision D17).
    const result = await runCli({ confirm: async () => true, ...input })
    return { exitCode: result.exitCode, stdout, stderr }
  } finally { out.mockRestore(); error.mockRestore() }
}

describe('what a child workspace runtime inherits from the node', () => {
  it('keeps the report endpoint and the approval webhook, so its calls are not invisible', async () => {
    const { manager } = await nodeWithChild()

    const child = await byName(manager, 'child')

    expect(child.config.reportUrl).toBe('http://127.0.0.1:9/reports')
    // The node's own credential, not merely some value: a child filing under another node's
    // credential is what Rings refuses, and definedness alone would not have caught it.
    expect(child.config.reportToken).toBe(NODE_REPORT_TOKEN)
    expect(child.config.approvalWebhook).toBe('http://127.0.0.1:9/approvals')
    expect(child.runtime.workspaceId).toBe(idOf(manager, 'child'))
  }, 30_000)

  it.each([['with', {}], ['without', { BUCKLE_APPROVAL_WEBHOOK: '' }]])('holds a child call for the owner\'s CLI decision %s a webhook', async (_label, environment) => {
    const { config, manager } = await nodeWithChild(environment)
    const child = await byName(manager, 'child')
    const call = child.runtime.invoke({ request: { requestId: 'child-write', tool: 'fs_write', args: { path: '/workspace/note.md', content: 'held' }, approvalTokens: [] }, sessionId: 'chat-1' })
    await vi.waitFor(() => expect(child.runtime.approvals.pending()).toHaveLength(1))
    const token = child.runtime.approvals.pending()[0]!.token

    // The owner answers from another process's view of the same state, as `buckle approve` does.
    expect((await capture({ argv: ['approve', token, '--scope', 'once', '--workspace', 'child'], config })).exitCode).toBe(0)

    expect(await call).toMatchObject({ outcome: 'ok' })
    expect(existsSync(join(child.config.cwd, 'note.md'))).toBe(true)
  }, 30_000)
})

describe('answering a child workspace request from the terminal', () => {
  it('resolves it when the workspace is named, and says which workspace it answered', async () => {
    const { config, manager } = await nodeWithChild()
    const child = await byName(manager, 'child')
    const token = await pendingIn(child.runtime)

    const approved = await capture({ argv: ['approve', token, '--scope', 'once', '--workspace', 'child'], config })

    expect(approved.exitCode).toBe(0)
    expect(approved.stdout).toContain('in workspace Child')
    expect((await byName(manager, 'child')).runtime.approvals.pending()).toEqual([])
  }, 30_000)

  // Q9 of the workspace-model brief: naming no workspace means every online one, and the token is answered where it waits.
  it('answers a token with --all in the workspace whose queue holds it, and refuses it from a workspace that does not', async () => {
    const { config, manager } = await nodeWithChild()
    const token = await pendingIn((await byName(manager, 'child')).runtime)

    // Unnamed, it defaults to the workspace holding the current directory (the node folder), which does not hold the child's ask.
    const elsewhere = await capture({ argv: ['approve', token, '--scope', 'once'], config, cwd: config.cwd })
    expect(elsewhere.exitCode).toBe(1)
    expect(elsewhere.stderr).toContain(`in workspace ${basename(config.cwd)}`)

    const approved = await capture({ argv: ['approve', token, '--scope', 'once', '--all'], config, cwd: config.cwd })
    expect(approved.exitCode).toBe(0)
    expect(approved.stdout).toContain('in workspace Child')
    expect((await byName(manager, 'child')).runtime.approvals.pending()).toEqual([])
  }, 30_000)

  it('lists the child queue with the command that answers it there', async () => {
    const { config, manager } = await nodeWithChild()
    const token = await pendingIn((await byName(manager, 'child')).runtime)

    const listed = await capture({ argv: ['approvals', '--workspace', 'child'], config })

    expect(listed.stdout).toContain(token)
    expect(listed.stdout).toContain(`buckle approve ${token} --scope session --workspace Child`)
  }, 30_000)

  it('names the workspace it could not find rather than reporting an empty queue', async () => {
    const { config } = await nodeWithChild()

    const listed = await capture({ argv: ['approvals', '--workspace', 'nowhere'], config })

    expect(listed.exitCode).toBe(1)
    expect(listed.stderr).toContain(`No workspace is named nowhere. The workspaces: ${basename(config.cwd)}, Child`)
  }, 30_000)
})
