import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import type { PermissionOutcome } from '../common/domain/permission/engine.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'

const recorded = { arguments: { path: '/outside' }, cwd: '/workspace', description: null, effects: [], complete: true as const }
const roots: string[] = []
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function registry() {
  const root = mkdtempSync('/tmp/buckle-once-'); roots.push(root)
  return createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: '/workspace' }), join(root, 'approvals.json'))
}

describe('BUCKLE-D14: a relayed source writes a once and nothing that outlives the call', () => {
  const ask = async (approvals: ReturnType<typeof registry>) => ((await approvals.ask({ call: recorded, tool: 'fs_write', sessionId: 'writer', asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once', 'session', 'always'] }] })).requests)[0]!

  it.each(['session', 'always'] as const)('refuses a %s decision from a relayed source', async scope => {
    const approvals = registry()
    const request = await ask(approvals)
    const result = await approvals.resolve({ token: request.token, approved: true, scope }, 'judge')
    expect(result).toMatchObject({ ok: false })
    expect(approvals.pending().map(entry => entry.token)).toEqual([request.token])
  })

  it('lets a relayed source answer once, and a person at the node answer for good', async () => {
    const approvals = registry()
    expect((await approvals.resolve({ token: (await ask(approvals)).token, approved: true, scope: 'once' }, 'judge')).ok).toBe(true)
    expect((await approvals.resolve({ token: (await ask(approvals)).token, approved: true, scope: 'always' }, 'cli')).ok).toBe(true)
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
  it('retains partial grants and consumes them exactly when every gate allows', async () => {
    const approvals = registry()
    const issued = (await approvals.ask({ call: recorded, tool: 'fs_read', sessionId: 'reader', asks: [
      { kind: 'ask', ...PLAIN_MARKS, rule: 'read_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once'] },
      { kind: 'ask', ...PLAIN_MARKS, rule: 'sensitive_path', subject: '/outside/credentials.json', reason: 'sensitive', offeredScopes: ['once'] },
    ] })).requests
    const check = (subjects: unknown[]): PermissionOutcome => subjects.length === 2 ? { kind: 'allow', allowedBy: [] } : { kind: 'ask', asks: [] }
    await approvals.resolve({ token: issued[0]!.token, approved: true, scope: 'once' }, 'cli')
    expect((await approvals.evaluate({ tokens: issued.map(item => item.token), sessionId: 'reader', tool: 'fs_read', check })).kind).toBe('ask')
    await approvals.resolve({ token: issued[1]!.token, approved: true, scope: 'once' }, 'cli')
    expect((await approvals.evaluate({ tokens: issued.map(item => item.token), sessionId: 'reader', tool: 'fs_read', check })).kind).toBe('allow')
    expect((await approvals.evaluate({ tokens: issued.map(item => item.token), sessionId: 'reader', tool: 'fs_read', check })).kind).toBe('ask')
  })

  it('binds once grants to the issuing session and tool and expires pending tokens', async () => {
    vi.useFakeTimers()
    const approvals = registry()
    const [request] = (await approvals.ask({ call: recorded, tool: 'fs_read', sessionId: 'reader', asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'read_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once'] }] })).requests
    const decision = { token: request!.token, approved: true, scope: 'once' as const }
    expect((await approvals.resolve(decision, 'cli')).ok).toBe(true)
    expect((await approvals.resolve(decision, 'cli')).ok).toBe(true)
    const check = (subjects: unknown[]): PermissionOutcome => subjects.length ? { kind: 'allow', allowedBy: [] } : { kind: 'ask', asks: [] }
    expect((await approvals.evaluate({ tokens: [request!.token], sessionId: 'other-reader', tool: 'fs_read', check })).kind).toBe('ask')
    expect((await approvals.evaluate({ tokens: [request!.token], sessionId: 'reader', tool: 'fs_write', check })).kind).toBe('ask')
    vi.advanceTimersByTime(11 * 60_000)
    expect(approvals.pending()).toEqual([])
    expect((await approvals.evaluate({ tokens: [request!.token], sessionId: 'reader', tool: 'fs_read', check })).kind).toBe('ask')
  })
})

describe('which late onces a call spends', () => {
  it('leaves a once whose subject a session grant already covers', async () => {
    const approvals = registry()
    const issued = (await approvals.ask({ call: recorded, tool: 'fs_read', sessionId: 'reader', asks: [
      { kind: 'ask', ...PLAIN_MARKS, rule: 'read_scope', subject: '/granted', reason: 'outside', offeredScopes: ['once'] },
      { kind: 'ask', ...PLAIN_MARKS, rule: 'read_scope', subject: '/needed', reason: 'outside', offeredScopes: ['once'] },
    ] })).requests
    for (const item of issued) await approvals.resolve({ token: item.token, approved: true, scope: 'once' }, 'cli')
    // A session grant covers /granted, so the rule reports both subjects but needs only /needed.
    const coveredByGrant = (subjects: { subject: string }[]): PermissionOutcome => subjects.some(item => item.subject === '/needed')
      ? { kind: 'allow', allowedBy: subjects.map(item => `read_scope:${item.subject}`) }
      : { kind: 'ask', asks: [] }
    const spent: string[][] = []
    const recording = (subjects: { subject: string }[]) => { spent.push(subjects.map(item => item.subject)); return coveredByGrant(subjects) }
    expect((await approvals.evaluate({ tokens: [], sessionId: 'reader', tool: 'fs_read', check: recording })).kind).toBe('allow')
    expect(spent.at(-1)).toEqual(['/needed'])
    // The once for /granted was not spent: a call that needs it still finds it.
    const needsGranted = (subjects: { subject: string }[]): PermissionOutcome => subjects.some(item => item.subject === '/granted')
      ? { kind: 'allow', allowedBy: ['read_scope:/granted'] }
      : { kind: 'ask', asks: [] }
    expect((await approvals.evaluate({ tokens: [], sessionId: 'reader', tool: 'fs_read', check: needsGranted })).kind).toBe('allow')
    expect((await approvals.evaluate({ tokens: [], sessionId: 'reader', tool: 'fs_read', check: needsGranted })).kind).toBe('ask')
  })
})

 it('isolates approvals between workspaces sharing the same state directory', async () => {
  const root = mkdtempSync('/tmp/buckle-workspace-'); roots.push(root)
  const create = (workspace: string) => createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace }), join(root, 'approvals.json'), workspace)
  const first = create('/first'); const second = create('/second')
  const [request] = (await first.ask({ call: recorded, tool: 'fs_read', sessionId: 'shared', asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'read_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once'] }] })).requests
  const decision = { token: request!.token, approved: true, scope: 'once' as const }
  expect(second.pending()).toEqual([])
  expect((await second.resolve(decision, 'cli')).ok).toBe(false)
  expect((await first.resolve(decision, 'cli')).ok).toBe(true)
  await second.evaluate({ tokens: [request!.token], sessionId: 'shared', tool: 'fs_read', check: subjects => { expect(subjects).toEqual([]); return { kind: 'allow', allowedBy: [] } } })
  await create('/first').evaluate({ tokens: [request!.token], sessionId: 'shared', tool: 'fs_read', check: subjects => { expect(subjects).toHaveLength(1); return { kind: 'allow', allowedBy: [] } } })
})

