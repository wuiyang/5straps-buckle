import { CLIENT_CAPABILITIES_META_KEY, type ServerContext } from '@modelcontextprotocol/server'
import { createMcpServer } from '../mcp/server.js'
import { isExplicitCancel } from '../mcp/stdio.js'
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/server'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { APPROVAL_NO_DEADLINE } from '@5straps/protocol'
import { parseApprovalTimeout } from '../common/runtime/config.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createApprovalService } from '../common/services/approvals/approval-service.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction } from './support/interaction.js'
import type { ApprovalAskInput } from '../common/services/approvals/approval-service.js'

type Ask = ApprovalAskInput['asks'][number]
import { describeExpiry, remainingMs } from '../common/domain/approval-deadline.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'

const recorded = { arguments: { path: '/synthetic', content: 'x' }, cwd: '/workspace', description: null, effects: ['write /synthetic'], complete: true as const }
const roots: string[] = []
function directory() { const root = mkdtempSync(join(tmpdir(), 'approval-wait-')); roots.push(root); return root }
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
// A node entry point with nobody at its terminal: the call is held for the configured grace period.
async function fixture(timeoutMs: number | null) {
  const root = directory()
  const approvals = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root }), join(root, 'approvals.json'), root, timeoutMs)
  const service = createApprovalService({ registry: approvals, workspaceId: 'default', serverId: 'test-node', graceMs: timeoutMs, interaction: fixedInteraction() })
  const ask: Ask = { kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: root, reason: 'test write', offeredScopes: ['once'] }
  const request = (asks: Ask[] = [ask]) => service.request({ sessionId: 'test', requestId: `request-${asks.length}`, tool: 'fs_write', call: recorded, asks })
  return { approvals, service, request }
}
it.each(['-1', '60000ms', 'Infinity', '2147483648', '1.5'])('rejects invalid wait %s', value => {
  expect(() => parseApprovalTimeout(value, 15_000)).toThrow()
})
it('accepts a minute, and 0 for a wait with no deadline', () => {
  expect(parseApprovalTimeout('60000', 15_000)).toBe(60_000)
  // Owner ruling of 2026-09-28: 0 holds a call until someone answers.
  expect(parseApprovalTimeout('0', 15_000)).toBeNull()
})
it('refuses the old forever spelling, naming 0 (ruling 2: one spelling)', () => {
  expect(() => parseApprovalTimeout('forever', 15_000)).toThrow('use 0 to wait until someone answers')
})
it('holds for one minute, then leaves the question answerable', async () => {
  vi.useFakeTimers()
  const { request, approvals } = await fixture(60_000)
  let settled = false
  const waiting = request().then(result => { settled = true; return result })
  await vi.advanceTimersByTimeAsync(59_999)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(await waiting).toMatchObject({ settled: false })
  expect(approvals.pending()).toHaveLength(1)
})
it.each([true, false])('waits beyond ten minutes until an owner answers approved=%s', async approved => {
  vi.useFakeTimers()
  const { request, approvals } = await fixture(null)
  let settled = false
  const waiting = request().then(result => { settled = true; return result })
  await vi.advanceTimersByTimeAsync(11 * 60_000)
  expect(settled).toBe(false)
  expect(approvals.pending()[0]?.expiresAt).toBe(APPROVAL_NO_DEADLINE)
  // Another route (buckle approve, /setup/approvals in another process) answers the durable queue.
  expect((await approvals.resolve({ token: approvals.pending()[0]!.token, approved, scope: 'once' }, 'cli')).ok).toBe(true)
  await vi.advanceTimersByTimeAsync(400)
  expect(await waiting).toMatchObject({ settled: true })
  expect(vi.getTimerCount()).toBe(0)
})
it('does not give an answered once grant an indefinite lifetime', async () => {
  vi.useFakeTimers()
  const { approvals } = await fixture(null)
  const requests = (await approvals.ask({ call: recorded, tool: 'fs_write', sessionId: 'test', asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: '/synthetic', reason: 'test write', offeredScopes: ['once'] }] })).requests
  await approvals.resolve({ token: requests[0]!.token, approved: true, scope: 'once' }, 'cli')
  expect(approvals.unspent('test')).toHaveLength(1)
  vi.advanceTimersByTime(10 * 60_000 + 1)
  expect(approvals.unspent('test')).toHaveLength(0)
})
it('represents indefinite questions without overflowing terminal timers', () => {
  expect(remainingMs(APPROVAL_NO_DEADLINE)).toBe(Infinity)
  expect(describeExpiry(APPROVAL_NO_DEADLINE)).toContain('no expiry')
})
it.each([
  ['an explicit cancel removes its pending approval', true, 0],
  ['a dropped transport keeps its pending approval (owner decision D4)', false, 1],
] as const)('ends a waiting invocation on its caller\'s abort, never writes, and %s', async (_, cancel, pending) => {
  const root = directory()
  mkdirSync(join(root, 'workspace'))
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '0' })
  const runtime = await createRuntime({ config, interaction: fixedInteraction() })
  const controller = new AbortController()
  const result = runtime.invoke({ sessionId: 'cancel-test', signal: controller.signal, ...(cancel ? { isCancel: () => true } : {}), request: { requestId: 'cancel-write', tool: 'fs_write', args: { path: 'probe.txt', content: 'must not land' }, approvalTokens: [] } })
  await vi.waitFor(() => expect(runtime.approvals.pending()).toHaveLength(1))
  controller.abort()
  expect((await result).outcome).toBe('error')
  expect(runtime.approvals.pending()).toHaveLength(pending)
  expect(existsSync(join(config.cwd, 'probe.txt'))).toBe(false)
  await runtime.approvalService.close()
})

