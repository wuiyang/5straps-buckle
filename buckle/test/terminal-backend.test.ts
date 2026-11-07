import type { CliOutcome, CliRequest, RequestCli } from '@5straps/runtime'
import { describe, expect, it } from 'vitest'
import { createTerminalBackend } from '../common/adapters/approval/terminal-backend.js'
import type { ApprovalBackend, ApprovalHost } from '../common/types/ports/approval-backend.js'
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

// The terminal's answer choices for each decision a kit person makes.
const CHOICES = {
  approve: { once: 'once', session: 'session', always: 'always' },
  deny: { once: 'deny', session: 'deny_session', always: 'deny_always' },
} as const

runApprovalBackendKit({
  name: 'the terminal backend',
  create(choices: KitChoice[]) {
    const terminal = answering(choices.map(choice => (choice === 'wait' ? 'wait' : CHOICES[choice.outcome][choice.scope])))
    // A question's id ends with the token it asks about.
    return { backend: createTerminalBackend({ requester: async () => terminal.requestCli }), shown: () => terminal.asked.map(request => request.id.split(':').at(-1)!) }
  },
})

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

  it('asks nobody where the operation has no terminal', async () => {
    const host = fakeHost({ routed: [askFor('a')] })
    const backend = createTerminalBackend({ requester: async () => undefined })
    await backend.open(host)
    expect(await backend.submit([askFor('a')], live())).toEqual({ kind: 'accepted', refs: [] })
    expect(host.decided).toEqual([])
  })
})
