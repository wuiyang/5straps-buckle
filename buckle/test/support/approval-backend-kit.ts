import type { GrantScope } from '@5straps/protocol'
import { describe, expect, it } from 'vitest'
import type { AnswerSender, ApprovalBackend, ApprovalHost, DecisionInput, DecisionReceipt, FullAsk, LifecycleEvent, SkipReceipt, SourceReach, SubmitContext } from '../../common/types/ports/approval-backend.js'
import { SOURCES } from '../../common/types/ports/approval-source.js'

// The contract kit: the duties every approval backend owes core, run against a fake host that records every call. The
// guard's checks are core's own tests. A save the host reports owed is retried or skipped on its person's say alone.

/**
 * What the person at a backend does with each ask it shows, in order: decide it, or leave it showing. `save`: what they
 * answer when the backend warns that the decision did not save; without it, they leave the warning unanswered.
 */
export type KitChoice = { outcome: 'approve' | 'deny'; scope: GrantScope; save?: 'retry' | 'skip' } | 'wait'

export interface KitSubject {
  name: string
  /** A backend whose person makes these choices; `shown` names the tokens it put in front of them, in order. */
  create(choices: KitChoice[]): { backend: ApprovalBackend; shown: () => string[] }
}

export interface FakeHost extends ApprovalHost {
  /** Each decision as sent, with the sender a backend named for it, where it named one. */
  decided: Array<DecisionInput & { at: number; sender?: AnswerSender }>
  /** The tokens whose saves the backend skipped, in order, and the sender it named for each, where it named one. */
  skipped: string[]
  skippedBy: Array<AnswerSender | undefined>
  logged: Array<{ level: string; message: string }>
  /** Tokens whose asks left the queue: `ask` gives nothing for them. */
  closedTokens: Set<string>
}

const APPLIED: DecisionReceipt = { status: 'applied', state: 'approved', assurance: 'local' }
const OWED: DecisionReceipt = { status: 'applied', state: 'approved', assurance: 'local', save: 'owed', saveError: 'permission denied' }
const UNSAVED_DENIAL: DecisionReceipt = { status: 'refused', error: { code: 'grant_unsaved', message: 'The denial could not be saved (permission denied), so nothing was recorded and the call still waits', retryable: true, saveError: 'permission denied' } }
const SKIPPED: SkipReceipt = { status: 'skipped' }
const ONCE: KitChoice = { outcome: 'approve', scope: 'once' }

export function askFor(token: string, overrides: Partial<FullAsk> = {}): FullAsk {
  return {
    egress: 'full', contractVersion: 1, token, group: 'group-1', idempotencyKey: 'key-1',
    correlation: { correlationId: `c-${token}`, requestId: 'r-1' },
    workspace: { id: 'w-1', node: 'node-1' },
    requester: { actor: 'agent:a', sessionId: 's-1' },
    tool: 'fs_write',
    policy: { rule: 'write_scope', subject: `/w/${token}`, reason: 'A first write in this folder', offeredScopes: ['once', 'session', 'always'], floor: false },
    risk: { notes: [] },
    deadline: { expiresAt: new Date(Date.now() + 600_000).toISOString(), hold: 'grace' },
    action: { arguments: { path: token }, cwd: '/w', description: null },
    ...overrides,
  }
}

/** What a person at the node may decide, as the terminal's source may. */
const AT_THE_NODE: SourceReach = { lasting: true, floor: true }

/**
 * A host that routes `routed` alone and answers each decision with `receipt`, applied by default; `reach` is what its
 * source may decide, a person at the node's by default.
 */
export function fakeHost(input: { routed: FullAsk[]; receipt?: (decision: DecisionInput, sent: number) => DecisionReceipt; reach?: SourceReach }): FakeHost {
  const routed = new Map(input.routed.map(ask => [ask.token, ask]))
  const host: FakeHost = {
    source: SOURCES.terminal,
    reach: input.reach ?? AT_THE_NODE,
    decided: [],
    skipped: [],
    skippedBy: [],
    logged: [],
    closedTokens: new Set(),
    async decide(decision, sender) {
      host.decided.push({ ...decision, at: performance.now(), ...(sender === undefined ? {} : { sender }) })
      return input.receipt?.(decision, host.decided.filter(sent => sent.decision.token === decision.decision.token).length) ?? APPLIED
    },
    async skipSave(token, sender) {
      host.skipped.push(token)
      host.skippedBy.push(sender)
      return SKIPPED
    },
    pending: () => [...routed.values()].filter(ask => !host.closedTokens.has(ask.token)),
    ask: token => (host.closedTokens.has(token) ? undefined : routed.get(token)),
    log: (level, message) => { host.logged.push({ level, message }) },
  }
  return host
}

