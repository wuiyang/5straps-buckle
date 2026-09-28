import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalDecisionSchema } from '@5straps/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { createFileGrantStore, createGrantLookup } from '../common/adapters/grant-store/file-grant-store.js'
import { actionsPath, approvalsPath, grantsPath, loadConfig, type BuckleConfig } from '../common/runtime/config.js'
import { createNetworkEgressRule } from '../common/domain/permission/rules/network-egress-rule.js'
import { runCli } from '../cli/main.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'

function node(): BuckleConfig {
  return loadConfig({
    BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-cli-approvals-')),
    BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-cli-approvals-state-')),
    BUCKLE_ALLOW_SHELL: 'false',
  })
}

/** A request waiting on the node, written through a second registry over the same state files. */
async function pendingRequest(config: BuckleConfig): Promise<string> {
  const registry = createApprovalRegistry(
    createFileGrantStore({ filePath: grantsPath(config), workspace: config.cwd }),
    approvalsPath(config),
    config.cwd,
  )
  const [request] = (await registry.ask({
    tool: 'fs_write', sessionId: 'chat-1',
    asks: [{ kind: 'ask', rule: 'write_scope', subject: '/outside/report.md', reason: 'outside the workspace', offeredScopes: ['once', 'session'] }],
  })).requests
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
    const token = await pendingRequest(config)

    const listed = await capture({ argv: ['approvals'], config })

    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain(token)
    expect(listed.stdout).toContain('fs_write')
    expect(listed.stdout).toContain('write_scope: /outside/report.md')
    expect(listed.stdout).toContain('scopes: once | session')
    expect(listed.stdout).toContain('expires in')
    expect(listed.stdout).toContain(`buckle approve ${token} --scope session`)
  })

  it('lists a subject with control characters escaped, so it cannot rewrite the terminal (review M3)', async () => {
    const config = node()
    const registry = createApprovalRegistry(createFileGrantStore({ filePath: grantsPath(config), workspace: config.cwd }), approvalsPath(config), config.cwd)
    await registry.ask({ tool: 'fs_write', sessionId: 'chat-1', asks: [{ kind: 'ask', rule: 'write_scope', subject: '/outside/x\u001b[2K\rls', reason: 'outside\u0007', offeredScopes: ['once'] }] })

    const listed = await capture({ argv: ['approvals'], config })

    expect(listed.stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
    expect(listed.stdout).toContain('write_scope: /outside/x\\u001b[2K\\u000dls')
  })

  it('shows buckle log, the action history, with the agent-chosen tool name, effects and detail escaped (review L1 of B13-B14)', async () => {
    const config = node()
    const tool = 'fs_read\u001b[2K\u202etxt.exe'
    await createFileActionLog(actionsPath(config)).record({ auditId: 'a1', event: 'result', workspaceId: 'default', at: new Date().toISOString(), requestId: 'r1', sessionId: 's1',
      tool, outcome: 'error', durationMs: 1, effects: ['read_path /work/notes\u200b.md'], args: {}, asked: ['read_scope:/x\u2066y'], detail: 'Unknown tool: fs_read\u001b[2K' })

    const shown = await capture({ argv: ['log'], config })

    expect(shown.exitCode).toBe(0)
    expect(shown.stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b\u202e\u2066]/)
    expect(shown.stdout).toContain('fs_read\\u001b[2K\\u202etxt.exe')
    expect(shown.stdout).toContain('read_path /work/notes\\u200b.md')
    expect(shown.stdout).toContain('asked: read_scope:/x\\u2066y')
    expect(shown.stdout).toContain('Unknown tool: fs_read\\u001b[2K')
  })

  it('says so plainly when nothing is waiting', async () => {
    const listed = await capture({ argv: ['approvals'], config: node() })

    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain('Nothing is waiting for a decision in workspace default.')
  })

  it('answers --json with the requests themselves, for a relay to render', async () => {
    const config = node()
    const token = await pendingRequest(config)

    const listed = await capture({ argv: ['approvals', '--json'], config })

    expect(JSON.parse(listed.stdout)).toMatchObject([{ token, tool: 'fs_write', rule: 'write_scope' }])
  })

  it('stops naming a request once it has been decided', async () => {
    const config = node()
    const token = await pendingRequest(config)

    expect((await capture({ argv: ['approve', token, '--scope', 'once'], config })).exitCode).toBe(0)

    expect((await capture({ argv: ['approvals'], config })).stdout).toContain('Nothing is waiting for a decision in workspace default.')
  })
})

