import type { CliOutcome, CliRequest, RequestCli } from '@5straps/runtime'
import { describe, expect, it, vi } from 'vitest'
import { createTerminalBackend } from '../common/adapters/approval/terminal-backend.js'
import type { ApprovalBackend, ApprovalHost, DecisionReceipt } from '../common/types/ports/approval-backend.js'
import { askFor, event, fakeHost, live, runApprovalBackendKit, tick, type KitChoice } from './support/approval-backend-kit.js'

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

// The terminal's answer choices for each decision a kit person makes, and the keys of its save question.
const CHOICES = {
  approve: { once: 'once', session: 'session', always: 'always' },
  deny: { once: 'deny', session: 'deny_session', always: 'deny_always' },
} as const
const SAVE_KEYS = { retry: 'r', skip: 's' } as const

runApprovalBackendKit({
  name: 'the terminal backend',
  create(choices: KitChoice[]) {
    const terminal = answering(choices.flatMap(choice => (choice === 'wait' ? ['wait'] : [CHOICES[choice.outcome][choice.scope], ...(choice.save === undefined ? [] : [SAVE_KEYS[choice.save]])])))
    // An ask's question id ends with the token it asks about; a save question is not an ask shown.
    return { backend: createTerminalBackend({ requester: async () => terminal.requestCli }), shown: () => terminal.asked.filter(request => request.kind === 'approval').map(request => request.id.split(':').at(-1)!) }
  },
})

const OWED: DecisionReceipt = { status: 'applied', state: 'approved', assurance: 'local', save: 'owed', saveError: 'permission denied' }
const UNSAVED_DENIAL: DecisionReceipt = { status: 'refused', error: { code: 'grant_unsaved', message: 'The denial could not be saved (permission denied), so nothing was recorded and the call still waits', retryable: true, saveError: 'permission denied' } }

async function opened(requestCli: RequestCli, host: ApprovalHost): Promise<ApprovalBackend> {
  const backend = createTerminalBackend({ requester: async () => requestCli })
  await backend.open(host)
  return backend
}

