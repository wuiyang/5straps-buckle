import { createInterface, type Interface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import type { ApprovalRequest, GrantScope } from '@5straps/protocol'
import { describeQuestion, marked } from './terminal-consumer.js'
import { QUIET_MS, discardTypedLine, pause, watchKeys, type KeyWatch } from './terminal-keys.js'
import { remainingMs } from '../common/domain/approval/expiry.js'
import { approveCommand, denyCommand, describeAskOfShownCall, printable, workspaceLabel } from '../common/domain/approval-instruction.js'
import type { CoreApprovalApi } from '../common/services/approvals/core-approval-api.js'
import type { PendingAsk } from '../common/services/approvals/approval-registry.js'
import { saveAnswerOf, saveChoices, saveEndingLine, settleUnsaved, unsavedOf, type SaveAnswer, type Unsaved } from '../common/adapters/approval/grant-save-question.js'
import type { DecisionBody } from '../common/types/ports/approval-backend.js'

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
const SCOPE_KEYS: Array<{ key: string; scope: GrantScope; label: string; wider?: true }> = [
  { key: 'o', scope: 'once', label: 'once' },
  { key: 's', scope: 'session', label: 'session' },
  { key: 'always', scope: 'always', label: 'always' },
]

/** The wider subject's keys (the delete policy brief): the session or always, for a delete's folder and its subfolders. */
const WIDER_KEYS: typeof SCOPE_KEYS = [
  { key: 'sb', scope: 'session', label: 'session, folder and below', wider: true },
  { key: 'always-below', scope: 'always', label: 'always, folder and below', wider: true },
]

/** One workspace's queue a watch asks from. */
export interface WatchSource {
  /**
   * The asks waiting, each with the whole call it came from, the requests alone for the check a question on screen
   * makes while it waits, and the decision and the skip of its save `buckle approve` makes.
   */
  approvals: Pick<CoreApprovalApi, 'waiting' | 'pending' | 'decide' | 'skipSave'>
  workspaceId: string
  workspaceName?: string
  /** Whether the workspace's thorough stage can approve, which an unrated ask's judge line says (D91 follow-up F6). */
  judgeApproves?: () => boolean
}

export interface ApprovalWatchOptions {
  /**
   * The workspaces it asks for, read again at each poll: the one --workspace names, or every online one as it stands,
   * so one initialised or enabled meanwhile is asked about too (Q9, finding 10 of the Phase 1 review).
   */
  sources: () => Promise<WatchSource[]>
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
 * resolves one, as the `cli` source, so `BUCKLE-D14` holds as it does there.
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
  let sources: WatchSource[]
  try { sources = await options.sources() } catch (error) { return unreadableWorkspaces(options, error) }
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
    options.output.write(`\nStopped watching ${watched(sources)}.\n`)
  }
  // With a listener here readline no longer closes on Ctrl-C by itself, so it is closed in stop.
  readline.on('SIGINT', stop)
  readline.on('close', stop)
  options.signal?.addEventListener('abort', stop, { once: true })

  options.output.write(`Watching ${watched(sources)} for approvals. Keys: o once, s session, the word always, d deny, n skip; Enter grants nothing. Ctrl-C stops.\n`)
  // An interrupt that came while the workspaces were first read fires no listener of its own.
  if (options.signal?.aborted) stop()
  // By workspace and token, as a token is issued within one workspace's queue.
  const seen = new Set<string>()
  // Each request group's whole action is shown with the first of its asks asked here; the others name that ask
  // (review M1 of the slice 5 re-review).
  const shownWith = new Map<string, string>()
  let wait = poll.first
  let afterDrop = false
  try {
    while (!stopped.signal.aborted) {
      let now: WatchSource[]
      try { now = await options.sources() } catch (error) { return unreadableWorkspaces(options, error) }
      announceChanges(options.output, sources, now)
      sources = now
      const pending = readPending(sources)
      if (!pending.ok) return unreachable(options, pending.source, pending.message)
      const next = pending.asks.find(({ source, ask }) => !seen.has(askKey(source, ask.request.token)))
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
      const { source, ask } = next
      seen.add(askKey(source, ask.request.token))
      const group = ask.callRef === undefined ? undefined : askKey(source, ask.callRef)
      const earlier = group === undefined ? undefined : shownWith.get(group)
      if (group !== undefined && earlier === undefined && ask.call?.complete) shownWith.set(group, ask.request.token)
      afterDrop = await askOne({ ...options, ...source, readline, keys, request: ask.request, call: ask.call, shownWith: earlier, stopped: stopped.signal, recheckMs: poll.first }) === 'dropped'
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

type AskContext = ApprovalWatchOptions & WatchSource & { readline: Interface; keys: KeyWatch; request: ApprovalRequest; call: PendingAsk['call']; shownWith: string | undefined; stopped: AbortSignal; recheckMs: number }

async function askOne(context: AskContext): Promise<Ending> {
  const { request, call, output } = context
  // The whole action (owner decision D17), or, for a later ask of a group, the ask and the one its action was shown
  // with above. An ask recorded before this build shows its request and the note, and offers denials only: nobody
  // approves an action they were not shown whole (review L9).
  const shown = call?.complete ? call : undefined
  const offered = shown ? [...SCOPE_KEYS, ...(request.widerSubject === undefined ? [] : WIDER_KEYS)].filter(entry => request.offeredScopes.includes(entry.scope)) : []
  const prompt = `${marked(context, [''])[0]}  ${[...offered.map(entry => `${entry.key}) ${request.rule === 'sensitive_path' && entry.scope === 'once' ? 'allow once' : entry.label}`), 'd) deny', ...(request.rule === 'sensitive_path' ? ['ds) deny this session', 'da) always deny'] : []), 'n) skip'].join('  ')} > `
  const question = { ...request, workspaceId: context.workspaceId, ...(context.workspaceName === undefined ? {} : { workspaceName: context.workspaceName }), ...(context.judgeApproves ? { approves: context.judgeApproves() } : {}), ...(shown ? { call: shown } : {}) }
  output.write(`${shown && context.shownWith !== undefined ? `\n${marked(question, describeAskOfShownCall(question, context.shownWith)).join('\n')}\n` : describeQuestion(question)}${marked(question, [`  token: ${request.token}`])[0]}\n`)

  // The requests alone: a question on screen checks every poll that its ask still waits, and reads no call to do it.
  const dropped = new AbortController()
  const watcher = setInterval(() => {
    try {
      if (!context.approvals.pending().some(entry => entry.token === request.token)) dropped.abort()
    } catch {
      // Unreadable for now: the next poll, the expiry or the person ends the question.
    }
  }, context.recheckMs)
  const remaining = remainingMs(request.expiresAt)
  // Node timers run on the cached loop time, so this can fire a moment before the wall clock passes expiresAt.
  const expiry = remaining === Infinity ? null : AbortSignal.timeout(Math.min(Math.max(remaining, 1), 2_147_483_647))
  const signal = AbortSignal.any([context.stopped, dropped.signal, ...(expiry ? [expiry] : [])])
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
        const expired = expiry?.aborted === true || remainingMs(request.expiresAt) === 0
        output.write(`  ${request.token} ${expired ? 'expired' : 'was answered elsewhere'}; dropped.\n`)
        return 'dropped'
      }
      if (answer === 'n') {
        // An ask recorded before this build is denied, never approved (review L6 of the slice 5 re-review).
        output.write(`  Skipped; still waiting. Answer later with: ${shown ? approveCommand({ request, ...named(context) }) : denyCommand({ request, ...named(context) })}\n`)
        return 'skipped'
      }
      const decision = decide(request, answer, offered)
      if (decision) {
        await record(context, decision)
        return 'answered'
      }
      output.write(`  Nothing granted. Type ${[...offered.map(entry => entry.key), 'd'].join(', ')} or n.\n`)
    }
  } finally {
    clearInterval(watcher)
  }
}