function registry(config: BuckleConfig) {
  return createApprovalRegistry(createFileGrantStore({ filePath: grantsPath(config), workspace: config.cwd }), approvalsPath(config), config.cwd)
}

/** A private host a web_fetch asked about, waiting on the node. */
async function networkRequest(config: BuckleConfig, subject = 'app.localhost:3000'): Promise<string> {
  const [request] = (await registry(config).ask({
    tool: 'web_fetch', sessionId: 'chat-1',
    asks: [{ kind: 'ask', rule: 'network_egress', subject, reason: 'resolves to this machine', offeredScopes: ['once', 'session', 'always'] }],
  })).requests
  return request!.token
}

async function captureAll(input: { argv: string[]; config: BuckleConfig }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stderr = ''
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr += String(chunk); return true })
  try {
    return { ...await capture(input), stderr }
  } finally { write.mockRestore() }
}

function grantStore(config: BuckleConfig) {
  return createFileGrantStore({ filePath: grantsPath(config), workspace: config.cwd })
}

function networkSubjects(config: BuckleConfig): string[] {
  return grantStore(config).list().filter(grant => grant.rule === 'network_egress').map(grant => grant.subject)
}

describe('buckle approve --host, widening a network approval to a pattern (BUCKLE-D18)', () => {
  it('records the pattern instead of the host when it covers the host that asked, and lists it as entered', async () => {
    const config = node()
    const token = await networkRequest(config)

    const approved = await captureAll({ argv: ['approve', token, '--scope', 'always', '--host', '*.localhost'], config })

    expect(approved.exitCode).toBe(0)
    expect(approved.stdout).toContain(`Approved ${token} (always) for *.localhost, asked by app.localhost:3000, in workspace default`)
    expect(networkSubjects(config)).toEqual(['*.localhost'])
    expect(grantStore(config).list()[0]).toMatchObject({ subject: '*.localhost', pattern: true })
    expect((await capture({ argv: ['grants', 'list'], config })).stdout).toMatch(/always\s+network_egress\s+\*\.localhost {2}\(host pattern\)/)
  })

  it('refuses a pattern that does not cover the host that asked, naming both, and leaves the request waiting', async () => {
    const config = node()
    const token = await networkRequest(config)

    const refused = await captureAll({ argv: ['approve', token, '--scope', 'session', '--host', '*.example.com'], config })

    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain('The pattern *.example.com does not cover app.localhost:3000, the host that asked')
    expect(networkSubjects(config)).toEqual([])
    expect(registry(config).pending().map(request => request.token)).toEqual([token])
  })

  it('refuses to widen a once approval, which covers one call to the host that asked', async () => {
    const config = node()
    const token = await networkRequest(config)

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
    const token = await networkRequest(config)

    const refused = await captureAll({ argv: ['approve', token, '--scope', 'session', '--host', host], config })

    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain(reason)
    expect(networkSubjects(config)).toEqual([])
    expect(registry(config).pending().map(request => request.token)).toEqual([token])
  })

  it('refuses --host on a denial, which names no pattern, and leaves the request waiting', async () => {
    const config = node()
    const token = await networkRequest(config)

    const refused = await captureAll({ argv: ['approve', token, '--deny', '--host', '*.localhost'], config })

    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain('A denial names no host pattern; deny without --host')
    expect(networkSubjects(config)).toEqual([])
    expect(registry(config).pending().map(request => request.token)).toEqual([token])
  })

  it('refuses a wildcard over an address suffix for a request from an address, and leaves it waiting', async () => {
    const config = node()
    const token = await networkRequest(config, '127.0.0.1:3000')

    const refused = await captureAll({ argv: ['approve', token, '--scope', 'session', '--host', '*.0.0.1'], config })

    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain('A wildcard covers a domain, not an address: *.0.0.1')
    expect(networkSubjects(config)).toEqual([])
    expect(registry(config).pending().map(request => request.token)).toEqual([token])
  })

  it('widens only a network approval', async () => {
    const config = node()
    const token = await pendingRequest(config)

    const refused = await captureAll({ argv: ['approve', token, '--scope', 'session', '--host', '*.localhost'], config })

    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain('--host widens a network approval only; this one is write_scope')
    expect(registry(config).pending().map(request => request.token)).toEqual([token])
  })

  it('refuses the widening from any authority but the admin credential, whatever the scope', async () => {
    const config = node()
    const token = await networkRequest(config)

    for (const scope of ['once', 'session', 'always'] as const) {
      expect(await registry(config).resolve({ token, approved: true, scope }, 'agent', { widenTo: '*.localhost' })).toMatchObject({ ok: false })
    }
    expect(networkSubjects(config)).toEqual([])
    expect(registry(config).pending()).toHaveLength(1)
  })

  it('widens nothing from a decision that arrives with a host field, as a relay or an agent would send one', async () => {
    const config = node()
    const token = await networkRequest(config)

    const decision = ApprovalDecisionSchema.parse({ token, approved: true, scope: 'session', host: '*.localhost', widenTo: '*.localhost' })
    expect(await registry(config).resolve(decision, 'admin')).toEqual({ ok: true })
    expect(networkSubjects(config)).toEqual(['app.localhost:3000'])
  })

  it('records the pattern and the host that asked in the approve command\'s audit entry', async () => {
    const config = node()
    const token = await networkRequest(config)

    await captureAll({ argv: ['approve', token, '--scope', 'session', '--host', '*.localhost:3000'], config })

    const result = createFileActionLog(actionsPath(config)).read(10).find(entry => entry.tool === 'cli_approve' && entry.event === 'result')
    expect(result).toMatchObject({ outcome: 'ok', detail: 'network_egress session approval widened to *.localhost:3000, asked by app.localhost:3000' })
  })

  it('answers a repeat of the same widening as done, and a different one as a conflict', async () => {
    const config = node()
    const token = await networkRequest(config)

    expect((await captureAll({ argv: ['approve', token, '--scope', 'session', '--host', '*.localhost'], config })).exitCode).toBe(0)
    expect((await captureAll({ argv: ['approve', token, '--scope', 'session', '--host', '*.localhost'], config })).exitCode).toBe(0)
    expect(await captureAll({ argv: ['approve', token, '--scope', 'session'], config })).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('already has a different decision') })
  })

})

