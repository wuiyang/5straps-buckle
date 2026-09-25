import { createInterface, type Interface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import type { ApprovalDecision, ApprovalRequest, GrantScope } from '@5straps/protocol'
import { describeQuestion } from '../../adapters/approval/cli-approval-channel.js'
import { QUIET_MS, discardTypedLine, pause, watchKeys, type KeyWatch } from '../../adapters/approval/terminal-keys.js'
import { remainingMs } from '../../domain/approval-deadline.js'
import { approveCommand } from '../../domain/approval-instruction.js'
import type { ActionLog } from '../../ports/action-log.js'
import { auditOperation } from '../../services/audit-operation.js'
import type { ApprovalRegistry } from '../../services/approval-registry.js'

/**
 * The node has no push channel for approvals: a request is a row in the state directory's
 * approvals file, which `buckle approve` and this command read like the node does. So the queue
 * is polled, quickly while requests arrive and backing off to the idle interval between them.
 */
export const WATCH_POLL_MS = { first: 500, idle: 2_000 }

/**
 * A grant needs its own key. Enter and anything unrecognised grant nothing and ask again. A
 * persisted grant takes the whole word, so no stray single key can write one.
 */
const SCOPE_KEYS: Array<{ key: string; scope: GrantScope; label: string }> = [
  { key: 'o', scope: 'once', label: 'once' },
  { key: 's', scope: 'session', label: 'session' },
  { key: 'always', scope: 'always', label: 'always' },
]

export interface ApprovalWatchOptions {
  approvals: Pick<ApprovalRegistry, 'pending' | 'resolve'>
  /** Each answer is audited on its own, as the `buckle approve` it stands in for. */
  actions: ActionLog
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
 *
 * No key answers a question the owner has not seen. A question takes keys only once the keyboard
 * has been still for `QUIET_MS` with it on screen, and a line typed before that is thrown away.
 * After a drop the next question also waits for a bare Enter, because the owner was mid-answer.
 *
 * It grants the host that asked and never a pattern. Widening per `BUCKLE-D18` means typing one,
 * which no single key or fixed word can stand for, so it stays with `buckle approve --host`.
 */
export async function watchApprovals(options: ApprovalWatchOptions): Promise<Outcome> {
  const poll = options.pollMs ?? WATCH_POLL_MS
  const stopped = new AbortController()
  // Terminal mode, so a half-typed line can be thrown away; no history, so an arrow key cannot
  // bring back an earlier answer.
  const readline = createInterface({ input: options.input, output: options.output, terminal: true, historySize: 0 })
  const keys = watchKeys(options.input)
  const stop = () => {
    if (stopped.signal.aborted) return
    stopped.abort()
    keys.stop()
    readline.close()
    options.output.write(`\nStopped watching workspace ${options.workspaceId}.\n`)
  }
  // With a listener here readline no longer closes on Ctrl-C by itself, so it is closed in stop.
  readline.on('SIGINT', stop)
  readline.on('close', stop)
  options.signal?.addEventListener('abort', stop, { once: true })

  options.output.write(`Watching workspace ${options.workspaceId} for approvals. Keys: o once, s session, the word always, d deny, n skip; Enter grants nothing. Ctrl-C stops.\n`)
  const seen = new Set<string>()
  let wait = poll.first
  let afterDrop = false
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
      if (afterDrop) {
        afterDrop = false
        // Read the queue again after the Enter: the request may have gone while the owner looked.
        if (await awaitEnter(readline, options.output, stopped.signal)) continue
        break
      }
      seen.add(next.token)
      afterDrop = await askOne({ ...options, readline, keys, request: next, stopped: stopped.signal, recheckMs: poll.first }) === 'dropped'
    }
    return { exitCode: 0 }
  } finally {
    options.signal?.removeEventListener('abort', stop)
    readline.off('close', stop)
    keys.stop()
    readline.close()
  }
}

/** False when the watch stopped instead. Keys typed before the note are already gone. */
async function awaitEnter(readline: Interface, output: Writable, stopped: AbortSignal): Promise<boolean> {
  output.write('  Another request is waiting. Press Enter to see it.\n')
  for (;;) {
    discardTypedLine(readline)
    try {
      if ((await readline.question('  > ', { signal: stopped })).trim() === '') return true
    } catch {
      return false
    }
    output.write('  Ignored; that answered nothing. Press Enter alone to see the next request.\n')
  }
}

type Ending = 'answered' | 'skipped' | 'dropped' | 'stopped'

async function askOne(context: ApprovalWatchOptions & { readline: Interface; keys: KeyWatch; request: ApprovalRequest; stopped: AbortSignal; recheckMs: number }): Promise<Ending> {
  const { request, output } = context
  const offered = SCOPE_KEYS.filter(entry => request.offeredScopes.includes(entry.scope))
  const prompt = `  ${[...offered.map(entry => `${entry.key}) ${entry.label}`), 'd) deny', 'n) skip'].join('  ')} > `
  output.write(`${describeQuestion(request)}  token: ${request.token}\n`)

  const dropped = new AbortController()
  const watcher = setInterval(() => {
    const pending = readPending(context)
    if (pending.ok && !pending.requests.some(entry => entry.token === request.token)) dropped.abort()
  }, context.recheckMs)
  const remaining = remainingMs(request.expiresAt)
  const signals = [context.stopped, dropped.signal]
  if (remaining !== Infinity) signals.push(AbortSignal.timeout(Math.min(Math.max(remaining, 1), 2_147_483_647)))
  const signal = AbortSignal.any(signals)
  try {
    // Keys already on their way were meant for the question before this one.
    await context.keys.quiet(QUIET_MS, signal)
    for (;;) {
      let answer: string
      try {
        signal.throwIfAborted()
        discardTypedLine(context.readline)
        answer = (await context.readline.question(prompt, { signal })).trim().toLowerCase()
      } catch {
        if (context.stopped.aborted) return 'stopped'
        output.write(`  ${request.token} ${remainingMs(request.expiresAt) === 0 ? 'expired' : 'was answered elsewhere'}; dropped.\n`)
        return 'dropped'
      }
      if (answer === 'n') {
        output.write(`  Skipped; still waiting. Answer later with: ${approveCommand({ request, workspaceId: context.workspaceId })}\n`)
        return 'skipped'
      }
      const decision = decide(request, answer, offered)
      if (decision) {
        await record(context, decision)
        return 'answered'
      }
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

/**
 * The same call `buckle approve` makes: the owner's own process, so the owner's authority. It is
 * audited the same way too, one entry per answer, so a session that grants several leaves several.
 */
async function record(context: ApprovalWatchOptions, decision: ApprovalDecision): Promise<void> {
  const result = await auditOperation({ actions: context.actions, workspaceId: context.workspaceId, tool: 'cli_approve', sessionId: 'local-owner',
    isSuccessful: outcome => outcome.ok, operation: () => context.approvals.resolve(decision, 'admin') })
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