function decide(request: ApprovalRequest, answer: string, offered: typeof SCOPE_KEYS): DecisionBody | null {
  if (request.rule === 'sensitive_path' && (answer === 'ds' || answer === 'da')) return { token: request.token, outcome: 'deny', scope: answer === 'ds' ? 'session' : 'always' }
  if (answer === 'd') return { token: request.token, outcome: 'deny', scope: 'once' }
  const chosen = offered.find(entry => entry.key === answer)
  if (!chosen) return null
  return { token: request.token, outcome: 'approve', scope: chosen.scope, ...(chosen.wider && request.widerSubject !== undefined ? { widen: 'below' as const } : {}) }
}

/**
 * The same decision `buckle approve` makes, through the core approval API: the owner's own process, so
 * the `cli` source. Core records each one in its workspace's log, so a session that grants several
 * leaves several. One whose grant did not save asks a save question next, as `buckle approve` does.
 */
async function record(context: AskContext, decision: DecisionBody): Promise<void> {
  const receipt = await context.approvals.decide({ source: 'cli', decision })
  const unsaved = unsavedOf({ decision, receipt })
  if (receipt.status === 'refused' && unsaved === undefined) {
    context.output.write(`  Not recorded: ${receipt.error.message}.\n`)
    return
  }
  if (receipt.status !== 'refused') {
    const granted = receipt.status === 'applied' ? receipt.granted : undefined
    context.output.write(`  ${decision.outcome === 'approve' ? `Approved (${decision.scope})` : 'Denied'} ${decision.token}${granted === undefined ? '' : ` for ${printable(granted)}`} in workspace ${workspaceLabel(context.workspaceId, context.workspaceName)} (scope: ${decision.scope}).\n`)
  }
  if (unsaved === undefined) return
  const { token } = decision
  // The core approval API, as buckle approve holds it.
  const api = context.approvals
  const ending = await settleUnsaved({
    decision, unsaved,
    route: {
      ask: asked => askSave(context, asked),
      retry: () => api.decide({ source: 'cli', decision }),
      skipSave: () => api.skipSave({ source: 'cli', token }),
      denyOnce: () => api.decide({ source: 'cli', decision: { token, outcome: 'deny', scope: 'once' } }),
    },
  })
  context.output.write(`  ${saveEndingLine(ending)}\n`)
}