describe('a once approval answered after the grace period', () => {
  async function setup() {
    const outside = mkdtempSync(join(tmpdir(), 'buckle-once-outside-'))
    const other = mkdtempSync(join(tmpdir(), 'buckle-once-other-'))
    writeFileSync(join(outside, 'notes.txt'), 'late')
    writeFileSync(join(other, 'notes.txt'), 'other')
    const runtime = await createRuntime({
      config: configFromEnvironment({
        BUCKLE_AUTH_TOKEN: 'agent',
        BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-once-state-')),
        BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-once-ws-')),
        BUCKLE_ALLOW_SHELL: 'false',
      }),
    })
    // A fresh requestId per call, as the MCP face sends: the same one would join the ask already waiting.
    const read = (path: string, sessionId = 'mcp', tool = 'fs_read') => runtime.invoke({
      request: { requestId: randomUUID(), tool, args: { path }, approvalTokens: [] }, sessionId,
    })
    return { runtime, read, file: join(outside, 'notes.txt'), otherFile: join(other, 'notes.txt') }
  }

  async function answerOnceLate(context: Awaited<ReturnType<typeof setup>>) {
    const first = await context.read(context.file)
    if (first.outcome !== 'approval_required') throw new Error(`expected an approval, got ${first.outcome}`)
    expect((await context.runtime.approvals.resolve({ token: first.approvals[0]!.token, approved: true, scope: 'once' }, 'judge')).ok).toBe(true)
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
      expect((await context.runtime.approvals.resolve({ token: result.approvals[0]!.token, approved: true, scope: 'once' }, 'judge')).ok).toBe(true)
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

// Review item 16 of the proof-of-possession fixes: a call is its requestId, session and actor, and callers
// that send no session share one, so a requestId withdraw without its actor could drop another actor's once.
describe('a withdraw by requestId and session', () => {
  async function twoActors() {
    const approvals = registry()
    const asked = async (actor: string) => ((await approvals.ask({ call: recorded, tool: 'fs_write', sessionId: 'rpc', requestId: 'hashed-1', actor, asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: `/outside/${actor}`, reason: 'outside', offeredScopes: ['once'] }] })).requests)[0]!.token
    const first = await asked('agent:rings')
    const second = await asked('agent:workbench')
    for (const token of [first, second]) expect((await approvals.resolve({ token, approved: true, scope: 'once' }, 'cli')).ok).toBe(true)
    return { approvals, first, second }
  }

  it('is refused when it matches more than one actor\'s call, and drops nothing', async () => {
    const { approvals } = await twoActors()
    await expect(approvals.cancelGroup({ requestId: 'hashed-1', sessionId: 'rpc' })).rejects.toMatchObject({ code: 'WITHDRAW_AMBIGUOUS', status: 409 })
    expect(approvals.unspent('rpc')).toHaveLength(2)
  })

  it('with its actor, drops that actor\'s answered once and leaves the other\'s', async () => {
    const { approvals, first } = await twoActors()
    expect(await approvals.cancelGroup({ requestId: 'hashed-1', sessionId: 'rpc', actor: 'agent:rings' })).toEqual({ withdrawn: [], dropped: [first] })
    expect(approvals.unspent('rpc').map(entry => entry.subject.subject)).toEqual(['/outside/agent:workbench'])
  })
})
