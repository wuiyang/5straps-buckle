import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import type { PermissionOutcome } from '../common/domain/permission/engine.js'
import { createDeferredApprovalChannel } from '../common/adapters/approval/deferred-approval-channel.js'
import { loadConfig } from '../common/runtime/config.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'

const roots: string[] = []
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function registry() {
  const root = mkdtempSync('/tmp/buckle-once-'); roots.push(root)
  return createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: '/workspace' }), join(root, 'approvals.json'))
}

describe('BUCKLE-D14: only the admin credential writes a persisted approval', () => {
  const ask = (approvals: ReturnType<typeof registry>) => approvals.issue({ tool: 'fs_write', sessionId: 'writer', asks: [{ kind: 'ask', rule: 'write_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once', 'session', 'always'] }] })[0]!

  it.each(['session', 'always'] as const)('refuses a %s decision carried by an agent credential', scope => {
    const approvals = registry()
    const request = ask(approvals)
    const result = approvals.resolve({ token: request.token, approved: true, scope }, 'agent')
    expect(result).toMatchObject({ ok: false })
    expect(approvals.pending().map(entry => entry.token)).toEqual([request.token])
  })

  it('lets an agent credential answer once, and the owner answer for good', () => {
    const approvals = registry()
    expect(approvals.resolve({ token: ask(approvals).token, approved: true, scope: 'once' }, 'agent').ok).toBe(true)
    expect(approvals.resolve({ token: ask(approvals).token, approved: true, scope: 'always' }, 'admin').ok).toBe(true)
  })
})

describe('once approvals are always bound', () => {
  it('refuses an approvals file holding a once entry without its session, tool and expiry', () => {
    const root = mkdtempSync('/tmp/buckle-once-'); roots.push(root)
    const filePath = join(root, 'approvals.json')
    writeFileSync(filePath, JSON.stringify({ version: 1, pending: [], resolved: [], once: [{ workspace: '/workspace', token: 'unbound', subject: { rule: 'write_scope', subject: '/outside' } }] }))
    const approvals = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: '/workspace' }), filePath)
    expect(() => approvals.pending()).toThrow('State file is unreadable or invalid')
  })
})

describe('once approval consumption', () => {
  it('retains partial grants and consumes them exactly when every gate allows', () => {
    const approvals = registry()
    const issued = approvals.issue({ tool: 'fs_read', sessionId: 'reader', asks: [
      { kind: 'ask', rule: 'read_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once'] },
      { kind: 'ask', rule: 'sensitive_path', subject: '/outside/credentials.json', reason: 'sensitive', offeredScopes: ['once'] },
    ] })
    const check = (subjects: unknown[]): PermissionOutcome => subjects.length === 2 ? { kind: 'allow', allowedBy: [] } : { kind: 'ask', asks: [] }
    approvals.resolve({ token: issued[0]!.token, approved: true, scope: 'once' }, 'admin')
    expect(approvals.evaluate({ tokens: issued.map(item => item.token), sessionId: 'reader', tool: 'fs_read', check }).kind).toBe('ask')
    approvals.resolve({ token: issued[1]!.token, approved: true, scope: 'once' }, 'admin')
    expect(approvals.evaluate({ tokens: issued.map(item => item.token), sessionId: 'reader', tool: 'fs_read', check }).kind).toBe('allow')
    expect(approvals.evaluate({ tokens: issued.map(item => item.token), sessionId: 'reader', tool: 'fs_read', check }).kind).toBe('ask')
  })

  it('binds once grants to the issuing session and tool and expires pending tokens', () => {
    vi.useFakeTimers()
    const approvals = registry()
    const [request] = approvals.issue({ tool: 'fs_read', sessionId: 'reader', asks: [{ kind: 'ask', rule: 'read_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once'] }] })
    const decision = { token: request!.token, approved: true, scope: 'once' as const }
    expect(approvals.resolve(decision, 'admin').ok).toBe(true)
    expect(approvals.resolve(decision, 'admin').ok).toBe(true)
    const check = (subjects: unknown[]): PermissionOutcome => subjects.length ? { kind: 'allow', allowedBy: [] } : { kind: 'ask', asks: [] }
    expect(approvals.evaluate({ tokens: [request!.token], sessionId: 'other-reader', tool: 'fs_read', check }).kind).toBe('ask')
    expect(approvals.evaluate({ tokens: [request!.token], sessionId: 'reader', tool: 'fs_write', check }).kind).toBe('ask')
    vi.advanceTimersByTime(11 * 60_000)
    expect(approvals.pending()).toEqual([])
    expect(approvals.evaluate({ tokens: [request!.token], sessionId: 'reader', tool: 'fs_read', check }).kind).toBe('ask')
  })
})

