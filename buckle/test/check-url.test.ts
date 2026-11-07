import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { approvalsPath, grantsPath, type BuckleConfig } from '../common/runtime/config.js'
import { settingsPath } from '../common/services/workspaces/workspace-settings.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { checkUrlCommand } from '../cli/check-url.js'
import { runCli } from './support/cli.js'
import { idOf, registerWorkspace, workspacesOf } from './support/workspaces.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'
import { SOURCES } from '../common/types/ports/approval-source.js'

function node(environment: Record<string, string> = {}): BuckleConfig {
  return configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-check-url-')),
    BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-check-url-state-')),
    BUCKLE_ALLOW_SHELL: 'false',
    ...environment,
  })
}

async function check(config: BuckleConfig, ...argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { stdout += String(chunk); return true })
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr += String(chunk); return true })
  try {
    return { exitCode: (await runCli({ argv: ['check-url', ...argv], config })).exitCode, stdout, stderr }
  } finally {
    out.mockRestore()
    err.mockRestore()
  }
}

function grants(config: BuckleConfig) {
  return createFileGrantStore({ filePath: grantsPath(config), workspace: config.workspaceId })
}

describe('buckle check-url', () => {
  it('approves a host named exactly on the approved list, naming the entry', async () => {
    const result = await check(node({ BUCKLE_NETWORK_ALLOW: 'api.example.com' }), 'https://api.example.com/v1/items')

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('approved: https://api.example.com/v1/items (approved list entry api.example.com)\n')
  })

  it('lets a wildcard entry approve a subdomain and the apex, and nothing beside them', async () => {
    const config = node({ BUCKLE_NETWORK_ALLOW: '*.example.com' })

    expect(await check(config, 'docs.example.com')).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('approved list entry *.example.com') })
    expect(await check(config, 'example.com')).toMatchObject({ exitCode: 0, stdout: expect.stringMatching(/^approved: https:\/\/example\.com\//) })
    const other = await check(config, 'example.org')
    expect(other.exitCode).toBe(1)
    expect(other.stdout).toMatch(/^denied: https:\/\/example\.org\/ \(network_egress: .*not on the workspace's approved list/)
  })

  it('reads the list buckle policy stored in the state directory, with no node running', async () => {
    const config = node()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      expect((await runCli({ argv: ['policy', 'allow-url', '*.example.com'], config })).exitCode).toBe(0)
    } finally { write.mockRestore() }

    expect((await check(config, 'api.example.com')).exitCode).toBe(0)
  })

  // Phase 2 item 5: BUCKLE_ALLOWED_HOSTS is the node's URL list too, so its hosts are approved entries and the rest denied.
  it('approves a host on BUCKLE_ALLOWED_HOSTS as an approved list entry, and denies one it leaves off', async () => {
    const config = node({ BUCKLE_ALLOWED_HOSTS: 'nas.internal' })
    const result = await check(config, 'http://nas.internal/status')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('(approved list entry nas.internal)')
    expect((await check(config, 'https://example.com/')).exitCode).toBe(1)
  })

  it('approves a private address an exact entry names, as web_fetch reaches it', async () => {
    const result = await check(node({ BUCKLE_ALLOWED_HOSTS: '127.0.0.1:8080' }), '127.0.0.1:8080')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('approved: https://127.0.0.1:8080/ (approved list entry 127.0.0.1:8080)\n')
  })

  it('denies a private address the approved list leaves off', async () => {
    const result = await check(node({ BUCKLE_NETWORK_ALLOW: 'example.com' }), 'http://10.0.0.5/')

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('denied: http://10.0.0.5/')
    expect(result.stdout).toContain('Approved: example.com')
  })

  it('reports an unlisted public host as not listed with exit 4, and a private one as asking with exit 3, with no list set', async () => {
    const config = node()

    const publicHost = await check(config, 'example.org')
    expect(publicHost.exitCode).toBe(4)
    expect(publicHost.stdout).toMatch(/^not listed: https:\/\/example\.org\/ \(no approved list is set/)
    const privateHost = await check(config, '192.168.1.10')
    expect(privateHost.exitCode).toBe(3)
    expect(privateHost.stdout).toMatch(/^asks: https:\/\/192\.168\.1\.10\/ \(network_egress: 192\.168\.1\.10 is in the/)
  })

  it('reads a scheme-less localhost:3000 as host localhost on port 3000, as the browser does', async () => {
    expect((await check(node(), 'localhost:3000')).stdout).toBe('asks: https://localhost:3000/ (network_egress: localhost resolves to this machine)\n')
    expect(await check(node({ BUCKLE_NETWORK_ALLOW: 'localhost:3000' }), 'localhost:3000')).toMatchObject({ exitCode: 0 })
    expect((await check(node({ BUCKLE_NETWORK_ALLOW: 'localhost:3000' }), 'localhost:4000')).exitCode).toBe(1)
  })

  it('counts a persisted approval always, and a session approval only for the session named', async () => {
    const config = node()
    await grants(config).grant({ sessionId: 'chat-1', rule: 'network_egress', subject: 'localhost:3000', scope: 'always' })
    await grants(config).grant({ sessionId: 'chat-1', rule: 'network_egress', subject: 'localhost:5173', scope: 'session' })

    expect(await check(config, 'http://localhost:3000')).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('(persisted approval for localhost:3000)') })
    expect((await check(config, 'http://localhost:5173')).exitCode).toBe(3)
    expect(await check(config, 'http://localhost:5173', '--session', 'chat-1')).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('(session approval in session chat-1 for localhost:5173)') })
    expect((await check(config, 'http://localhost:5173', '--session', 'chat-2')).exitCode).toBe(3)
  })

  it('counts an unspent once approval only for the session named', async () => {
    const config = node()
    const registry = createApprovalRegistry(grants(config), approvalsPath(config))
    const [request] = (await registry.ask({ tool: 'web_fetch', sessionId: 'chat-1', call: { arguments: { url: 'http://localhost:3000/' }, cwd: '/workspace', description: null, effects: ['network http://localhost:3000/'], complete: true }, asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'network_egress', subject: 'localhost:3000', reason: 'local', offeredScopes: ['once'] }] })).requests
    await registry.resolve({ token: request!.token, approved: true, scope: 'once' }, SOURCES.cli)

    expect((await check(config, 'localhost:3000')).exitCode).toBe(3)
    expect(await check(config, 'localhost:3000', '--session', 'chat-1')).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('unspent once approval for web_fetch in session chat-1') })
  })

  it('denies a non-HTTP scheme', async () => {
    expect(await check(node(), 'file:///etc/passwd')).toMatchObject({ exitCode: 1, stdout: expect.stringContaining('Only http and https are allowed') })
  })

  it.each([[[]], [['']], [['two words']], [['/etc/passwd']], [['a.com', 'b.com']], [['a.com', '--bogus']]])('exits 2 on bad input %j', async argv => {
    const result = await check(node(), ...argv)

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toBe('')
  })

  it('exits 2 when the recorded approvals cannot be read, rather than reading as a denial', async () => {
    const config = node()
    await workspacesOf(config)
    writeFileSync(grantsPath(config), '{ not json')

    expect(await check(config, 'localhost:3000')).toMatchObject({ exitCode: 2, stdout: '', stderr: expect.stringContaining(`Cannot read the approvals in workspace ${basename(config.cwd)}`) })
  })

  // Q14 of the workspace-model brief: no node list sits over a workspace's, so each judges by its own alone.
  it('holds each workspace to its own list alone, whichever the command targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-check-url-child-'))
    for (const directory of ['default', 'child']) mkdirSync(join(root, directory))
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'default'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_NETWORK_ALLOW: '*.example.com' })
    const policy = emptyWorkspacePolicy()
    policy.network.allow = ['api.example.com', 'other.org']
    await registerWorkspace(await workspacesOf(config), { id: 'child', name: 'Child', dir: join(root, 'child'), policy })

    expect(await check(config, 'api.example.com', '--workspace', 'child')).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('(approved list entry api.example.com)') })
    expect((await check(config, 'other.org', '--workspace', 'child')).exitCode).toBe(0)
    expect((await check(config, 'docs.example.com', '--workspace', 'child')).exitCode).toBe(1)
    expect((await check(config, 'docs.example.com')).exitCode).toBe(0)
    expect((await check(config, 'other.org', '--dir', join(root, 'child'))).exitCode).toBe(0)
  }, 30_000)

  it('exits 2 for a workspace this node does not know', async () => {
    expect(await check(node(), 'example.com', '--workspace', 'nope')).toMatchObject({ exitCode: 2 })
  })

  it('exits 2 when the workspace settings cannot be read, rather than reading as a denial', async () => {
    const config = node()
    await workspacesOf(config)
    writeFileSync(settingsPath(config.nodeStateDirectory!, config.workspaceId), '{ not json')

    expect(await check(config, 'example.com')).toMatchObject({ exitCode: 2, stdout: '', stderr: expect.stringContaining('Cannot read this node\'s policy or state, so there is no verdict') })
  })

  it('exits 2 when a registered workspace fails to open for any reason', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const result = await checkUrlCommand({ argv: ['example.com'], runtime: () => Promise.reject(new Error('disk unreadable')) })
      expect(result.exitCode).toBe(2)
      expect(err).toHaveBeenCalledWith('Cannot open the workspace: disk unreadable\n')
    } finally {
      err.mockRestore()
    }
  })

  it('names the pattern that decided when an approval was widened to one', async () => {
    const config = node()
    await grants(config).grant({ sessionId: 'chat-1', rule: 'network_egress', subject: '*.localhost', scope: 'always', pattern: true })

    expect(await check(config, 'http://api.app.localhost:5173')).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('(persisted approval for pattern *.localhost, which covers api.app.localhost:5173)') })
    expect(await check(config, 'http://localhost:3000')).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('pattern *.localhost') })
    expect((await check(config, 'http://127.0.0.1:3000')).exitCode).toBe(3)
  })

  it('denies what the approved list leaves off, whatever pattern grant is recorded', async () => {
    const config = node({ BUCKLE_NETWORK_ALLOW: 'example.com' })
    await grants(config).grant({ sessionId: 'chat-1', rule: 'network_egress', subject: '*.localhost', scope: 'always', pattern: true })

    expect(await check(config, 'http://app.localhost:3000')).toMatchObject({ exitCode: 1, stdout: expect.stringContaining('not on the workspace\'s approved list') })
  })

  it('denies what a registered workspace\'s own list leaves off, whatever pattern grant it holds', async () => {
    const withGrant = async (network: string[]) => {
      const root = mkdtempSync(join(tmpdir(), 'buckle-check-url-limit-'))
      for (const directory of ['default', 'child']) mkdirSync(join(root, directory))
      // Owner-only, as the node requires of a directory holding workspace credentials.
      mkdirSync(join(root, 'state'), { mode: 0o700 })
      const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'default'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false' })
      const policy = emptyWorkspacePolicy()
      policy.network.allow = network
      const manager = await workspacesOf(config)
      await registerWorkspace(manager, { id: 'child', name: 'Child', dir: join(root, 'child'), policy })
      const childId = idOf(manager, 'child')
      const childState = join(realpathSync(join(root, 'state')), 'workspaces', childId)
      mkdirSync(childState, { recursive: true })
      await createFileGrantStore({ filePath: join(childState, 'grants.json'), workspace: childId }).grant({ sessionId: 'chat-1', rule: 'network_egress', subject: '*.localhost', scope: 'always', pattern: true })
      return config
    }

    // Without a list the child's own pattern grant decides, so the refusal below is the list's.
    expect((await check(await withGrant([]), 'http://app.localhost:3000', '--workspace', 'child')).exitCode).toBe(0)
    expect(await check(await withGrant(['example.com']), 'http://app.localhost:3000', '--workspace', 'child')).toMatchObject({ exitCode: 1, stdout: expect.stringContaining('approved list') })
  }, 30_000)

  it('approves a host a wildcard entry covers, naming the entry, and says it clears no private address', async () => {
    const config = node({ BUCKLE_ALLOWED_HOSTS: '*.internal.test' })

    expect(await check(config, 'http://nas.lab.internal.test/status')).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('(approved list entry *.internal.test; a wildcard entry clears no private address, so web_fetch refuses this host where it resolves into a private range)') })
    expect(await check(config, 'http://internal.test/')).toMatchObject({ exitCode: 0 })
    expect((await check(config, 'http://other.test/')).exitCode).toBe(1)
  })
})
