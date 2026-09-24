import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalDecisionSchema } from '@5straps/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createFileActionLog } from '../src/adapters/action-log/file-action-log.js'
import { createFileGrantStore } from '../src/adapters/grant-store/file-grant-store.js'
import { actionsPath, approvalsPath, grantsPath, loadConfig, type BuckleConfig } from '../src/config.js'
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

function registry(config: BuckleConfig) {
  return createApprovalRegistry(createFileGrantStore({ filePath: grantsPath(config), workspace: config.cwd }), approvalsPath(config), config.cwd)
}

/** A private host a web_fetch asked about, waiting on the node. */
function networkRequest(config: BuckleConfig, subject = 'app.localhost:3000'): string {
  const [request] = registry(config).issue({
    tool: 'web_fetch', sessionId: 'chat-1',
    asks: [{ kind: 'ask', rule: 'network_egress', subject, reason: 'resolves to this machine', offeredScopes: ['once', 'session', 'always'] }],
  })
  return request!.token
}

async function captureAll(input: { argv: string[]; config: BuckleConfig }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stderr = ''
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr += String(chunk); return true })
  try {
    return { ...await capture(input), stderr }
  } finally { write.mockRestore() }
}

function networkSubjects(config: BuckleConfig): string[] {
  return createFileGrantStore({ filePath: grantsPath(config), workspace: config.cwd }).list().filter(grant => grant.rule === 'network_egress').map(grant => grant.subject)
}

describe('buckle approve --host, widening a network approval to a pattern (BUCKLE-D18)', () => {
  it('records the pattern instead of the host when it covers the host that asked, and lists it as entered', async () => {
    const config = node()
    const token = networkRequest(config)

    const approved = await captureAll({ argv: ['approve', token, '--scope', 'always', '--host', '*.localhost'], config })

    expect(approved.exitCode).toBe(0)
    expect(approved.stdout).toContain(`Approved ${token} (always) for *.localhost, asked by app.localhost:3000, in workspace default`)
    expect(networkSubjects(config)).toEqual(['*.localhost'])
    expect((await capture({ argv: ['grants', 'list'], config })).stdout).toMatch(/always\s+network_egress\s+\*\.localhost/)
  })

  it('refuses a pattern that does not cover the host that asked, naming both, and leaves the request waiting', async () => {
    const config = node()
    const token = networkRequest(config)

    const refused = await captureAll({ argv: ['approve', token, '--scope', 'session', '--host', '*.example.com'], config })

    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain('The pattern *.example.com does not cover app.localhost:3000, the host that asked')
    expect(networkSubjects(config)).toEqual([])
    expect(registry(config).pending().map(request => request.token)).toEqual([token])
  })

  it('refuses to widen a once approval, which covers one call to the host that asked', async () => {
    const config = node()
    const token = networkRequest(config)

    const refused = await captureAll({ argv: ['approve', token, '--scope', 'once', '--host', '*.localhost'], config })

    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain('A once approval covers one call')
    expect(registry(config).pending()).toHaveLength(1)
  })

  it.each([
    ['*', 'lone * would match every host'],
    ['*.*.localhost', 'whole leftmost label'],
    ['https://app.localhost', 'names no scheme'],
    ['app.localhost', '--host takes a wildcard pattern'],
  ])('refuses the malformed or exact --host %s, saying why', async (host, reason) => {
    const config = node()
    const token = networkRequest(config)

    const refused = await captureAll({ argv: ['approve', token, '--scope', 'session', '--host', host], config })

    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain(reason)
    expect(networkSubjects(config)).toEqual([])
  })

  it('widens only a network approval', async () => {
    const config = node()
    const token = pendingRequest(config)

    const refused = await captureAll({ argv: ['approve', token, '--scope', 'session', '--host', '*.localhost'], config })

    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain('--host widens a network approval only; this one is write_scope')
  })

  it('refuses the widening from any authority but the admin credential, whatever the scope', () => {
    const config = node()
    const token = networkRequest(config)

    for (const scope of ['once', 'session', 'always'] as const) {
      expect(registry(config).resolve({ token, approved: true, scope }, 'agent', { widenTo: '*.localhost' })).toMatchObject({ ok: false })
    }
    expect(networkSubjects(config)).toEqual([])
    expect(registry(config).pending()).toHaveLength(1)
  })

  it('widens nothing from a decision that arrives with a host field, as a relay or an agent would send one', () => {
    const config = node()
    const token = networkRequest(config)

    const decision = ApprovalDecisionSchema.parse({ token, approved: true, scope: 'session', host: '*.localhost', widenTo: '*.localhost' })
    expect(registry(config).resolve(decision, 'admin')).toEqual({ ok: true })
    expect(networkSubjects(config)).toEqual(['app.localhost:3000'])
  })

  it('records the pattern and the host that asked in the approve command\'s audit entry', async () => {
    const config = node()
    const token = networkRequest(config)

    await captureAll({ argv: ['approve', token, '--scope', 'session', '--host', '*.localhost:3000'], config })

    const result = createFileActionLog(actionsPath(config)).read(10).find(entry => entry.tool === 'cli_approve' && entry.event === 'result')
    expect(result).toMatchObject({ outcome: 'ok', detail: 'network_egress session approval widened to *.localhost:3000, asked by app.localhost:3000' })
  })

  it('answers a repeat of the same widening as done, and a different one as a conflict', async () => {
    const config = node()
    const token = networkRequest(config)

    expect((await captureAll({ argv: ['approve', token, '--scope', 'session', '--host', '*.localhost'], config })).exitCode).toBe(0)
    expect((await captureAll({ argv: ['approve', token, '--scope', 'session', '--host', '*.localhost'], config })).exitCode).toBe(0)
    expect(await captureAll({ argv: ['approve', token, '--scope', 'session'], config })).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('already has a different decision') })
  })

  it('loads grants and answered approvals written before patterns existed, exact hosts unchanged', () => {
    const config = node()
    const now = new Date().toISOString()
    writeFileSync(grantsPath(config), JSON.stringify({ version: 1, grants: [
      { id: 'old-1', workspace: config.cwd, rule: 'network_egress', subject: 'localhost:3000', scope: 'always', sessionId: null, createdAt: now, expiresAt: null },
    ] }))
    const later = new Date(Date.now() + 60_000).toISOString()
    writeFileSync(approvalsPath(config), JSON.stringify({ version: 1, pending: [], once: [], resolved: [
      { workspace: config.cwd, decision: { token: 'old-token', approved: true, scope: 'always' }, expiresAt: later },
    ] }))

    expect(networkSubjects(config)).toEqual(['localhost:3000'])
    expect(registry(config).resolve({ token: 'old-token', approved: true, scope: 'always' })).toEqual({ ok: true })
  })
})
