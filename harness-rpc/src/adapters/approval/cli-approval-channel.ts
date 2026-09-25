import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import type { ApprovalDecision, ApprovalRequest, GrantScope } from '@5straps/protocol'
import { describeExpiry, remainingMs } from '../../domain/approval-deadline.js'
import { createSerialQueue } from '../../domain/serial-queue.js'
import type { ApprovalChannel } from '../../ports/approval-channel.js'
import { QUIET_MS, discardTypedLine, watchKeys, type KeyWatch } from './terminal-keys.js'

export interface CliApprovalOptions {
  /** Where the question is asked. This process's terminal unless a caller names another. */
  input?: Readable
  output?: Writable
  /**
   * What Ctrl-C does once every question is dropped. By default SIGINT is raised again, so the
   * process stops exactly as it would have with no question open.
   */
  onInterrupt?: () => void
}

/**
 * Interactive prompt for direct terminal use. Silent when stdin is not a TTY.
 *
 * Questions are queued and answered one at a time. A terminal cannot be navigated, so two
 * prompts sharing stdin would interleave their text and race for the same keystroke: a request
 * arriving while someone is reading could take the answer meant for the one they were shown.
 * Serialising it means the answer always belongs to the question on screen.
 *
 * Serialising is not enough on its own: the next question opens the moment the last one ends,
 * sooner than anyone reads it. So a question takes keys only after `QUIET_MS` with no typing,
 * and whatever was typed before that, including keys held while no question was open, is thrown
 * away. Enter still denies once the prompt is showing.
 *
 * Each question is abandoned when its own request expires, which is the deadline that belongs to
 * a terminal someone is sitting at — the grace period is the server's, and is far shorter. Both
 * `buckle serve` and a direct `buckle fs write` therefore have a question that ends: the queue
 * moves on to one that is still answerable instead of holding the terminal for a dead token.
 *
 * Ctrl-C at a question stops the process, not just that question. A question lives until its
 * request expires, and every gated call queues its own, so dropping one at a time would take a
 * key press per question to stop `buckle serve`. The first Ctrl-C drops the whole queue, closes
 * the terminal, and raises SIGINT again for the process to shut down as usual.
 */
export function createCliApprovalChannel(options: CliApprovalOptions = {}): ApprovalChannel {
  const queue = createSerialQueue()
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stderr
  const interrupted = new AbortController()
  const onInterrupt = options.onInterrupt ?? (() => process.kill(process.pid, 'SIGINT'))
  const interrupt = () => {
    if (interrupted.signal.aborted) return
    interrupted.abort()
    onInterrupt()
  }

  return {
    id: 'cli',
    request(requests, signal) {
      if (!process.stdin.isTTY || interrupted.signal.aborted) return Promise.resolve(null)
      const cancelled = signal ? AbortSignal.any([signal, interrupted.signal]) : interrupted.signal
      return queue(() => ask({ requests, signal: cancelled, input, output, interrupt }))
    },
  }
}

async function ask(context: { requests: ApprovalRequest[]; signal: AbortSignal; input: Readable; output: Writable; interrupt: () => void }): Promise<ApprovalDecision[] | null> {
  // The wait for our turn may have outlasted the grace period, another route may have answered,
  // or Ctrl-C dropped the queue.
  if (context.signal.aborted) return null
  // A request whose expiry passed while it queued resolves no longer, so it is not worth asking.
  if (context.requests.some(request => remainingMs(request.expiresAt) === 0)) return null

  const readline = createInterface({ input: context.input, output: context.output, historySize: 0 })
  const keys = watchKeys(context.input)
  // With a listener here readline no longer closes on Ctrl-C by itself, so close it first: the
  // terminal is restored before the process is told to stop.
  readline.on('SIGINT', () => {
    readline.close()
    context.interrupt()
  })
  try {
    const decisions: ApprovalDecision[] = []
    for (const request of context.requests) decisions.push(await promptOne({ readline, keys, request, signal: context.signal, output: context.output }))
    return decisions
  } catch {
    // Aborted mid-question: the request expired, the decision came from somewhere else, or Ctrl-C.
    return null
  } finally {
    keys.stop()
    readline.close()
  }
}

async function promptOne(context: {
  readline: ReturnType<typeof createInterface>
  keys: KeyWatch
  request: ApprovalRequest
  signal: AbortSignal
  output: Writable
}): Promise<ApprovalDecision> {
  const { request } = context
  const choices = request.offeredScopes.map((scope, index) => `${index + 1}) ${scopeLabel(scope)}`).join('  ')
  context.output.write(describeQuestion(request))
  const deadline = questionDeadline(request, context.signal)
  await context.keys.quiet(QUIET_MS, deadline)
  deadline.throwIfAborted()
  discardTypedLine(context.readline)
  const answer = (await context.readline.question(`  ${choices}  n) deny > `, { signal: deadline })).trim().toLowerCase()

  const chosenIndex = Number.parseInt(answer, 10) - 1
  const scope = request.offeredScopes[chosenIndex]
  if (!scope) return { token: request.token, approved: false, scope: 'once' }
  return { token: request.token, approved: true, scope }
}

/** What a terminal question shows, shared with `buckle approvals --watch` so both read alike. */
export function describeQuestion(request: ApprovalRequest): string {
  return `\n${request.tool} needs approval\n  ${request.reason}\n  subject: ${request.subject}\n  ${describeExpiry(request.expiresAt)}\n`
}

/** The request's own expiry, plus whatever the caller is already watching for. */
function questionDeadline(request: ApprovalRequest, signal: AbortSignal): AbortSignal {
  const remaining = remainingMs(request.expiresAt)
  return remaining === Infinity ? signal : AbortSignal.any([signal, AbortSignal.timeout(Math.min(remaining, 2_147_483_647))])
}

function scopeLabel(scope: GrantScope): string {
  if (scope === 'once') return 'allow once'
  if (scope === 'session') return 'allow this session'
  return 'always allow'
}
