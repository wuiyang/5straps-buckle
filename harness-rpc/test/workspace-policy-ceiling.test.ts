import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyWorkspacePolicy, type WorkspacePolicy } from '@5straps/protocol'
import { loadConfig } from '../common/runtime/config.js'
import type { ToolEffect } from '../common/domain/effect.js'
import { createWebPack } from '../common/services/packs/web/index.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { createWorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { createMcpServer } from '../mcp/server.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function policy(input: { allow?: string[]; deny?: string[]; destructive?: string[]; network?: string[] } = {}): WorkspacePolicy {
  const value = emptyWorkspacePolicy()
  value.commands.allow = input.allow ?? []
  value.commands.deny = input.deny ?? []
  value.commands.destructive = input.destructive ?? []
  value.network.allow = input.network ?? []
  return value
}

async function workspace(node: WorkspacePolicy, child: WorkspacePolicy = policy()) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-ceiling-'))
  roots.push(root)
  for (const directory of ['default', 'child']) mkdirSync(join(root, directory))
  const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: join(root, 'default'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_APPROVAL_TIMEOUT_MS: '0' })
  config.policy = node
  const runtime = await createRuntime({ config })
  const manager = createWorkspaceManager({ config, runtime })
  await manager.register({ id: 'child', name: 'Child', root: join(root, 'child'), authToken: 'child-agent-token-fixture-only', adminToken: 'child-setup-token-fixture-only', policy: child })
  return (await manager.resolve('child')).runtime
}

// Keep the real invocation permission pipeline; a prepared effect avoids launching host tools.
async function effect(runtime: BuckleRuntime, value: ToolEffect) {
  const execute = vi.fn(async () => 'executed')
  const prepare = vi.spyOn(runtime.registry().get('fs_read'), 'prepare').mockReturnValue({ effects: [value], execute })
  const result = await runtime.invoke({ request: { requestId: `ceiling-${randomUUID()}`, approvalTokens: [], tool: 'fs_read', args: { path: '/workspace/file.txt' } }, sessionId: 'ceiling-session' })
  prepare.mockRestore()
  return { result, execute }
}

const command = (name: string, args: string[] = ['build']): ToolEffect => ({ kind: 'exec', command: name, args })