export const live = (): SubmitContext => ({ signal: new AbortController().signal, resend: false })
export const event = (token: string, type: LifecycleEvent['type'] = 'answered'): LifecycleEvent => ({ eventId: `e-${token}-${type}`, type, token, at: new Date().toISOString() })
export const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const tokensOf = (host: FakeHost) => host.decided.map(input => input.decision.token)

export function runApprovalBackendKit(subject: KitSubject): void {
  async function opened(choices: KitChoice[], routed: FullAsk[], receipt?: (decision: DecisionInput, sent: number) => DecisionReceipt) {
    const host = fakeHost({ routed, ...(receipt ? { receipt } : {}) })
    const { backend, shown } = subject.create(choices)
    await backend.open(host)
    return { host, backend, shown }
  }

  describe(`${subject.name} against the contract kit`, () => {
    it('names contract version 1, and opens and closes more than once', async () => {
      const { backend } = subject.create([])
      const host = fakeHost({ routed: [] })
      const first = await backend.open(host)
      expect(first.contractVersion).toBe(1)
      expect(await backend.open(host)).toEqual(first)
      await backend.close()
      await expect(backend.close()).resolves.toBeUndefined()
    })

    it('opens one request for two submits of one group under one idempotency key', async () => {
      const asks = [askFor('a')]
      const { backend, shown } = await opened(['wait'], asks)
      const control = new AbortController()
      const first = backend.submit(asks, { signal: control.signal, resend: false })
      const second = backend.submit(asks, { signal: control.signal, resend: true })
      await tick()
      expect(shown()).toEqual(['a'])
      control.abort()
      expect(await first).toEqual(await second)
    })

    it('opens a request for a new group under the same idempotency key, and for the same group once its submit was aborted', async () => {
      const earlier = askFor('a')
      const newer = askFor('b', { group: 'group-2' })
      const { backend, shown } = await opened(['wait', 'wait', 'wait'], [earlier, newer])
      const first = new AbortController()
      void backend.submit([earlier], { signal: first.signal, resend: false })
      void backend.submit([newer], live())
      await tick()
      expect(shown()).toEqual(['a', 'b'])
      first.abort()
      void backend.submit([earlier], { signal: new AbortController().signal, resend: true })
      await tick()
      expect(shown()).toEqual(['a', 'b', 'a'])
      await backend.close()
    })

    it('shows and decides nothing the host did not route to it', async () => {
      const { backend, host, shown } = await opened([ONCE, ONCE], [askFor('a')])
      await backend.submit([askFor('stray'), askFor('a')], live())
      expect(shown()).toEqual(['a'])
      expect(tokensOf(host)).toEqual(['a'])
    })

    it('skips no save of a lasting approval the host saved', async () => {
      const asks = [askFor('a')]
      const { backend, host } = await opened([{ outcome: 'approve', scope: 'session' }], asks, () => ({ status: 'applied', state: 'approved', assurance: 'local', save: 'saved' }))
      await backend.submit(asks, live())
      await sleep(50)
      expect(tokensOf(host)).toEqual(['a'])
      expect(host.skipped).toEqual([])
    })

    it('never sends a decision the host refused as not retryable again', async () => {
      const asks = [askFor('a'), askFor('b')]
      const { backend, host } = await opened([ONCE, { outcome: 'approve', scope: 'session' }], asks, decision => ({ status: 'refused', error: { code: decision.decision.token === 'a' ? 'approver_not_allowed' : 'scope_not_offered', message: 'refused', retryable: false } }))
      await backend.submit(asks, live())
      await sleep(50)
      expect(tokensOf(host)).toEqual(['a', 'b'])
    })

    it('waits out a retryable refusal\'s retryAfterMs before it sends that decision again', async () => {
      const retryAfterMs = 200
      const { backend, host } = await opened([ONCE], [askFor('a')], (_decision, sent) => (sent === 1 ? { status: 'refused', error: { code: 'rate_limited', message: 'refused', retryable: true, retryAfterMs } } : APPLIED))
      await backend.submit([askFor('a')], live())
      await sleep(retryAfterMs + 100)
      const [refusedAt, ...again] = host.decided.map(sent => sent.at)
      for (const at of again) expect(at - refusedAt!).toBeGreaterThanOrEqual(retryAfterMs)
      await backend.close()
    })

    it('neither sends again nor skips on its own an approval whose grant the host could not save', async () => {
      const asks = [askFor('a')]
      const { backend, host } = await opened([{ outcome: 'approve', scope: 'session' }], asks, () => OWED)
      const submitted = backend.submit(asks, live())
      await sleep(50)
      expect(tokensOf(host)).toEqual(['a'])
      expect(host.skipped).toEqual([])
      await backend.close()
      await submitted
    })

    it('neither sends again nor skips on its own a lasting denial the host could not save, though the refusal is retryable', async () => {
      const asks = [askFor('a')]
      const { backend, host } = await opened([{ outcome: 'deny', scope: 'session' }], asks, () => UNSAVED_DENIAL)
      const submitted = backend.submit(asks, live())
      await sleep(50)
      expect(tokensOf(host)).toEqual(['a'])
      expect(host.skipped).toEqual([])
      await backend.close()
      await submitted
    })

    it('sends the same decision once more when its person retries a save the host could not make', async () => {
      const asks = [askFor('a')]
      const { backend, host } = await opened([{ outcome: 'approve', scope: 'session', save: 'retry' }], asks, (_decision, sent) => (sent === 1 ? OWED : { status: 'repeated', state: 'approved', save: 'saved' }))
      await backend.submit(asks, live())
      expect(host.decided.map(sent => sent.decision)).toEqual([{ token: 'a', outcome: 'approve', scope: 'session' }, { token: 'a', outcome: 'approve', scope: 'session' }])
      expect(host.skipped).toEqual([])
      await backend.close()
    })

    it('skips the save of an approval when its person skips it, and sends no decision for it again', async () => {
      const asks = [askFor('a')]
      const { backend, host } = await opened([{ outcome: 'approve', scope: 'always', save: 'skip' }], asks, () => OWED)
      await backend.submit(asks, live())
      expect(tokensOf(host)).toEqual(['a'])
      expect(host.skipped).toEqual(['a'])
      await backend.close()
    })

    it('denies the call once in place of a lasting denial its person skips, and skips no save', async () => {
      const asks = [askFor('a')]
      const { backend, host } = await opened([{ outcome: 'deny', scope: 'session', save: 'skip' }], asks, (_decision, sent) => (sent === 1 ? UNSAVED_DENIAL : { status: 'applied', state: 'denied', assurance: 'local' }))
      await backend.submit(asks, live())
      expect(host.decided.map(sent => sent.decision)).toEqual([{ token: 'a', outcome: 'deny', scope: 'session' }, { token: 'a', outcome: 'deny', scope: 'once' }])
      expect(host.skipped).toEqual([])
      await backend.close()
    })

    it('settles an aborted submit within a second and opens nothing more', async () => {
      const asks = [askFor('a'), askFor('b')]
      const { backend, host, shown } = await opened(['wait', ONCE], asks)
      const control = new AbortController()
      const submitted = backend.submit(asks, { signal: control.signal, resend: false })
      await tick()
      const started = performance.now()
      control.abort()
      await submitted
      expect(performance.now() - started).toBeLessThan(1_000)
      expect(shown()).toEqual(['a'])
      expect(host.decided).toEqual([])
    })

    it('acts once on an event delivered twice', async () => {
      const asks = [askFor('a'), askFor('b')]
      const { backend, host, shown } = await opened(['wait', ONCE], asks)
      const submitted = backend.submit(asks, live())
      await tick()
      host.closedTokens.add('a')
      await backend.notify([event('a')])
      await backend.notify([event('a')])
      await submitted
      expect(shown()).toEqual(['a', 'b'])
      expect(tokensOf(host)).toEqual(['b'])
    })

    it('reaches the host for nothing once it closed, and declines what is submitted after', async () => {
      const asks = [askFor('a'), askFor('b')]
      const { backend, host, shown } = await opened(['wait', ONCE], asks)
      const submitted = backend.submit(asks, live())
      await tick()
      await backend.close()
      await submitted
      expect(await backend.submit(asks, live())).toMatchObject({ kind: 'declined' })
      expect(shown()).toEqual(['a'])
      expect(host.decided).toEqual([])
    })

    it('declines a submit before it is open', async () => {
      const { backend, shown } = subject.create([ONCE])
      expect(await backend.submit([askFor('a')], live())).toMatchObject({ kind: 'declined' })
      expect(shown()).toEqual([])
    })
  })
}