describe('the terminal backend', () => {
  it('names what it can do: it decides every scope and takes cancels, and revokes nothing', async () => {
    const backend = createTerminalBackend({ requester: async () => undefined })
    expect(await backend.open(fakeHost({ routed: [] }))).toEqual({ contractVersion: 1, decides: true, scopes: ['once', 'session', 'always'], cancels: true, revokes: false })
  })

  it('asks each routed ask in turn and decides through the host with a plain decision', async () => {
    const asks = [askFor('a'), askFor('b', { policy: { ...askFor('b').policy, widerSubject: 'delete-below:/w' } }), askFor('c')]
    const host = fakeHost({ routed: asks })
    const terminal = answering(['once', 'session_below', 'deny_session'])
    const backend = await opened(terminal.requestCli, host)
    expect(await backend.submit(asks, live())).toEqual({ kind: 'accepted', refs: [] })
    expect(host.decided.map(({ at: _at, ...input }) => input)).toEqual([
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
    expect(host.decided.map(({ at: _at, ...input }) => input)).toEqual([{ kind: 'plain', decision: { token: 'a', outcome: 'deny', scope: 'once' } }])
    expect(terminal.asked).toHaveLength(1)
  })

  it('logs each decision the host refuses, and asks the next ask', async () => {
    const asks = [askFor('a'), askFor('b')]
    const host = fakeHost({ routed: asks, receipt: () => ({ status: 'refused', error: { code: 'scope_not_offered', message: 'refused', retryable: false } }) })
    await (await opened(answering(['once', 'session']).requestCli, host)).submit(asks, live())
    expect(host.logged).toEqual([{ level: 'warn', message: 'Approval decision rejected' }, { level: 'warn', message: 'Approval decision rejected' }])
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

  it('names why it declines a submit', async () => {
    const terminal = answering(['once'])
    const backend = createTerminalBackend({ requester: async () => terminal.requestCli })
    expect(await backend.submit([askFor('a')], live())).toEqual({ kind: 'declined', reason: 'not open' })
    await backend.open(fakeHost({ routed: [askFor('a')] }))
    await backend.close()
    expect(await backend.submit([askFor('a')], live())).toEqual({ kind: 'declined', reason: 'closed' })
  })

  it('asks about a grant its approval did not save, by the warning and the keys it takes, in the ask\'s workspace', async () => {
    const asks = [askFor('a', { workspace: { id: 'w-1', name: 'The site', node: 'node-1' } })]
    const host = fakeHost({ routed: asks, receipt: (_decision, sent) => (sent === 1 ? OWED : { status: 'repeated', state: 'approved', save: 'saved' }) })
    const terminal = answering(['session', 'r'])
    await (await opened(terminal.requestCli, host)).submit(asks, live())
    const [, question] = terminal.asked
    expect(question).toMatchObject({
      id: 'grant_save:w-1:a:1', kind: 'grant_save', correlationId: 'c-a', actor: 'agent:a', sessionId: 's-1', target: 'w-1',
      action: { details: { workspace: 'w-1', workspaceName: 'The site', warning: 'Approved for this call; saving it for the session failed: permission denied', choices: expect.stringContaining('r retries the save; s skips it') } },
      wait: { mode: 'finite', timeoutMs: 60_000 },
    })
    expect(host.logged).toEqual([{ level: 'info', message: 'Saved.' }])
  })

  it('keeps an approval\'s save question open once its ask closed, until it closes, and leaves the grant owed', async () => {
    const asks = [askFor('a')]
    const host = fakeHost({ routed: asks, receipt: () => OWED })
    const terminal = answering(['session', 'wait'])
    const backend = await opened(terminal.requestCli, host)
    const control = new AbortController()
    const submitted = backend.submit(asks, { signal: control.signal, resend: false })
    await tick()
    host.closedTokens.add('a')
    control.abort()
    await backend.notify([event('a')])
    await tick()
    expect(host.logged).toEqual([])
    await backend.close()
    await submitted
    expect(host.logged).toEqual([{ level: 'warn', message: expect.stringContaining('Left unsaved: it is written at the next decision') }])
    expect(host.decided).toHaveLength(1)
  })

  it('ends a lasting denial\'s save question when its ask closes, and asks again after a second failure', async () => {
    const asks = [askFor('a')]
    const host = fakeHost({ routed: asks, receipt: () => UNSAVED_DENIAL })
    const terminal = answering(['deny_session', 'r', 'wait'])
    const backend = await opened(terminal.requestCli, host)
    const submitted = backend.submit(asks, live())
    await vi.waitFor(() => expect(terminal.asked.map(request => request.id)).toEqual(['approval:w-1:a', 'grant_save:w-1:a:1', 'grant_save:w-1:a:2']))
    host.closedTokens.add('a')
    await backend.notify([event('a', 'expired')])
    await submitted
    expect(host.decided).toHaveLength(2)
    expect(host.logged).toEqual([{ level: 'warn', message: 'Left unsaved: nothing was denied.' }])
  })

  it('asks a lasting denial left unsaved again, since its call still waits', async () => {
    const asks = [askFor('a')]
    const host = fakeHost({ routed: asks, receipt: input => (input.decision.scope === 'once' ? { status: 'applied', state: 'denied', assurance: 'local' } : UNSAVED_DENIAL) })
    const terminal = answering(['deny_session', 'x', 'deny'])
    await (await opened(terminal.requestCli, host)).submit(asks, live())
    expect(terminal.asked.map(request => request.id)).toEqual(['approval:w-1:a', 'grant_save:w-1:a:1', 'approval:w-1:a'])
    expect(host.decided.map(input => input.decision)).toEqual([{ token: 'a', outcome: 'deny', scope: 'session' }, { token: 'a', outcome: 'deny', scope: 'once' }])
  })

  it('takes a key its save question does not offer as leaving it', async () => {
    const asks = [askFor('a')]
    const host = fakeHost({ routed: asks, receipt: () => OWED })
    await (await opened(answering(['session', 'x']).requestCli, host)).submit(asks, live())
    expect(host.decided).toHaveLength(1)
    expect(host.skipped).toEqual([])
    expect(host.logged).toEqual([{ level: 'warn', message: expect.stringContaining('Left unsaved') }])
  })

  it('asks nobody where the operation has no terminal', async () => {
    const host = fakeHost({ routed: [askFor('a')] })
    const backend = createTerminalBackend({ requester: async () => undefined })
    await backend.open(host)
    expect(await backend.submit([askFor('a')], live())).toEqual({ kind: 'accepted', refs: [] })
    expect(host.decided).toEqual([])
  })
})