describe('immutable installation policy on child workspaces', () => {
  it('intersects command allow lists at registration and after replacement or clear', async () => {
    const runtime = await workspace(policy({ allow: ['pnpm *'] }), policy({ allow: ['pnpm build', 'curl *'] }))
    expect((await effect(runtime, command('pnpm'))).execute).toHaveBeenCalledOnce()
    expect((await effect(runtime, command('curl'))).result.outcome).toBe('error')
    expect((await effect(runtime, command('pnpm', ['test']))).execute).not.toHaveBeenCalled()
    await runtime.policy.apply(policy({ allow: ['curl *'] }))
    expect((await effect(runtime, command('curl'))).execute).not.toHaveBeenCalled()
    expect((await effect(runtime, command('pnpm'))).execute).not.toHaveBeenCalled()
    await runtime.policy.clear()
    expect((await effect(runtime, command('pnpm'))).execute).toHaveBeenCalledOnce()
    expect((await effect(runtime, command('curl'))).execute).not.toHaveBeenCalled()
  })

  it('retains node denials and destructive approval even with child allow-all', async () => {
    const runtime = await workspace(policy({ deny: ['curl'], destructive: ['terraform destroy *'] }))
    await runtime.policy.apply(policy({ allow: ['*'] }))
    expect((await effect(runtime, command('curl'))).execute).not.toHaveBeenCalled()
    const destructive = await effect(runtime, command('terraform', ['destroy']))
    expect(destructive.result.outcome).toBe('approval_required')
    expect(destructive.execute).not.toHaveBeenCalled()
  })

  it.each(['node', 'child'] as const)('allows explicitly approved wrappers in the %s policy when the other layer has no allow list', async source => {
    const wrapper = policy({ allow: ['bash -c *'] })
    const runtime = await workspace(source === 'node' ? wrapper : policy(), source === 'child' ? wrapper : policy())
    expect((await effect(runtime, command('bash', ['-c', 'echo hello']))).execute).toHaveBeenCalledOnce()
    await runtime.policy.apply(policy({ allow: ['pnpm *'] }))
    expect((await effect(runtime, command('bash', ['-c', 'echo hello']))).execute).not.toHaveBeenCalled()
  })

  it('keeps the managed filesystem mount when child setup tries to remove or replace it', async () => {
    const runtime = await workspace(policy())
    await runtime.policy.apply({ ...policy(), mount: null })
    expect(runtime.paths().displayRoot).toBe('/workspace')
    await runtime.policy.apply({ ...policy(), mount: '/different' })
    expect(runtime.paths().displayRoot).toBe('/workspace')
  })

  it('blocks initial and redirected network calls outside either allow list', async () => {
    const runtime = await workspace(policy({ network: ['https://node.test/safe'] }), policy({ network: ['https://node.test', 'https://other.test'] }))
    const fetchMock = vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://node.test/outside' } }))
    vi.stubGlobal('fetch', fetchMock)
    const invoke = (url: string) => runtime.invoke({ request: { requestId: `fetch-${randomUUID()}`, approvalTokens: [], tool: 'web_fetch', args: { url } }, sessionId: 'network-session' })
    expect((await invoke('https://other.test')).outcome).toBe('error')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await invoke('https://node.test/safe')).toMatchObject({ outcome: 'error', error: { code: 'EGRESS_BLOCKED' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockClear()
    await runtime.policy.apply(policy({ network: ['https://node.test/safe/narrow'] }))
    expect((await invoke('https://node.test/safe')).outcome).toBe('error')
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockImplementation(async () => new Response('ok'))
    expect((await invoke('https://node.test/safe/narrow')).outcome).toBe('ok')
    await runtime.policy.apply(policy())
    expect((await invoke('https://other.test')).outcome).toBe('error')
  })
})

it('rejects automatic search redirects instead of forwarding its configured API key', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ web: { results: [] } })))
  vi.stubGlobal('fetch', fetchMock)
  const search = createWebPack({ braveSearchApiKey: 'fixture-only-search-key', allowedHosts: [], approved: null }).tools.find(tool => tool.capability.name === 'web_search')!
  await search.prepare({ query: 'test' }).execute({ requestId: 'search', sessionId: 'search', timeoutMs: 1000, signal: AbortSignal.timeout(1000) })
  expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'error' }))
})

it('keeps node tool denials across child policy replacement and exposes disabled installed tools for setup', async () => {
  const node = { ...policy(), tools: { allow: ['fs_read'], deny: ['fs_write'] } }
  const child = { ...policy(), tools: { allow: ['fs_read', 'fs_write'], deny: [] } }
  const runtime = await workspace(node, child)
  expect(runtime.manifest().tools.map(tool => tool.name)).toEqual(['fs_read'])
  expect(runtime.toolCatalog().tools.some(tool => tool.name === 'fs_write')).toBe(true)
  expect(runtime.toolCatalog().unavailable.some(tool => tool.name === 'fs_write')).toBe(true)
  await runtime.policy.apply(policy())
  expect(runtime.manifest().tools.map(tool => tool.name)).toEqual(['fs_read'])
  const prepare = vi.spyOn(runtime.registry().get('fs_write'), 'prepare')
  const result = await runtime.invoke({ request: { requestId: 'denied-tool', tool: 'fs_write', args: { path: 'test.txt', content: 'blocked' }, approvalTokens: [] }, sessionId: 'tool-policy' })
  expect(result.outcome).toBe('error')
  expect(prepare).not.toHaveBeenCalled()
  await runtime.policy.apply({ ...policy(), tools: { allow: [], deny: [] } })
  expect(runtime.manifest().tools).toEqual([])
})

it('refreshes MCP registrations when a workspace disables and re-enables tools', async () => {
  const runtime = await workspace(policy())
  const server = createMcpServer({ runtime, serverName: 'policy-test', version: '1.0.0' })
  const names = () => Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)
  expect(names()).toContain('fs_read')
  await runtime.policy.apply({ ...policy(), tools: { allow: [], deny: [] } })
  expect(names()).toEqual([])
  await runtime.policy.clear()
  expect(names()).toContain('fs_read')
  await server.close()
})
