import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalNotice, ApprovalWait } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { loadConfig, type BuckleConfig } from '../common/runtime/config.js'
import { createApprovalNotices } from '../common/services/approvals/approval-notices.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createApprovalService, type ApprovalAskInput } from '../common/services/approvals/approval-service.js'
import { NO_INTERACTION, type Interaction } from '../common/services/approvals/interaction.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction, headlessGrace } from './support/interaction.js'
import { captureWebhook } from './support/webhook.js'

afterEach(() => { vi.useRealTimers() })

function node(environment: Record<string, string> = {}): BuckleConfig {
  const root = mkdtempSync(join(tmpdir(), 'buckle-notices-'))
  for (const directory of ['workspace', 'workspace/one', 'workspace/two', 'workspace/three']) mkdirSync(join(root, directory))
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  return loadConfig({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: 'notices-agent-token', BUCKLE_ADMIN_TOKEN: 'notices-admin-token', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', ...environment })
}

const write = (path: string, approvalWait?: ApprovalWait) => ({ requestId: `write-${path}`, tool: 'fs_write', args: { path, content: 'x' }, approvalTokens: [], ...(approvalWait ? { context: { approvalWait } } : {}) })

describe('the approval wait hint in InvokeContext', () => {
  it('overrides the node\'s own wait when it is shorter', async () => {
    const runtime = await createRuntime({ config: node({ BUCKLE_APPROVAL_TIMEOUT_MS: '60000' }), interaction: fixedInteraction() })
    let started = performance.now()
    expect(await runtime.invoke({ sessionId: 's', request: write('one/a.md', { mode: 'finite', ms: 150 }) })).toMatchObject({ outcome: 'approval_required' })
    expect(performance.now() - started).toBeGreaterThanOrEqual(140)
    expect(performance.now() - started).toBeLessThan(5_000)
    started = performance.now()
    expect(await runtime.invoke({ sessionId: 's', request: write('two/b.md', { mode: 'none' }) })).toMatchObject({ outcome: 'approval_required' })
    expect(performance.now() - started).toBeLessThan(1_000)
    await runtime.history.close()
  })

  it('overrides it when it is longer too: the caller owns the run, so its wait wins (owner ruling of 2026-09-28)', async () => {
    const runtime = await createRuntime({ config: node({ BUCKLE_APPROVAL_TIMEOUT_MS: '50' }), interaction: fixedInteraction() })
    const started = performance.now()
    expect(await runtime.invoke({ sessionId: 's', request: write('one/a.md', { mode: 'finite', ms: 600 }) })).toMatchObject({ outcome: 'approval_required' })
    expect(performance.now() - started).toBeGreaterThanOrEqual(580)
    expect(performance.now() - started).toBeLessThan(5_000)
    // The ask stays answerable at least as long as the caller was held.
    const [pending] = runtime.approvalService.pending()
    expect(Date.parse(pending!.expiresAt) - Date.now()).toBeGreaterThan(10 * 60_000 - 1_000)
    await runtime.history.close()
  })

  // Over HTTP: test/http/approval-http.test.ts, on the harness.
})

// Lifecycle notices whichever route answered, the setup face among them: test/http/approval-http.test.ts.

describe('the siblings of a denied ask', () => {
  it('are withdrawn through the service, so the webhook hears they were cancelled (review L1)', async () => {
    const webhook = await captureWebhook()
    try {
      const config = node({ BUCKLE_APPROVAL_WEBHOOK: webhook.url, BUCKLE_APPROVAL_TIMEOUT_MS: '60000' })
      const runtime = await createRuntime({ config, interaction: fixedInteraction() })
      const request = { requestId: 'batch-1', tool: 'fs_write_batch', args: { files: [{ path: 'one/a.md', content: 'a' }, { path: 'two/b.md', content: 'b' }] }, approvalTokens: [] }
      const waiting = runtime.invoke({ sessionId: 's', request })
      await vi.waitFor(() => expect(runtime.approvalService.pending()).toHaveLength(2))
      const [denied, sibling] = runtime.approvalService.pending()

      expect((await runtime.approvalService.answer({ decision: { token: denied!.token, approved: false, scope: 'once' }, authority: 'admin' })).ok).toBe(true)
      expect(await waiting).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: 'Approval was declined' } })
      await runtime.approvalService.close()

      expect(runtime.approvalService.pending()).toEqual([])
      expect(webhook.notices.filter(notice => notice.event !== 'skipped').map(notice => [notice.token, notice.event])).toEqual([[denied!.token, 'denied'], [sibling!.token, 'cancelled']])
      await runtime.history.close()
    } finally {
      await webhook.close()
    }
  })
})

function service(input: { graceMs: number | null; interaction?: Interaction }) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-notice-service-'))
  const sent: ApprovalNotice[] = []
  const notices = createApprovalNotices(async batch => { sent.push(...batch) })
  const registry = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root }), join(root, 'approvals.json'), root, input.graceMs, { onExpired: requests => notices.expired(requests) })
  const approvals = createApprovalService({ registry, workspaceId: 'default', graceMs: input.graceMs, interaction: fixedInteraction(input.interaction ?? headlessGrace), notices })
  const ask = (overrides: Partial<ApprovalAskInput> = {}) => approvals.request({ sessionId: 's', requestId: `r-${Math.random()}`, tool: 'fs_write', asks: [{ kind: 'ask', rule: 'write_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once'] }], ...overrides })
  return { registry, approvals, sent, ask, notices }
}

describe('why a call stopped waiting while its ask stays pending', () => {
  it.each([
    ['no_wait', { graceMs: 0 }],
    ['no_approver', { graceMs: 60_000, interaction: NO_INTERACTION }],
    ['wait_elapsed', { graceMs: 100 }],
  ] as const)('says %s', async (reason, input) => {
    const { ask, sent, notices } = service(input)
    const result = await ask()
    await notices.settle()
    expect(sent).toEqual([expect.objectContaining({ token: result.approvals[0]!.token, event: 'skipped', reason })])
  })

  it('says shutdown when the node closes during the wait, and sends it before close returns', async () => {
    const { ask, sent, approvals, registry } = service({ graceMs: null })
    const waiting = ask()
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1))
    await approvals.close()
    expect(sent).toEqual([expect.objectContaining({ event: 'skipped', reason: 'shutdown' })])
    expect(await waiting).toMatchObject({ settled: false })
  })

  it('tells a cancelled ask when its caller leaves inside the wait', async () => {
    const { ask, sent, notices, registry } = service({ graceMs: null })
    const leaving = new AbortController()
    const waiting = ask({ signal: leaving.signal })
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1))
    const [pending] = registry.pending()
    leaving.abort()
    await expect(waiting).rejects.toThrow()
    await notices.settle()
    expect(sent).toEqual([{ token: pending!.token, event: 'cancelled', at: expect.any(String) }])
  })
})

describe('an ask that expires unanswered', () => {
  it('is told once, by the sweep at its expiry', async () => {
    vi.useFakeTimers()
    const { ask, sent, notices, registry } = service({ graceMs: 0 })
    const [asked] = (await ask()).approvals
    sent.splice(0)
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_100)
    await notices.settle()
    expect(sent).toEqual([{ token: asked!.token, event: 'expired', at: expect.any(String) }])
    await registry.sweep()
    await notices.settle()
    expect(sent).toHaveLength(1)
  })
})
