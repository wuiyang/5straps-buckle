import type { CliOutcome, RequestCli } from '@5straps/runtime'
import type { ApprovalBackend, ApprovalHost, BackendCapabilities, DecisionBody, FullAsk, SubmitContext, SubmitResult } from '../../types/ports/approval-backend.js'
import { questionFor, type QuestionInput } from './terminal-question.js'

export interface TerminalBackendOptions {
  /** The asking operation's requester: this process's terminal, or undefined where nobody sits at one. */
  requester: () => Promise<RequestCli | undefined>
  /** Whether --approve-if-safe can approve a safe verdict here, read as each question is shown (fix brief 9, B37). */
  judgeApproves?: () => boolean
}

const CAPABILITIES: BackendCapabilities = { contractVersion: 1, decides: true, scopes: ['once', 'session', 'always'], cancels: true, revokes: false }
const ACCEPTED: SubmitResult = { kind: 'accepted', refs: [] }

/**
 * The serve terminal and the one-shot prompt: one question per ask, in order, each answer decided through the host.
 * A denial ends a call's questions, since the call is refused either way. A submit settles once its questions end.
 */
export function createTerminalBackend(options: TerminalBackendOptions): ApprovalBackend {
  let host: ApprovalHost | undefined
  const closing = new AbortController()
  const inFlight = new Map<string, Promise<SubmitResult>>()
  const questions = new Map<string, AbortController>()
  // The tokens of the submits still asking, and those among them whose asks closed.
  const asking = new Set<string>()
  const closed = new Set<string>()

  async function askInTurn(input: { host: ApprovalHost; asks: FullAsk[]; context: SubmitContext }): Promise<void> {
    const requestCli = await options.requester()
    if (!requestCli) return
    const stop = AbortSignal.any([input.context.signal, closing.signal])
    for (const ask of input.asks) {
      if (stop.aborted) return
      if (closed.has(ask.token) || input.host.ask(ask.token) === undefined) continue
      const question = new AbortController()
      questions.set(ask.token, question)
      let outcome: CliOutcome
      try {
        outcome = await requestCli(questionFor(questionInputOf(ask, options.judgeApproves?.())), { signal: AbortSignal.any([stop, question.signal]) })
      } finally {
        questions.delete(ask.token)
      }
      if (closing.signal.aborted) return
      if (outcome.status === 'answered' || outcome.status === 'denied') {
        const decision = decisionFor(ask, outcome)
        const receipt = await input.host.decide({ kind: 'plain', decision })
        if (receipt.status === 'refused') input.host.log('warn', 'Approval decision rejected', { reason: receipt.error.message })
        if (decision.outcome === 'deny') return
        continue
      }
      // Its ask closed while on screen; the next one is still worth asking.
      if (outcome.status === 'cancelled' && question.signal.aborted && !stop.aborted) continue
      // Nobody can be asked now: each ask still gets its pending line, not only the first (the MCP asks brief, item 4).
      if (outcome.status === 'unavailable' && (outcome.reason === 'no_consumer' || outcome.reason === 'no_listener')) continue
      return
    }
  }

  return {
    async open(opener) {
      host ??= opener
      return CAPABILITIES
    },

    submit(asks, context) {
      if (!host || closing.signal.aborted) return Promise.resolve(ACCEPTED)
      const key = asks[0]?.idempotencyKey
      const running = key === undefined ? undefined : inFlight.get(key)
      if (running) return running
      for (const ask of asks) asking.add(ask.token)
      const submitted: Promise<SubmitResult> = askInTurn({ host, asks, context }).then(() => ACCEPTED).finally(() => {
        for (const ask of asks) {
          asking.delete(ask.token)
          closed.delete(ask.token)
        }
        if (key !== undefined && inFlight.get(key) === submitted) inFlight.delete(key)
      })
      if (key !== undefined) inFlight.set(key, submitted)
      return submitted
    },

    async notify(events) {
      for (const event of events) {
        if (!asking.has(event.token)) continue
        closed.add(event.token)
        questions.get(event.token)?.abort()
      }
    },

    async close() {
      closing.abort()
      await Promise.allSettled([...inFlight.values()])
    },
  }
}

/** The verdict for the asked token alone; anything but a known approving choice denies once. */
function decisionFor(ask: FullAsk, outcome: Extract<CliOutcome, { status: 'answered' | 'denied' }>): DecisionBody {
  const { token } = ask
  const choice = outcome.status === 'answered' ? outcome.answer.choice : 'deny'
  if (choice === 'once' || choice === 'session' || choice === 'always') return { token, outcome: 'approve', scope: choice }
  if ((choice === 'session_below' || choice === 'always_below') && ask.policy.widerSubject !== undefined) return { token, outcome: 'approve', scope: choice === 'session_below' ? 'session' : 'always', widen: 'below' }
  if (choice === 'deny_session') return { token, outcome: 'deny', scope: 'session' }
  if (choice === 'deny_always') return { token, outcome: 'deny', scope: 'always' }
  return { token, outcome: 'deny', scope: 'once' }
}

function questionInputOf(ask: FullAsk, approves: boolean | undefined): QuestionInput {
  const { policy, risk, workspace, action } = ask
  const name = workspace.name
  return {
    approval: {
      token: ask.token, rule: policy.rule, subject: policy.subject, reason: policy.reason,
      ...(risk.severity === undefined ? {} : { severity: risk.severity }),
      tool: ask.tool, offeredScopes: policy.offeredScopes, expiresAt: ask.deadline.expiresAt,
      ...(policy.widerSubject === undefined ? {} : { widerSubject: policy.widerSubject }),
    },
    workspaceId: workspace.id,
    ...(name === undefined ? {} : { workspaceName: name }),
    node: workspace.node,
    context: {
      correlationId: ask.correlation.correlationId,
      ...(ask.requester.actor === null ? {} : { actor: ask.requester.actor }),
      sessionId: ask.requester.sessionId,
      ...(action === undefined ? {} : { call: { ...action, judge: risk.notes } }),
    },
    ...(approves === undefined ? {} : { approves }),
  }
}
