import type { CliOutcome, RequestCli } from '@5straps/runtime'
import { saveAnswerOf, saveEndingLine, settleUnsaved, unsavedOf, type SaveEnding, type Unsaved } from './grant-save-question.js'
import type { ApprovalBackend, ApprovalHost, BackendCapabilities, DecisionBody, FullAsk, SubmitContext, SubmitResult } from '../../types/ports/approval-backend.js'
import { questionFor, saveQuestionFor, type QuestionInput } from './terminal-question.js'

export interface TerminalBackendOptions {
  /** The asking operation's requester: this process's terminal, or undefined where nobody sits at one. */
  requester: () => Promise<RequestCli | undefined>
  /** Whether --approve-if-safe can approve a safe verdict here, read as each question is shown. */
  judgeApproves?: () => boolean
}

const CAPABILITIES: BackendCapabilities = { contractVersion: 1, decides: true, scopes: ['once', 'session', 'always'], cancels: true, revokes: false }
const ACCEPTED: SubmitResult = { kind: 'accepted', refs: [] }
// Not this backend's to ask, so core may send the asks to a fallback route.
const NOT_OPEN: SubmitResult = { kind: 'declined', reason: 'not open' }
const CLOSED: SubmitResult = { kind: 'declined', reason: 'closed' }
/** How a save question's ending is logged: on the serve terminal, where the question was. */
const SAVE_ENDING_LEVELS: Readonly<Record<SaveEnding['ending'], 'info' | 'warn'>> = { saved: 'info', skipped: 'info', dropped: 'warn', denied_once: 'info', left: 'warn', refused: 'warn' }

/**
 * The serve terminal and the one-shot prompt: one question per ask, in order, each answer decided through the host.
 * A denial ends a call's questions, since the call is refused either way. A submit settles once its questions end.
 * A decision whose grant did not save asks a save question next, which only the person's answer resends or skips.
 */
export function createTerminalBackend(options: TerminalBackendOptions): ApprovalBackend {
  let host: ApprovalHost | undefined
  const closing = new AbortController()
  // By call and group while the submit still asks; `running` holds every unsettled submit, for close.
  const inFlight = new Map<string, Promise<SubmitResult>>()
  const running = new Set<Promise<SubmitResult>>()
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
        const unsaved = unsavedOf({ decision, receipt })
        if (unsaved !== undefined) await settleSave({ host: input.host, requestCli, ask, decision, unsaved, stop })
        else if (receipt.status === 'refused') input.host.log('warn', 'Approval decision rejected', { reason: receipt.error.message })
        if (decision.outcome === 'deny') return
        continue
      }
      // Its ask closed while on screen; the next one is still worth asking.
      if (outcome.status === 'cancelled' && question.signal.aborted && !stop.aborted) continue
      // Nobody can be asked now: each ask still gets its pending line, not only the first.
      if (outcome.status === 'unavailable' && (outcome.reason === 'no_consumer' || outcome.reason === 'no_listener')) continue
      return
    }
  }

  async function settleSave(input: { host: ApprovalHost; requestCli: RequestCli; ask: FullAsk; decision: DecisionBody; unsaved: Unsaved; stop: AbortSignal }): Promise<void> {
    const { host, decision } = input
    let attempt = 0
    const ending = await settleUnsaved({
      decision, unsaved: input.unsaved,
      route: {
        ask: async (unsaved) => {
          attempt += 1
          const outcome = await askSave({ ...input, unsaved, attempt })
          return outcome?.status === 'answered' ? saveAnswerOf(unsaved.kind, outcome.answer.choice) : undefined
        },
        retry: () => host.decide({ kind: 'plain', decision }),
        skipSave: () => host.skipSave(decision.token),
        denyOnce: () => host.decide({ kind: 'plain', decision: { token: decision.token, outcome: 'deny', scope: 'once' } }),
      },
    })
    host.log(SAVE_ENDING_LEVELS[ending.ending], saveEndingLine(ending))
  }

  // A denial's question ends with its ask, which still waits; any other outlives the ask its decision answered, until the
  // person answers it or this backend closes.
  async function askSave(input: { requestCli: RequestCli; ask: FullAsk; unsaved: Unsaved; attempt: number; stop: AbortSignal }): Promise<CliOutcome | undefined> {
    const { token } = input.ask
    if (input.unsaved.kind !== 'denial') return input.requestCli(saveQuestionFor(input), { signal: closing.signal })
    if (closed.has(token)) return undefined
    const question = new AbortController()
    questions.set(token, question)
    try {
      return await input.requestCli(saveQuestionFor(input), { signal: AbortSignal.any([input.stop, question.signal]) })
    } finally {
      questions.delete(token)
    }
  }

  return {
    async open(opener) {
      host ??= opener
      return CAPABILITIES
    },

    submit(asks, context) {
      if (!host) return Promise.resolve(NOT_OPEN)
      if (closing.signal.aborted) return Promise.resolve(CLOSED)
      const key = requestKey(asks)
      const repeated = key === undefined ? undefined : inFlight.get(key)
      if (repeated) return repeated
      for (const ask of asks) asking.add(ask.token)
      const forget = () => { if (key !== undefined && inFlight.get(key) === submitted) inFlight.delete(key) }
      const submitted: Promise<SubmitResult> = askInTurn({ host, asks, context }).then(() => ACCEPTED).finally(() => {
        for (const ask of asks) {
          asking.delete(ask.token)
          closed.delete(ask.token)
        }
        forget()
        running.delete(submitted)
      })
      running.add(submitted)
      if (key !== undefined) {
        inFlight.set(key, submitted)
        // An aborted submit opens nothing more, so the group's next submit is a request of its own.
        context.signal.addEventListener('abort', forget, { once: true })
      }
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
      await Promise.allSettled([...running])
    },
  }
}

/** One request per call and group: a new group under the same call is asked afresh. */
function requestKey(asks: readonly FullAsk[]): string | undefined {
  const [first] = asks
  return first === undefined ? undefined : JSON.stringify([first.idempotencyKey, first.group])
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
