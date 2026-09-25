import { CLIENT_CAPABILITIES_META_KEY, type ServerContext } from '@modelcontextprotocol/server'
import { createMcpServer } from '../src/faces/mcp/server.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { APPROVAL_NO_DEADLINE } from '@5straps/protocol'
import { loadConfig, parseApprovalTimeout } from '../src/config.js'
import { createFileGrantStore } from '../src/adapters/grant-store/file-grant-store.js'
import { createWaitingApprovalChannel } from '../src/adapters/approval/waiting-approval-channel.js'
import { createApprovalRegistry } from '../src/services/approval-registry.js'
import { createApprovalDelivery } from '../src/services/approval-delivery.js'
import { createRuntime } from '../src/runtime.js'
import { describeExpiry, remainingMs } from '../src/domain/approval-deadline.js'

const roots: string[] = []
function directory() { const root = mkdtempSync(join(tmpdir(), 'approval-wait-')); roots.push(root); return root }
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(timeoutMs: number | null) {
  const root = directory()
  const approvals = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root }), join(root, 'approvals.json'), root, timeoutMs)
  const requests = approvals.issue({ tool: 'fs_write', sessionId: 'test', asks: [{ kind: 'ask', rule: 'write_scope', subject: root, reason: 'test write', offeredScopes: ['once'] }] })
  return { approvals, requests, channel: createWaitingApprovalChannel({ approvals, timeoutMs }) }
}
it.each(['-1', '60000ms', 'Infinity', '2147483648', '1.5'])('rejects invalid wait %s', value => {
  expect(() => parseApprovalTimeout(value, 15_000)).toThrow()
})
it('accepts a minute, forever and immediate fallback', () => {
  expect(parseApprovalTimeout('60000', 15_000)).toBe(60_000)
  expect(parseApprovalTimeout('forever', 15_000)).toBeNull()
  expect(parseApprovalTimeout('0', 15_000)).toBe(0)
})
it('holds for one minute, then leaves the question answerable', async () => {
  vi.useFakeTimers()
  const { channel, requests, approvals } = fixture(60_000)
  let settled = false
  const waiting = channel.request(requests).then(result => { settled = true; return result })
  await vi.advanceTimersByTimeAsync(59_999)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(await waiting).toBeNull()
  expect(approvals.pending()).toHaveLength(1)
})
it.each([true, false])('waits beyond ten minutes until an owner answers approved=%s', async approved => {
  vi.useFakeTimers()
  const { channel, requests, approvals } = fixture(null)
  let settled = false
  const waiting = channel.request(requests).then(result => { settled = true; return result })
  await vi.advanceTimersByTimeAsync(11 * 60_000)
  expect(settled).toBe(false)
  expect(approvals.pending()[0]?.expiresAt).toBe(APPROVAL_NO_DEADLINE)
  expect(approvals.resolve({ token: requests[0]!.token, approved, scope: 'once' }).ok).toBe(true)
  await vi.advanceTimersByTimeAsync(400)
  expect(await waiting).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
})
it('does not give an answered once grant an indefinite lifetime', () => {
  vi.useFakeTimers()
  const { requests, approvals } = fixture(null)
  approvals.resolve({ token: requests[0]!.token, approved: true, scope: 'once' })
  expect(approvals.unspent('test')).toHaveLength(1)
  vi.advanceTimersByTime(10 * 60_000 + 1)
  expect(approvals.unspent('test')).toHaveLength(0)
})
it('represents indefinite questions without overflowing terminal timers', () => {
  expect(remainingMs(APPROVAL_NO_DEADLINE)).toBe(Infinity)
  expect(describeExpiry(APPROVAL_NO_DEADLINE)).toContain('no expiry')
})
it('cancels a waiting invocation, removes its pending approval and never writes', async () => {
  const root = directory()
  mkdirSync(join(root, 'workspace'))
  const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: 'forever' })
  const runtime = await createRuntime({ config, channel: approvals => createApprovalDelivery({ config, approvals, workspaceId: 'default', prompt: false }) })
  const controller = new AbortController()
  const result = runtime.invoke({ sessionId: 'cancel-test', signal: controller.signal, request: { requestId: 'cancel-write', tool: 'fs_write', args: { path: 'probe.txt', content: 'must not land' }, approvalTokens: [] } })
  await vi.waitFor(() => expect(runtime.approvals.pending()).toHaveLength(1))
  controller.abort()
  expect((await result).outcome).toBe('error')
  expect(runtime.approvals.pending()).toEqual([])
  expect(existsSync(join(config.cwd, 'probe.txt'))).toBe(false)
})

it.each([true, false])('finishes the same MCP call after owner decision approved=%s', async approved => {
  const { runtime, call } = await mcpFixture()
  const waiting = call(new AbortController().signal)
  await vi.waitFor(() => expect(runtime.approvals.pending()).toHaveLength(1))
  const request = runtime.approvals.pending()[0]!
  expect(runtime.approvals.resolve({ token: request.token, approved, scope: 'once' }).ok).toBe(true)
  const result = await waiting
  expect(Boolean(result.isError)).toBe(!approved)
  expect(existsSync(join(runtime.paths().root, 'probe.txt'))).toBe(approved)
})
it('propagates MCP cancellation without executing the pending write', async () => {
  const { runtime, call } = await mcpFixture()
  const controller = new AbortController()
  const waiting = call(controller.signal)
  await vi.waitFor(() => expect(runtime.approvals.pending()).toHaveLength(1))
  controller.abort()
  expect((await waiting).isError).toBe(true)
  expect(runtime.approvals.pending()).toHaveLength(0)
  expect(existsSync(join(runtime.paths().root, 'probe.txt'))).toBe(false)
})
it('offers native elicitation immediately even when external approval wait is forever', async () => {
  const { call } = await mcpFixture(true)
  expect(await call(new AbortController().signal)).toMatchObject({ resultType: 'input_required' })
})

async function mcpFixture(nativePrompt = false) {
  const root = directory()
  mkdirSync(join(root, 'workspace'))
  const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: 'forever' })
  const runtime = await createRuntime({ config, channel: approvals => createApprovalDelivery({ config, approvals, workspaceId: 'default', prompt: false }) })
  const server = createMcpServer({ runtime, serverName: 'wait-test', version: '1', trustedApprovalResponses: nativePrompt })
  // The SDK does not expose handlers publicly; exercise its registered callback with a request context.
  const registered = (server as unknown as { _registeredTools: Record<string, { handler(args: unknown, context: ServerContext): Promise<{ isError?: boolean }> }> })._registeredTools
  return { runtime, call: (signal: AbortSignal) => registered.fs_write!.handler({ path: 'probe.txt', content: 'approved' }, {
    sessionId: 'mcp-wait-test', mcpReq: { signal, envelope: nativePrompt ? { [CLIENT_CAPABILITIES_META_KEY]: { elicitation: {} } } : undefined },
  } as unknown as ServerContext) }
}

it('ends a forever wait when one of several gates is denied', async () => {
  vi.useFakeTimers()
  const { approvals, requests, channel } = fixture(null)
  requests.push(...approvals.issue({ tool: 'fs_write', sessionId: 'test', asks: [{ kind: 'ask', rule: 'sensitive_path', subject: '/synthetic', reason: 'second gate', offeredScopes: ['once'] }] }))
  const waiting = channel.request(requests)
  approvals.resolve({ token: requests[0]!.token, approved: false, scope: 'once' })
  await vi.advanceTimersByTimeAsync(400)
  expect(await waiting).toEqual([])
})
