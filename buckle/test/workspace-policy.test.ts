import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyWorkspacePolicy, type WorkspacePolicy } from '@5straps/protocol'
import { configFromEnvironment } from './support/workspace-config.js'
import type { ToolEffect } from '../common/domain/effect.js'
import { createWebPack } from '../common/services/packs/web/index.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { createMcpServer } from '../mcp/server.js'
import { byName, registerWorkspace, workspacesOf } from './support/workspaces.js'

// D83 addendum (7), and D85, Q14 ("Fallback plus node deny floor"): every list is bound to a workspace; where a workspace
// has no allow-type list of its own the node's stands for it, whole, and the node's deny-type lists apply on top of
// every workspace's. No workspace setting lifts them; the dangerously-allow switch, the owner's own decision to answer
// every ask in the workspace, answers the node's destructive asks too, and the node's denials still refuse under it.

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

/** A registered workspace with `child` as its policy, on a node whose environment names `environment`. */
async function workspace(child: WorkspacePolicy = policy(), environment: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-workspace-policy-'))
  roots.push(root)
  for (const directory of ['default', 'child']) mkdirSync(join(root, directory))
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'default'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_APPROVAL_TIMEOUT_MS: '1', ...environment })
  const manager = await workspacesOf(config)
  await registerWorkspace(manager, { id: 'child', name: 'Child', dir: join(root, 'child'), policy: child })
  return (await byName(manager, 'child')).runtime
}

// Keep the real invocation permission pipeline; a prepared effect avoids launching host tools.
async function effect(runtime: BuckleRuntime, value: ToolEffect) {
  const execute = vi.fn(async () => 'executed')
  const prepare = vi.spyOn(runtime.registry().get('fs_read'), 'prepare').mockReturnValue({ effects: [value], execute })
  const result = await runtime.invoke({ request: { requestId: `policy-${randomUUID()}`, approvalTokens: [], tool: 'fs_read', args: { path: '/workspace/file.txt' } }, sessionId: 'policy-session' })
  prepare.mockRestore()
  return { result, execute }
}

const command = (name: string, args: string[] = ['build']): ToolEffect => ({ kind: 'exec', command: name, args })

