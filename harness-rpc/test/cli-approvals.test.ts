import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createFileGrantStore } from '../src/adapters/grant-store/file-grant-store.js'
import { approvalsPath, grantsPath, loadConfig, type BuckleConfig } from '../src/config.js'
import { runCli } from '../src/faces/cli/main.js'
import { createApprovalRegistry } from '../src/services/approval-registry.js'

function node(): BuckleConfig {
  return loadConfig({
    BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-cli-approvals-')),
    BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-cli-approvals-state-')),
    BUCKLE_ALLOW_SHELL: 'false',
  })
}

/** A request waiting on the node, written through a second registry over the same state files. */
function pendingRequest(config: BuckleConfig): string {
  const registry = createApprovalRegistry(
    createFileGrantStore({ filePath: grantsPath(config), workspace: config.cwd }),
    approvalsPath(config),
    config.cwd,
  )
  const [request] = registry.issue({
    tool: 'fs_write', sessionId: 'chat-1',
    asks: [{ kind: 'ask', rule: 'write_scope', subject: '/outside/report.md', reason: 'outside the workspace', offeredScopes: ['once', 'session'] }],
  })
  return request!.token
}

async function capture(input: { argv: string[]; config: BuckleConfig }): Promise<{ exitCode: number; stdout: string }> {
  let stdout = ''
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { stdout += String(chunk); return true })
  try {
    const result = await runCli(input)
    return { exitCode: result.exitCode, stdout }
  } finally { write.mockRestore() }
}

describe('buckle approvals, the queue a person answers from', () => {
  it('names the token, tool, rule, subject, scopes and request expiry of every waiting request', async () => {
    const config = node()
    const token = pendingRequest(config)

    const listed = await capture({ argv: ['approvals'], config })

    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain(token)
    expect(listed.stdout).toContain('fs_write')
    expect(listed.stdout).toContain('write_scope: /outside/report.md')
    expect(listed.stdout).toContain('scopes: once | session')
    expect(listed.stdout).toContain('expires in')
    expect(listed.stdout).toContain(`buckle approve ${token} --scope session`)
  })

  it('says so plainly when nothing is waiting', async () => {
    const listed = await capture({ argv: ['approvals'], config: node() })

    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain('Nothing is waiting for a decision in workspace default.')
  })

  it('answers --json with the requests themselves, for a relay to render', async () => {
    const config = node()
    const token = pendingRequest(config)

    const listed = await capture({ argv: ['approvals', '--json'], config })

    expect(JSON.parse(listed.stdout)).toMatchObject([{ token, tool: 'fs_write', rule: 'write_scope' }])
  })

  it('stops naming a request once it has been decided', async () => {
    const config = node()
    const token = pendingRequest(config)

    expect((await capture({ argv: ['approve', token, '--scope', 'once'], config })).exitCode).toBe(0)

    expect((await capture({ argv: ['approvals'], config })).stdout).toContain('Nothing is waiting for a decision in workspace default.')
  })
})