describe('a * in a URL host never becomes a pattern grant (BUCKLE-D18)', () => {
  const rule = createNetworkEgressRule({ approved: null })
  const evaluate = (config: BuckleConfig, url: string) => rule.evaluate({ tool: 'web_fetch', effect: { kind: 'network', url: new URL(url) }, grants: createGrantLookup(grantStore(config), 'chat-1') })

  it('refuses the request for http://*.localhost:3000/ before any approval is asked', () => {
    const config = node()

    expect(evaluate(config, 'http://*.localhost:3000/')).toMatchObject({ kind: 'deny', reason: expect.stringContaining('A host cannot contain *') })
    expect(registry(config).pending()).toEqual([])
  })

  it('keeps a stored grant spelled *.localhost:3000 without the pattern flag to its literal string, whatever approved it', async () => {
    const config = node()
    const token = await networkRequest(config, '*.localhost:3000')
    expect(await registry(config).resolve({ token, approved: true, scope: 'session' }, 'admin')).toEqual({ ok: true })
    const now = new Date().toISOString()
    writeFileSync(grantsPath(config), JSON.stringify({ version: 1, grants: [
      ...grantStore(config).list(),
      { id: 'starred', workspace: config.cwd, rule: 'network_egress', subject: '*.localhost', scope: 'always', sessionId: null, createdAt: now, expiresAt: null },
    ] }))

    expect(grantStore(config).list().every(grant => grant.pattern === undefined)).toBe(true)
    for (const url of ['http://app.localhost:3000/', 'http://localhost:3000/', 'http://x.y.localhost:3000/', 'http://localhost/']) {
      expect(evaluate(config, url)).toMatchObject({ kind: 'ask' })
    }
  })
})