describe('which late onces a call spends', () => {
  it('leaves a once whose subject a session grant already covers', () => {
    const approvals = registry()
    const issued = approvals.issue({ tool: 'fs_read', sessionId: 'reader', asks: [
      { kind: 'ask', rule: 'read_scope', subject: '/granted', reason: 'outside', offeredScopes: ['once'] },
      { kind: 'ask', rule: 'read_scope', subject: '/needed', reason: 'outside', offeredScopes: ['once'] },
    ] })
    for (const item of issued) approvals.resolve({ token: item.token, approved: true, scope: 'once' }, 'admin')
    // A session grant covers /granted, so the rule reports both subjects but needs only /needed.
    const coveredByGrant = (subjects: { subject: string }[]): PermissionOutcome => subjects.some(item => item.subject === '/needed')
      ? { kind: 'allow', allowedBy: subjects.map(item => `read_scope:${item.subject}`) }
      : { kind: 'ask', asks: [] }
    const spent: string[][] = []
    const recording = (subjects: { subject: string }[]) => { spent.push(subjects.map(item => item.subject)); return coveredByGrant(subjects) }
    expect(approvals.evaluate({ tokens: [], sessionId: 'reader', tool: 'fs_read', check: recording }).kind).toBe('allow')
    expect(spent.at(-1)).toEqual(['/needed'])
    // The once for /granted was not spent: a call that needs it still finds it.
    const needsGranted = (subjects: { subject: string }[]): PermissionOutcome => subjects.some(item => item.subject === '/granted')
      ? { kind: 'allow', allowedBy: ['read_scope:/granted'] }
      : { kind: 'ask', asks: [] }
    expect(approvals.evaluate({ tokens: [], sessionId: 'reader', tool: 'fs_read', check: needsGranted }).kind).toBe('allow')
    expect(approvals.evaluate({ tokens: [], sessionId: 'reader', tool: 'fs_read', check: needsGranted }).kind).toBe('ask')
  })
})

 it('isolates approvals between workspaces sharing the same state directory', () => {
  const root = mkdtempSync('/tmp/buckle-workspace-'); roots.push(root)
  const create = (workspace: string) => createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace }), join(root, 'approvals.json'), workspace)
  const first = create('/first'); const second = create('/second')
  const [request] = first.issue({ tool: 'fs_read', sessionId: 'shared', asks: [{ kind: 'ask', rule: 'read_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once'] }] })
  const decision = { token: request!.token, approved: true, scope: 'once' as const }
  expect(second.pending()).toEqual([])
  expect(second.resolve(decision, 'admin').ok).toBe(false)
  expect(first.resolve(decision, 'admin').ok).toBe(true)
  second.evaluate({ tokens: [request!.token], sessionId: 'shared', tool: 'fs_read', check: subjects => { expect(subjects).toEqual([]); return { kind: 'allow', allowedBy: [] } } })
  create('/first').evaluate({ tokens: [request!.token], sessionId: 'shared', tool: 'fs_read', check: subjects => { expect(subjects).toHaveLength(1); return { kind: 'allow', allowedBy: [] } } })
})

describe('a once approval answered after the grace period', () => {
  async function setup() {
    const outside = mkdtempSync(join(tmpdir(), 'buckle-once-outside-'))
    const other = mkdtempSync(join(tmpdir(), 'buckle-once-other-'))
    writeFileSync(join(outside, 'notes.txt'), 'late')
    writeFileSync(join(other, 'notes.txt'), 'other')
    const runtime = await createRuntime({
      config: loadConfig({
        BUCKLE_AUTH_TOKEN: 'agent',
        BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-once-state-')),
        BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-once-ws-')),
        BUCKLE_ALLOW_SHELL: 'false',
      }),
      channel: () => createDeferredApprovalChannel(),
    })
    const read = (path: string, sessionId = 'mcp', tool = 'fs_read') => runtime.invoke({
      request: { requestId: 'late', tool, args: { path }, approvalTokens: [] }, sessionId,
    })
    return { runtime, read, file: join(outside, 'notes.txt'), otherFile: join(other, 'notes.txt') }
  }

  async function answerOnceLate(context: Awaited<ReturnType<typeof setup>>) {
    const first = await context.read(context.file)
    if (first.outcome !== 'approval_required') throw new Error(`expected an approval, got ${first.outcome}`)
    expect(context.runtime.approvals.resolve({ token: first.approvals[0]!.token, approved: true, scope: 'once' }, 'agent').ok).toBe(true)
  }

  it('runs the retried call that carries no token, and is consumed by it', async () => {
    const context = await setup()
    await answerOnceLate(context)
    expect(await context.read(context.file)).toMatchObject({ outcome: 'ok' })
    expect((await context.read(context.file)).outcome).toBe('approval_required')
  })

  it('does not cover a call with a different effect, and survives it', async () => {
    const context = await setup()
    await answerOnceLate(context)
    expect((await context.read(context.otherFile)).outcome).toBe('approval_required')
    expect(await context.read(context.file)).toMatchObject({ outcome: 'ok' })
  })

  it('spends one of two onces answered for the same subject, leaving the other for the next call', async () => {
    const context = await setup()
    const asked = [await context.read(context.file), await context.read(context.file)]
    for (const result of asked) {
      if (result.outcome !== 'approval_required') throw new Error(`expected an approval, got ${result.outcome}`)
      expect(context.runtime.approvals.resolve({ token: result.approvals[0]!.token, approved: true, scope: 'once' }, 'agent').ok).toBe(true)
    }
    expect(await context.read(context.file)).toMatchObject({ outcome: 'ok' })
    expect(await context.read(context.file)).toMatchObject({ outcome: 'ok' })
    expect((await context.read(context.file)).outcome).toBe('approval_required')
  })

  it('does not cover another session or another tool', async () => {
    const context = await setup()
    await answerOnceLate(context)
    expect((await context.read(context.file, 'someone-else')).outcome).toBe('approval_required')
    expect((await context.read(dirname(context.file), 'mcp', 'fs_list')).outcome).toBe('approval_required')
    expect(await context.read(context.file)).toMatchObject({ outcome: 'ok' })
  })
})