/** The save question, asked on the watch's own line as its questions are; Ctrl-C leaves it unanswered. */
async function askSave(context: AskContext, unsaved: Unsaved): Promise<SaveAnswer | undefined> {
  context.output.write(`  ${unsaved.warning}.\n`)
  try {
    await context.keys.quiet(QUIET_MS, context.stopped)
    context.stopped.throwIfAborted()
    discardTypedLine(context.readline)
    return saveAnswerOf(unsaved.kind, await context.readline.question(`  ${saveChoices(unsaved.kind)} > `, { signal: context.stopped }))
  } catch {
    return undefined
  }
}

/** The workspace a source's commands name: its name where the source carries one, else its id. */
function named(source: Pick<WatchSource, 'workspaceId' | 'workspaceName'>): { workspaceId: string; workspaceName?: string } {
  return { workspaceId: source.workspaceId, ...(source.workspaceName === undefined ? {} : { workspaceName: source.workspaceName }) }
}

function readPending(sources: WatchSource[]): { ok: true; asks: Array<{ source: WatchSource; ask: PendingAsk }> } | { ok: false; source: WatchSource; message: string } {
  const asks: Array<{ source: WatchSource; ask: PendingAsk }> = []
  for (const source of sources) {
    try {
      asks.push(...source.approvals.waiting().map(ask => ({ source, ask })))
    } catch (error) {
      return { ok: false, source, message: error instanceof Error ? error.message : 'Unknown error' }
    }
  }
  return { ok: true, asks }
}

function askKey(source: WatchSource, key: string): string {
  return JSON.stringify([source.workspaceId, key])
}

/** Says which workspaces a watch started or stopped asking for since its last poll. */
function announceChanges(output: Writable, before: WatchSource[], after: WatchSource[]): void {
  const held = (list: WatchSource[], source: WatchSource) => list.some(other => other.workspaceId === source.workspaceId)
  for (const source of after) if (!held(before, source)) output.write(`Now also watching workspace ${workspaceLabel(source.workspaceId, source.workspaceName)}.\n`)
  for (const source of before) if (!held(after, source)) output.write(`Stopped watching workspace ${workspaceLabel(source.workspaceId, source.workspaceName)}, which is no longer online.\n`)
}

function unreadableWorkspaces(options: ApprovalWatchOptions, error: unknown): Outcome {
  options.errors.write(`Cannot read which workspaces are online: ${error instanceof Error ? error.message : 'Unknown error'}.\n`)
  return { exitCode: 1 }
}

/** The workspaces a watch asks for, as its first and last lines name them. */
function watched(sources: WatchSource[]): string {
  const labels = sources.map(source => workspaceLabel(source.workspaceId, source.workspaceName))
  return labels.length === 1 ? `workspace ${labels[0]}` : `workspaces ${labels.join(', ')}`
}

function unreachable(options: ApprovalWatchOptions, source: WatchSource, message: string): Outcome {
  options.errors.write(`Cannot read the approvals waiting in workspace ${workspaceLabel(source.workspaceId, source.workspaceName)}: ${message}. Check that BUCKLE_STATE_DIR names the state directory of the running node.\n`)
  return { exitCode: 1 }
}
