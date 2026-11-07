import type { CliOutcome, CliRequest, RequestCli } from '@5straps/runtime'
import { describe, expect, it } from 'vitest'
import { createTerminalBackend } from '../common/adapters/approval/terminal-backend.js'
import type { ApprovalBackend, ApprovalHost, DecisionInput, DecisionReceipt, FullAsk, LifecycleEvent } from '../common/types/ports/approval-backend.js'
import { SOURCES } from '../common/types/ports/approval-source.js'

// The contract kit's duties of a backend, against the terminal backend and a fake host that records every call.

const APPLIED: DecisionReceipt = { status: 'applied', state: 'approved', assurance: 'local' }

function askFor(token: string, overrides: Partial<FullAsk> = {}): FullAsk {
  return {
    egress: 'full', contractVersion: 1, token, idempotencyKey: 'key-1',
    correlation: { correlationId: `c-${token}`, requestId: 'r-1' },
    workspace: { id: 'w-1', node: 'node-1' },
    requester: { actor: 'agent:a', sessionId: 's-1' },
    tool: 'fs_write',
    policy: { rule: 'write_scope', subject: `/w/${token}`, reason: 'A first write in this folder', offeredScopes: ['once', 'session', 'always'] },
    risk: { notes: [] },
    deadline: { expiresAt: new Date(Date.now() + 600_000).toISOString(), hold: 'grace' },
    action: { arguments: { path: token }, cwd: '/w', description: null },
    ...overrides,
  }
}

interface FakeHost extends ApprovalHost {
  decided: DecisionInput[]
  logged: Array<{ level: string; message: string }>
  closedTokens: Set<string>
}

function fakeHost(input: { routed: FullAsk[]; receipt?: (decision: DecisionInput) => DecisionReceipt }): FakeHost {
  const routed = new Map(input.routed.map(ask => [ask.token, ask]))
  const host: FakeHost = {
    source: SOURCES.terminal,
    decided: [],
    logged: [],
    closedTokens: new Set(),
    async decide(decision) {
      host.decided.push(decision)
      return input.receipt?.(decision) ?? APPLIED
    },
    ask: token => (host.closedTokens.has(token) ? undefined : routed.get(token)),
    log: (level, message) => { host.logged.push({ level, message }) },
  }
  return host
}

/** A terminal someone answers: each question gets the next choice, or waits until its signal aborts. */
function answering(choices: Array<string | 'wait'>): { requestCli: RequestCli; asked: CliRequest[] } {
  const asked: CliRequest[] = []
  const requestCli: RequestCli = (request, options) => {
    asked.push(request)
    const choice = choices.shift() ?? 'wait'
    if (choice !== 'wait') return Promise.resolve<CliOutcome>({ status: 'answered', requestId: request.id, answer: { choice } })
    return new Promise<CliOutcome>((resolve) => {
      const cancel = () => resolve({ status: 'cancelled', requestId: request.id, reason: 'aborted' })
      if (options?.signal?.aborted) cancel()
      options?.signal?.addEventListener('abort', cancel, { once: true })
    })
  }
  return { requestCli, asked }
}

async function opened(requestCli: RequestCli, host: ApprovalHost): Promise<ApprovalBackend> {
  const backend = createTerminalBackend({ requester: async () => requestCli })
  await backend.open(host)
  return backend
}

