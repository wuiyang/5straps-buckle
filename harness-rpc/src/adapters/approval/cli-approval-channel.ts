import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import type { ApprovalDecision, ApprovalRequest, GrantScope } from '@5straps/protocol'
import { describeExpiry, remainingMs } from '../../domain/approval-deadline.js'
import { createSerialQueue } from '../../domain/serial-queue.js'
import type { ApprovalChannel } from '../../ports/approval-channel.js'

export interface CliApprovalOptions {
  /** Where the question is asked. This process's terminal unless a caller names another. */
  input?: Readable
  output?: Writable
}

/**
 * Interactive prompt for direct terminal use. Silent when stdin is not a TTY.
 *
 * Questions are queued and answered one at a time. A terminal cannot be navigated, so two
 * prompts sharing stdin would interleave their text and race for the same keystroke: a request
 * arriving while someone is reading could take the answer meant for the one they were shown.
 * Serialising it means the answer always belongs to the question on screen.
 *
 * Each question is abandoned when its own request expires, which is the deadline that belongs to
 * a terminal someone is sitting at — the grace period is the server's, and is far shorter. Both
 * `buckle serve` and a direct `buckle fs write` therefore have a question that ends: the queue
 * moves on to one that is still answerable instead of holding the terminal for a dead token.
 */
export function createCliApprovalChannel(options: CliApprovalOptions = {}): ApprovalChannel {
  const queue = createSerialQueue()
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stderr

  return {
    id: 'cli',
    request(requests, signal) {
      if (!process.stdin.isTTY) return Promise.resolve(null)
      return queue(() => ask({ requests, signal, input, output }))
    },
  }
}

async function ask(context: { requests: ApprovalRequest[]; signal?: AbortSignal; input: Readable; output: Writable }): Promise<ApprovalDecision[] | null> {
  // The wait for our turn may have outlasted the grace period, or another route may have answered.
  if (context.signal?.aborted) return null
  // A request whose expiry passed while it queued resolves no longer, so it is not worth asking.
  if (context.requests.some(request => remainingMs(request.expiresAt) === 0)) return null

  const readline = createInterface({ input: context.input, output: context.output })
  try {
    const decisions: ApprovalDecision[] = []
    for (const request of context.requests) decisions.push(await promptOne({ readline, request, signal: context.signal, output: context.output }))
    return decisions
  } catch {
    // Aborted mid-question: the request expired, or the decision came from somewhere else.
    return null
  } finally {
    readline.close()
  }
}

async function promptOne(context: {
  readline: ReturnType<typeof createInterface>
  request: ApprovalRequest
  signal?: AbortSignal
  output: Writable
}): Promise<ApprovalDecision> {
  const { request } = context
  const choices = request.offeredScopes.map((scope, index) => `${index + 1}) ${scopeLabel(scope)}`).join('  ')
  context.output.write(`\n${request.tool} needs approval\n  ${request.reason}\n  subject: ${request.subject}\n  ${describeExpiry(request.expiresAt)}\n`)
  const answer = (await context.readline.question(`  ${choices}  n) deny > `, { signal: questionDeadline(request, context.signal) })).trim().toLowerCase()

  const chosenIndex = Number.parseInt(answer, 10) - 1
  const scope = request.offeredScopes[chosenIndex]
  if (!scope) return { token: request.token, approved: false, scope: 'once' }
  return { token: request.token, approved: true, scope }
}

/** The request's own expiry, plus whatever the caller is already watching for. */
function questionDeadline(request: ApprovalRequest, signal?: AbortSignal): AbortSignal {
  const expiry = AbortSignal.timeout(remainingMs(request.expiresAt))
  return signal ? AbortSignal.any([signal, expiry]) : expiry
}

function scopeLabel(scope: GrantScope): string {
  if (scope === 'once') return 'allow once'
  if (scope === 'session') return 'allow this session'
  return 'always allow'
}