describe('a registered workspace\'s policy over the node\'s lists', () => {
  it('uses the node\'s command allow list where it has none of its own', async () => {
    const runtime = await workspace(policy(), { BUCKLE_COMMAND_ALLOW: 'pnpm *' })
    expect((await effect(runtime, command('pnpm'))).execute).toHaveBeenCalledOnce()
    const refused = await effect(runtime, command('make'))
    expect(refused.execute).not.toHaveBeenCalled()
    expect(refused.result).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Not on the workspace command allow list. Allowed: pnpm *') } })
  })

  it('uses its own command allow list alone where it has one, and the node\'s again once its own is emptied', async () => {
    const runtime = await workspace(policy({ allow: ['git *'] }), { BUCKLE_COMMAND_ALLOW: 'pnpm *' })
    expect((await effect(runtime, command('git'))).execute).toHaveBeenCalledOnce()
    expect((await effect(runtime, command('pnpm'))).execute).not.toHaveBeenCalled()
    await runtime.policy.clear()
    expect((await effect(runtime, command('pnpm'))).execute).toHaveBeenCalledOnce()
    expect((await effect(runtime, command('git'))).execute).not.toHaveBeenCalled()
  })

  it('refuses a command the node\'s deny list names though its own allow list names it, and keeps the floor through clear and the dangerously-allow switch', async () => {
    const runtime = await workspace(policy({ allow: ['curl *', 'pnpm *'] }), { BUCKLE_COMMAND_DENY: 'curl' })
    const refused = await effect(runtime, command('curl', ['https://example.com']))
    expect(refused.execute).not.toHaveBeenCalled()
    expect(refused.result).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: 'Refused by the workspace command policy: curl' } })
    expect((await effect(runtime, command('pnpm'))).execute).toHaveBeenCalledOnce()
    await runtime.policy.clear()
    await runtime.policy.setDangerouslyAllow(true)
    expect((await effect(runtime, command('curl'))).execute).not.toHaveBeenCalled()
    expect(runtime.policy.effective().commands.deny).toEqual(['curl'])
    expect(runtime.policy.stored().commands.deny).toEqual([])
  })

  it('asks before a command the node\'s destructive list names, though its own allow list admits it', async () => {
    const runtime = await workspace(policy({ allow: ['make *'] }), { BUCKLE_COMMAND_DESTRUCTIVE: 'make deploy*' })
    const asked = await effect(runtime, command('make', ['deploy']))
    expect(asked.result.outcome).toBe('approval_required')
    expect(asked.execute).not.toHaveBeenCalled()
    expect((await effect(runtime, command('make', ['build']))).execute).toHaveBeenCalledOnce()
  })

  // Fix brief 4, findings 14 and 24: the pages said no switch lifts the node's destructive list, and the switch answers its asks.
  it('answers a command the node\'s destructive list names once the dangerously-allow switch is on, and still refuses one its deny list names', async () => {
    const runtime = await workspace(policy({ allow: ['make *', 'curl *'] }), { BUCKLE_COMMAND_DESTRUCTIVE: 'make deploy*', BUCKLE_COMMAND_DENY: 'curl' })
    expect((await effect(runtime, command('make', ['deploy']))).result.outcome).toBe('approval_required')
    await runtime.policy.setDangerouslyAllow(true)

    const answered = await effect(runtime, command('make', ['deploy']))
    expect(answered.result.outcome).toBe('ok')
    expect(answered.execute).toHaveBeenCalledOnce()
    const refused = await effect(runtime, command('curl', ['https://example.com']))
    expect(refused.execute).not.toHaveBeenCalled()
    expect(refused.result).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
  })

  it('uses the node\'s approved URLs and interpreters where it has none of its own, and its own alone where it has them', async () => {
    const inherits = await workspace(policy(), { BUCKLE_NETWORK_ALLOW: 'https://node.test', BUCKLE_ALLOWED_INTERPRETERS: 'node' })
    expect(inherits.policy.effective()).toMatchObject({ network: { allow: ['https://node.test'] }, commands: { allowedInterpreters: ['node'] } })
    const own = await workspace({ ...policy({ network: ['https://own.test'] }), commands: { allow: [], deny: [], allowedInterpreters: ['python3'] } }, { BUCKLE_NETWORK_ALLOW: 'https://node.test', BUCKLE_ALLOWED_INTERPRETERS: 'node' })
    expect(own.policy.effective()).toMatchObject({ network: { allow: ['https://own.test'] }, commands: { allowedInterpreters: ['python3'] } })
  })

  it('keeps its own denials and destructive asks even with an allow-all', async () => {
    const runtime = await workspace(policy({ deny: ['curl'], destructive: ['terraform destroy *'] }))
    await runtime.policy.apply(policy({ allow: ['*'], deny: ['curl'], destructive: ['terraform destroy *'] }))
    expect((await effect(runtime, command('curl'))).execute).not.toHaveBeenCalled()
    const destructive = await effect(runtime, command('terraform', ['destroy']))
    expect(destructive.result.outcome).toBe('approval_required')
    expect(destructive.execute).not.toHaveBeenCalled()
  })

  // Where the folder shows is the mount table's, which the owner's CLI alone changes: a policy written through the
  // setup face or `buckle policy import` cannot unmount or move it.
  it('keeps its mount when a written policy tries to remove or replace it', async () => {
    const runtime = await workspace()
    await runtime.policy.apply({ ...policy(), mount: null })
    expect(runtime.paths().displayRoot).toBe('/workspace')
    await runtime.policy.apply({ ...policy(), mount: '/different' })
    expect(runtime.paths().displayRoot).toBe('/workspace')
    await runtime.policy.setMount('/project')
    expect(runtime.paths().displayRoot).toBe('/project')
  })

  it('blocks initial and redirected network calls outside its own list', async () => {
    const runtime = await workspace(policy({ network: ['https://node.test/safe'] }), { BUCKLE_NETWORK_ALLOW: 'https://other.test' })
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
  })
})

it('rejects automatic search redirects instead of forwarding its configured API key', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ web: { results: [] } })))
  vi.stubGlobal('fetch', fetchMock)
  const search = createWebPack({ braveSearchApiKey: 'fixture-only-search-key', allowedHosts: [], approved: null }).tools.find(tool => tool.capability.name === 'web_search')!
  await search.prepare({ query: 'test' }).execute({ requestId: 'search', sessionId: 'search', timeoutMs: 1000, signal: AbortSignal.timeout(1000) })
  expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'error' }))
})

it('keeps its tool denials across policy replacement and exposes disabled installed tools for setup', async () => {
  const runtime = await workspace({ ...policy(), tools: { allow: ['fs_read'], deny: ['fs_write'] } })
  expect(runtime.manifest().tools.map(tool => tool.name)).toEqual(['fs_read'])
  expect(runtime.toolCatalog().tools.some(tool => tool.name === 'fs_write')).toBe(true)
  expect(runtime.toolCatalog().unavailable.some(tool => tool.name === 'fs_write')).toBe(true)
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