const live = (): SubmitSignal => ({ signal: new AbortController().signal, resend: false })
type SubmitSignal = { signal: AbortSignal; resend: boolean }
const event = (token: string, type: LifecycleEvent['type'] = 'answered'): LifecycleEvent => ({ eventId: `e-${token}-${type}`, type, token, at: new Date().toISOString() })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('the terminal backend against the contract kit', () => {
  it('names contract version 1, and opens and closes more than once', async () => {
    const backend = createTerminalBackend({ requester: async () => undefined })
    const host = fakeHost({ routed: [] })
    const first = await backend.open(host)
    expect(first).toEqual({ contractVersion: 1, decides: true, scopes: ['once', 'session', 'always'], cancels: true, revokes: false })
    expect(await backend.open(host)).toEqual(first)
    await backend.close()
    await expect(backend.close()).resolves.toBeUndefined()
  })

  it('asks each routed ask in turn and decides through the host with a plain decision', async () => {
    const asks = [askFor('a'), askFor('b', { policy: { ...askFor('b').policy, widerSubject: 'delete-below:/w' } }), askFor('c')]
    const host = fakeHost({ routed: asks })
    const terminal = answering(['once', 'session_below', 'deny_session'])
    const backend = await opened(terminal.requestCli, host)
    expect(await backend.submit(asks, live())).toEqual({ kind: 'accepted', refs: [] })
    expect(host.decided).toEqual([
      { kind: 'plain', decision: { token: 'a', outcome: 'approve', scope: 'once' } },
      { kind: 'plain', decision: { token: 'b', outcome: 'approve', scope: 'session', widen: 'below' } },
      { kind: 'plain', decision: { token: 'c', outcome: 'deny', scope: 'session' } },
    ])
    expect(terminal.asked.map(request => request.id)).toEqual(['approval:w-1:a', 'approval:w-1:b', 'approval:w-1:c'])
  })

  it('denies once a wider choice for an ask with no wider subject, and asks nothing after a denial', async () => {
    const asks = [askFor('a'), askFor('b')]
    const host = fakeHost({ routed: asks })
    const terminal = answering(['always_below', 'once'])
    await (await opened(terminal.requestCli, host)).submit(asks, live())
    expect(host.decided).toEqual([{ kind: 'plain', decision: { token: 'a', outcome: 'deny', scope: 'once' } }])
    expect(terminal.asked).toHaveLength(1)
  })

  it('opens one request for two submits under one idempotency key', async () => {
    const asks = [askFor('a')]
    const host = fakeHost({ routed: asks })
    const terminal = answering(['wait'])
    const backend = await opened(terminal.requestCli, host)
    const control = new AbortController()
    const first = backend.submit(asks, { signal: control.signal, resend: false })
    const second = backend.submit(asks, { signal: control.signal, resend: true })
    await tick()
    expect(terminal.asked).toHaveLength(1)
    control.abort()
    expect(await first).toEqual(await second)
  })

  it('asks and decides nothing the host did not route to it', async () => {
    const host = fakeHost({ routed: [askFor('a')] })
    const terminal = answering(['once', 'once'])
    await (await opened(terminal.requestCli, host)).submit([askFor('stray'), askFor('a')], live())
    expect(terminal.asked.map(request => request.id)).toEqual(['approval:w-1:a'])
    expect(host.decided.map(input => input.decision.token)).toEqual(['a'])
  })

  it('never sends a refused decision again, whether or not the refusal may be retried', async () => {
    const asks = [askFor('a'), askFor('b')]
    const host = fakeHost({ routed: asks, receipt: input => ({ status: 'refused', error: { code: input.decision.token === 'a' ? 'approver_not_allowed' : 'scope_not_offered', message: 'refused', retryable: false } }) })
    await (await opened(answering(['once', 'session']).requestCli, host)).submit(asks, live())
    expect(host.decided.map(input => input.decision.token)).toEqual(['a', 'b'])
    expect(host.logged).toEqual([{ level: 'warn', message: 'Approval decision rejected' }, { level: 'warn', message: 'Approval decision rejected' }])
  })

  it('settles an aborted submit at once and opens nothing more', async () => {
    const asks = [askFor('a'), askFor('b')]
    const host = fakeHost({ routed: asks })
    const terminal = answering(['wait', 'once'])
    const backend = await opened(terminal.requestCli, host)
    const control = new AbortController()
    const submitted = backend.submit(asks, { signal: control.signal, resend: false })
    await tick()
    const started = performance.now()
    control.abort()
    await submitted
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(terminal.asked).toHaveLength(1)
    expect(host.decided).toEqual([])
  })

  it('withdraws the question of an ask that closed, and acts on a repeated event once', async () => {
    const asks = [askFor('a'), askFor('b')]
    const host = fakeHost({ routed: asks })
    const terminal = answering(['wait', 'once'])
    const backend = await opened(terminal.requestCli, host)
    const submitted = backend.submit(asks, live())
    await tick()
    host.closedTokens.add('a')
    await backend.notify([event('a')])
    await backend.notify([event('a')])
    await submitted
    expect(terminal.asked.map(request => request.id)).toEqual(['approval:w-1:a', 'approval:w-1:b'])
    expect(host.decided.map(input => input.decision.token)).toEqual(['b'])
  })

  it('skips an ask it was told closed before its question came up, and keeps nothing once its submit settles', async () => {
    const asks = [askFor('a'), askFor('b'), askFor('c')]
    const host = fakeHost({ routed: asks })
    const terminal = answering(['wait', 'once', 'once'])
    const backend = await opened(terminal.requestCli, host)
    const submitted = backend.submit(asks, live())
    await tick()
    await backend.notify([event('b', 'expired'), event('a', 'cancelled')])
    await submitted
    expect(terminal.asked.map(request => request.id)).toEqual(['approval:w-1:a', 'approval:w-1:c'])
    await backend.notify([event('c', 'expired')])
    await backend.submit([askFor('c', { idempotencyKey: 'key-2' })], live())
    expect(terminal.asked.map(request => request.id)).toEqual(['approval:w-1:a', 'approval:w-1:c', 'approval:w-1:c'])
  })

  it('reaches the host for nothing once it closed', async () => {
    const asks = [askFor('a'), askFor('b')]
    const host = fakeHost({ routed: asks })
    const terminal = answering(['wait', 'once'])
    const backend = await opened(terminal.requestCli, host)
    const submitted = backend.submit(asks, live())
    await tick()
    await backend.close()
    await submitted
    expect(await backend.submit(asks, live())).toEqual({ kind: 'accepted', refs: [] })
    expect(terminal.asked).toHaveLength(1)
    expect(host.decided).toEqual([])
  })

  it('asks nobody where the operation has no terminal', async () => {
    const host = fakeHost({ routed: [askFor('a')] })
    const backend = createTerminalBackend({ requester: async () => undefined })
    await backend.open(host)
    expect(await backend.submit([askFor('a')], live())).toEqual({ kind: 'accepted', refs: [] })
    expect(host.decided).toEqual([])
  })
})