it.each([true, false])('finishes the same MCP call after owner decision approved=%s', async approved => {
  const { runtime, call } = await mcpFixture()
  const waiting = call(new AbortController().signal)
  await vi.waitFor(() => expect(runtime.approvals.pending()).toHaveLength(1))
  const request = runtime.approvals.pending()[0]!
  expect((await runtime.approvals.resolve({ token: request.token, approved, scope: 'once' }, 'cli')).ok).toBe(true)
  const result = await waiting
  expect(Boolean(result.isError)).toBe(!approved)
  expect(existsSync(join(runtime.paths().root, 'probe.txt'))).toBe(approved)
})
it('propagates MCP stdio cancellation without executing the pending write, and withdraws the ask', async () => {
  const { runtime, call } = await mcpFixture(false, isExplicitCancel)
  const controller = new AbortController()
  const waiting = call(controller.signal)
  await vi.waitFor(() => expect(runtime.approvals.pending()).toHaveLength(1))
  // notifications/cancelled: the SDK aborts with the client's reason.
  controller.abort('user stopped the call')
  expect((await waiting).isError).toBe(true)
  expect(runtime.approvals.pending()).toHaveLength(0)
  expect(existsSync(join(runtime.paths().root, 'probe.txt'))).toBe(false)
})
it.each([
  ['stdio, when the connection closes', isExplicitCancel, new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed')],
  ['HTTP, which cannot tell a cancel from a dropped socket', undefined, 'user stopped the call'],
] as const)('keeps the ask of an MCP call over %s, and writes nothing (owner decision D4)', async (_, isCancel, reason) => {
  const { runtime, call } = await mcpFixture(false, isCancel)
  const controller = new AbortController()
  const waiting = call(controller.signal)
  await vi.waitFor(() => expect(runtime.approvals.pending()).toHaveLength(1))
  controller.abort(reason)
  expect((await waiting).isError).toBe(true)
  expect(runtime.approvals.pending()).toHaveLength(1)
  expect(existsSync(join(runtime.paths().root, 'probe.txt'))).toBe(false)
  await runtime.approvalService.close()
})
it('offers native elicitation immediately even when the node waits until answered', async () => {
  const { call } = await mcpFixture(true)
  expect(await call(new AbortController().signal)).toMatchObject({ resultType: 'input_required' })
})

async function mcpFixture(nativePrompt = false, isCancel?: (reason: unknown) => boolean) {
  const root = directory()
  mkdirSync(join(root, 'workspace'))
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '0' })
  const runtime = await createRuntime({ config, interaction: fixedInteraction() })
  const server = createMcpServer({ runtime, serverName: 'wait-test', version: '1', trustedApprovalResponses: nativePrompt, ...(isCancel ? { isCancel } : {}) })
  // The SDK does not expose handlers publicly; exercise its registered callback with a request context.
  const registered = (server as unknown as { _registeredTools: Record<string, { handler(args: unknown, context: ServerContext): Promise<{ isError?: boolean }> }> })._registeredTools
  return { runtime, call: (signal: AbortSignal) => registered.fs_write!.handler({ path: 'probe.txt', content: 'approved' }, {
    sessionId: 'mcp-wait-test', mcpReq: { signal, envelope: nativePrompt ? { [CLIENT_CAPABILITIES_META_KEY]: { elicitation: {} } } : undefined },
  } as unknown as ServerContext) }
}

it('ends a wait with no deadline when one of several gates is denied', async () => {
  vi.useFakeTimers()
  const { approvals, request } = await fixture(null)
  const waiting = request([
    { kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: '/synthetic-directory', reason: 'first gate', offeredScopes: ['once'] },
    { kind: 'ask', ...PLAIN_MARKS, rule: 'sensitive_path', subject: '/synthetic', reason: 'second gate', offeredScopes: ['once'] },
  ])
  await vi.advanceTimersByTimeAsync(10)
  await approvals.resolve({ token: approvals.pending()[0]!.token, approved: false, scope: 'once' }, 'cli')
  await vi.advanceTimersByTimeAsync(400)
  expect(await waiting).toMatchObject({ settled: true })
  expect(approvals.pending()).toHaveLength(1)
})
