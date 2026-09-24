import { createInterface, type Interface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import type { ApprovalDecision, ApprovalRequest, GrantScope } from '@5straps/protocol'
import { describeQuestion } from '../../adapters/approval/cli-approval-channel.js'
import { remainingMs } from '../../domain/approval-deadline.js'
import { approveCommand } from '../../domain/approval-instruction.js'
import type { ApprovalRegistry } from '../../services/approval-registry.js'

/**
 * The node has no push channel for approvals: a request is a row in the state directory's
 * approvals file, which `buckle approve` and this command read like the node does. So the queue
 * is polled, quickly while requests arrive and backing off to the idle interval between them.
 */
export const WATCH_POLL_MS = { first: 500, idle: 2_000 }

/** A grant needs its own key. Enter and anything unrecognised grant nothing and ask again. */
const SCOPE_KEYS: Array<{ key: string; scope: GrantScope; label: string }> = [
  { key: 'o', scope: 'once', label: 'once' },
  { key: 's', scope: 'session', label: 'session' },
  { key: 'a', scope: 'always', label: 'always' },
]

export interface ApprovalWatchOptions {
  approvals: Pick<ApprovalRegistry, 'pending' | 'resolve'>
  workspaceId: string
  input: Readable
  output: Writable
  errors: Writable
  /** Stops the watch as Ctrl-C does, for an interrupt that arrives as a signal rather than a key. */
  signal?: AbortSignal
  pollMs?: { first: number; idle: number }
}

type Outcome = { exitCode: number }

/**
 * `buckle approvals --watch`: asks about each waiting request in turn, in a terminal of its own,
 * while `buckle serve` runs in another. An answer is resolved exactly as `buckle approve`
 * resolves one, under the owner's authority, so `BUCKLE-D14` holds as it does there.
 *
 * Each request is asked once. A skipped one stays waiting for another route, and a question whose
 * request expires or is answered elsewhere while on screen is dropped with a note. The first
 * Ctrl-C stops the watch; nothing is answered on the way out.
 */
export async function watchApprovals(options: ApprovalWatchOptions): Promise<Outcome> {
  const poll = options.pollMs ?? WATCH_POLL_MS
  const stopped = new AbortController()
  const readline = createInterface({ input: options.input, output: options.output })
  const stop = () => {
    if (stopped.signal.aborted) return
    stopped.abort()
    readline.close()
    options.output.write(`\nStopped watching workspace ${options.workspaceId}.\n`)
  }
  // With a listener here readline no longer closes on Ctrl-C by itself, so it is closed in stop.
  readline.on('SIGINT', stop)
  readline.on('close', stop)
  options.signal?.addEventListener('abort', stop, { once: true })

  options.output.write(`Watching workspace ${options.workspaceId} for approvals. Keys: o once, s session, a always, d deny, n skip; Enter grants nothing. Ctrl-C stops.\n`)
  const seen = new Set<string>()
  let wait = poll.first
  try {
    while (!stopped.signal.aborted) {
      const pending = readPending(options)
      if (!pending.ok) return unreachable(options, pending.message)
      const next = pending.requests.find(request => !seen.has(request.token))
      if (!next) {
        await pause(wait, stopped.signal)
        wait = Math.min(wait * 2, poll.idle)
        continue
      }
      wait = poll.first
      seen.add(next.token)
      await askOne({ ...options, readline, request: next, stopped: stopped.signal, recheckMs: poll.first })
    }
    return { exitCode: 0 }
  } finally {
    options.signal?.removeEventListener('abort', stop)
    readline.off('close', stop)
    readline.close()
  }
}

async function askOne(context: ApprovalWatchOptions & { readline: Interface; request: ApprovalRequest; stopped: AbortSignal; recheckMs: number }): Promise<void> {
  const { request, output } = context
  const offered = SCOPE_KEYS.filter(entry => request.offeredScopes.includes(entry.scope))
  const prompt = `  ${[...offered.map(entry => `${entry.key}) ${entry.label}`), 'd) deny', 'n) skip'].join('  ')} > `
  output.write(`${describeQuestion(request)}  token: ${request.token}\n`)

  const dropped = new AbortController()
  const watcher = setInterval(() => {
    const pending = readPending(context)
    if (pending.ok && !pending.requests.some(entry => entry.token === request.token)) dropped.abort()
  }, context.recheckMs)
  const signal = AbortSignal.any([context.stopped, dropped.signal, AbortSignal.timeout(Math.max(remainingMs(request.expiresAt), 1))])
  try {
    for (;;) {
      let answer: string
      try {
        answer = (await context.readline.question(prompt, { signal })).trim().toLowerCase()
      } catch {
        if (!context.stopped.aborted) output.write(`  ${request.token} ${remainingMs(request.expiresAt) === 0 ? 'expired' : 'was answered elsewhere'}; dropped.\n`)
        return
      }
      if (answer === 'n') {
        output.write(`  Skipped; still waiting. Answer later with: ${approveCommand({ request, workspaceId: context.workspaceId })}\n`)
        return
      }
      const decision = decide(request, answer, offered)
      if (decision) return record(context, decision)
      output.write(`  Nothing granted. Type ${offered.map(entry => entry.key).join(', ')}, d or n.\n`)
    }
  } finally {
    clearInterval(watcher)
  }
}

function decide(request: ApprovalRequest, answer: string, offered: typeof SCOPE_KEYS): ApprovalDecision | null {
  if (answer === 'd') return { token: request.token, approved: false, scope: 'once' }
  const chosen = offered.find(entry => entry.key === answer)
  return chosen ? { token: request.token, approved: true, scope: chosen.scope } : null
}

/** The same call `buckle approve` makes: the owner's own process, so the owner's authority. */
function record(context: ApprovalWatchOptions, decision: ApprovalDecision): void {
  const result = context.approvals.resolve(decision, 'admin')
  if (!result.ok) {
    context.output.write(`  Not recorded: ${result.reason}.\n`)
    return
  }
  context.output.write(`  ${decision.approved ? `Approved (${decision.scope})` : 'Denied'} ${decision.token} in workspace ${context.workspaceId}.\n`)
}

function readPending(options: Pick<ApprovalWatchOptions, 'approvals'>): { ok: true; requests: ApprovalRequest[] } | { ok: false; message: string } {
  try {
    return { ok: true, requests: options.approvals.pending() }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Unknown error' }
  }
}

function unreachable(options: ApprovalWatchOptions, message: string): Outcome {
  options.errors.write(`Cannot read the approvals waiting in workspace ${options.workspaceId}: ${message}. Check that BUCKLE_STATE_DIR names the state directory of the running node.\n`)
  return { exitCode: 1 }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
