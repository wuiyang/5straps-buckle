import { clearScreenDown, cursorTo, moveCursor } from 'node:readline'
import { createInterface, type Interface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import type { CliConsumer, CliConsumerResult, CliRequest } from '@5straps/runtime'
import { ApprovalSeveritySchema, JsonValueSchema, PermissionRuleIdSchema, GrantScopeSchema, type GrantScope, type PermissionRuleId } from '@5straps/protocol'
import { z } from 'zod'
import { actionPhrase } from '../common/domain/action-phrase.js'
import { describeLocalExpiry, remainingMs } from '../common/domain/approval-deadline.js'
import { describeAsk, printable, type ShownAsk } from '../common/domain/approval-instruction.js'
import { localTime } from '../common/domain/local-time.js'
import { createConsoleWriter, screenKind, type ConsoleWriter, type PromptRelease } from '../common/runtime/console.js'
import type { ApprovalChoice } from '../common/services/approvals/approval-service.js'
import { APPROVAL_REQUEST_KIND } from '../common/services/approvals/interaction.js'
import { QUIET_MS, discardTypedLine, watchKeys } from './terminal-keys.js'

export interface TerminalOptions {
  /** Where the question is asked. This process's terminal unless a caller names another. */
  input?: Readable
  output?: Writable
  /**
   * What Ctrl-C does once every question is dropped. By default the process is interrupted again
   * (interruptSelf), so it stops exactly as it would have with no question open.
   */
  onInterrupt?: () => void
  /** The writer its questions share with the process's log lines and workspace list (`buckle serve`, the CLI display slice C3); their own otherwise. */
  console?: ConsoleWriter
}

/** What interrupting the process needs of it; the process itself unless a test hands in its own. */
export interface InterruptTarget {
  readonly pid: number
  kill(pid: number, signal: NodeJS.Signals): unknown
  listenerCount(event: 'SIGINT'): number
  emit(event: 'SIGINT', signal: NodeJS.Signals): unknown
  exit(code: number): unknown
}

/**
 * Stops the process as a Ctrl-C with no question open would. On Linux and macOS SIGINT is raised
 * again. Windows has no signal a process can send itself: process.kill ends it at once, before any
 * close step runs, so there the SIGINT listeners run directly, main's stop among them, and with none
 * the process exits as an interrupted one does.
 */
export function interruptSelf(platform: NodeJS.Platform = process.platform, target: InterruptTarget = process): void {
  if (platform !== 'win32') {
    target.kill(target.pid, 'SIGINT')
    return
  }
  if (target.listenerCount('SIGINT') > 0) target.emit('SIGINT', 'SIGINT')
  else target.exit(130)
}

/**
 * What a question shows; an approval request carries every field, so `buckle approvals --watch` shares it.
 * Without `call` (an ask recorded before this build) it is shown with the note and offers denials only.
 */
export interface ApprovalQuestion extends ShownAsk {
  rule: PermissionRuleId
  offeredScopes: GrantScope[]
}

/** A JSON text a question carries in one detail, since details hold strings. */
const jsonText = <T extends z.ZodType>(schema: T) => z.string().transform((value, context) => {
  try {
    return JSON.parse(value) as unknown
  } catch {
    context.addIssue({ code: 'custom', message: 'not JSON' })
    return z.NEVER
  }
}).pipe(schema)

const QuestionDetailsSchema = z.object({
  severity: ApprovalSeveritySchema.optional(),
  tool: z.string(), rule: PermissionRuleIdSchema, subject: z.string(), wider: z.string().optional(), reason: z.string(),
  scopes: z.string().transform(value => value.split(',')).pipe(z.array(GrantScopeSchema).min(1)),
  expiresAt: z.string(), workspace: z.string().optional(), workspaceName: z.string().optional(), node: z.string().optional(),
  arguments: jsonText(JsonValueSchema).optional(), cwd: z.string().optional(), description: z.string().optional(), effects: jsonText(z.array(z.string())).optional(),
  judge: z.string().optional(),
})

/**
 * How close to its expiry a question that ends still timed out: the requester's timer is set from the clock, and on a
 * busy loop it fires up to a millisecond before the clock reaches the expiry (fix brief 1, H3). Far below the 400 ms poll
 * that withdraws an expired ask, so an answer given elsewhere this late is the rare case.
 */
const TIMER_JITTER_MS = 50

/** The terminal's consumer, told when the process stops, so a question it drops then says so on its prompt row (C4). */
export interface TerminalConsumer extends CliConsumer {
  /** setupCli's close is under way: a question dropped from now on ends with `[stopped]`. */
  stopping(): void
}

/**
 * The one interactive terminal, attached to the process's requester: questions reach it one at a
 * time, in order, and each answer belongs to the question on screen. It answers with a choice only;
 * the approval service decides which token that choice is for.
 *
 * A queue is not enough on its own: the next question opens the moment the last one ends, sooner
 * than anyone reads it. So a question takes keys only after `QUIET_MS` with no typing, and whatever
 * was typed before that, including keys held while no question was open, is thrown away. Enter still
 * denies once the prompt is showing.
 *
 * A question ends when its request expires, which is the deadline of a terminal someone is sitting
 * at; the requester times it out from the request's own wait. A question that ends unanswered says why
 * on its prompt row (the CLI display slice, C4).
 *
 * Ctrl-C at a question stops the process, not just that question: every gated call queues its own,
 * so dropping one at a time would take a key press per question to stop `buckle serve`. The first
 * Ctrl-C closes the terminal and calls `onInterrupt`, whose caller detaches this consumer, which
 * drops every queued question, and interrupts the process again for it to shut down as usual.
 */
export function createTerminalConsumer(options: TerminalOptions = {}): TerminalConsumer {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stderr
  const writer = options.console ?? createConsoleWriter({ output, dates: false })
  const interrupted = new AbortController()
  let stopping = false
  const onInterrupt = options.onInterrupt ?? (() => interruptSelf())
  const interrupt = () => {
    if (interrupted.signal.aborted) return
    interrupted.abort()
    onInterrupt()
  }

  /**
   * Why a question on screen ended unanswered: nothing after Ctrl-C, as the shutdown lines follow; `[timeout]` by the
   * clock, within TIMER_JITTER_MS, since the poll that withdraws an expired ask often ends its question before the
   * requester's own timer does;
   * `[stopped]` once the process stops; `[no longer waiting]` for an answer given elsewhere or a call withdrawn.
   */
  const ending = (question: ApprovalQuestion): string | null => {
    if (interrupted.signal.aborted) return null
    if (remainingMs(question.expiresAt) <= TIMER_JITTER_MS) return '[timeout]'
    return stopping ? '[stopped]' : '[no longer waiting]'
  }

  return {
    stopping() {
      stopping = true
    },
    async prompt(request, { signal }) {
      if (request.kind === 'history_recovery') return recoveryPrompt({ request, input, writer, signal: AbortSignal.any([signal, interrupted.signal]), interrupt })
      const question = approvalQuestion(request)
      const cancelled = AbortSignal.any([signal, interrupted.signal])
      cancelled.throwIfAborted()
      // A request that expired while it queued resolves no longer: not worth showing, its wait ends it.
      if (remainingMs(question.expiresAt) === 0) return new Promise<never>((_, reject) => cancelled.addEventListener('abort', () => reject(cancelled.reason), { once: true }))
      const readline = createInterface({ input, output, historySize: 0 })
      const keys = watchKeys(input)
      // With a listener here readline no longer closes on Ctrl-C by itself, so close it first: the
      // terminal is restored before the process is told to stop.
      readline.on('SIGINT', () => {
        readline.close()
        interrupt()
      })
      // Closed the moment the question ends, before the requester opens the next one on the same input: a close after
      // that would pause the input the next question reads.
      cancelled.addEventListener('abort', () => readline.close(), { once: true })
      const row = promptRow({ question, output, readline, writer })
      try {
        const at = new Date()
        // After every line logged before it (C3).
        await writer.block(approvalBlock(question, at), at)
        row.blockShown(cancelled)
        await keys.quiet(QUIET_MS, cancelled)
        cancelled.throwIfAborted()
        discardTypedLine(readline)
        const typed = await row.ask(cancelled)
        const answer = typed.trim().toLowerCase()
        const choice = choiceFor(question, answer)
        row.answered(typed, choice === 'deny' && answer !== 'n')
        return { status: 'answered', answer: { choice } }
      } catch (error) {
        if (cancelled.aborted) row.ended(ending(question))
        throw error
      } finally {
        // After what the row says, so a line logged as the question ended lands below it (fix brief 1, H1).
        row.release()
        keys.stop()
        readline.close()
      }
    },
  }
}

/**
 * A question as the serve terminal shows it (the CLI display slice, C4): a head line with the time, the `[approval]`
 * tag, the workspace, and what the tool does in Buckle's words; then the ask and its whole action as every route shows
 * them (owner decision D17), the expiry on this device's clock; then the choices it takes. Every line carries the
 * workspace's `[<name>]` (D85, Q15).
 */
export function approvalBlock(question: ApprovalQuestion, at: Date): string[] {
  return [
    `${localTime(at)} [approval] ${markOf(question)}action pending approval: ${actionPhrase(question.tool)}`,
    ...marked(question, [...describeAsk(question, describeLocalExpiry), choicesLine(question)]),
  ]
}

/**
 * What a terminal question shows, shared with `buckle approvals --watch` so both read alike: the ask,
 * then the whole action it came from (owner decision D17), nothing cut or paged, or the note for an ask
 * recorded before this build. The agent chose the tool call, so its text is shown with control characters escaped.
 */
export function describeQuestion(question: ApprovalQuestion): string {
  return `\n${marked(question, describeAsk(question)).join('\n')}\n`
}

/**
 * Each line marked `[<name>]` with the workspace it waits in (the workspace-model brief, item 6; D85, Q15): a terminal
 * serving several workspaces, and logging beside them, shows which one a question is from on every line of it.
 */
export function marked(question: Pick<ApprovalQuestion, 'workspaceId' | 'workspaceName'>, lines: string[]): string[] {
  const handle = question.workspaceName ?? question.workspaceId
  return handle === undefined ? lines : lines.map(line => `[${printable(handle)}] ${line}`)
}

/** `[<name>] ` for the workspace a question waits in, or nothing where it names none. */
function markOf(question: Pick<ApprovalQuestion, 'workspaceId' | 'workspaceName'>): string {
  return marked(question, [''])[0]!
}

/**
 * A question's one prompt row, `[<name>] Your choice: `, short enough to fit a row of a terminal so a log line can be
 * drawn above it (C3), and what is written on it once the question ends (C4). Readline echoes what is typed at a
 * terminal and ends the row on Enter and on an abort; the tag of a denial by Enter or an unknown key, or of an ending
 * with no answer, is then written back on the row it ended, the half-typed text cleared. Where the output is no
 * terminal, readline echoes nothing, and the row is written whole.
 *
 * Columns come from readline, which counts a wide character as two, never from a string's length; and from the moment
 * the question ends until the row is written, the writer holds every line it is handed (fix brief 1, H1).
 *
 * Where `TERM` is `dumb` the output is a terminal that prints cursor escapes as text: readline still echoes the typed
 * text and ends the row on Enter and on an abort, but nothing here moves the cursor, so a denial and an ending are
 * written as a row of their own below the one readline ended.
 */
function promptRow(input: { question: ApprovalQuestion; output: Writable; readline: Interface; writer: ConsoleWriter }) {
  const { output, readline } = input
  const text = `${markOf(input.question)}Your choice: `
  const screen = screenKind(output)
  let prompted: PromptRelease | undefined
  let waiting: PromptRelease | undefined
  let promptColumns = 0
  let rowsTypedAtEnd = 0
  let extraLines = 0
  return {
    /**
     * The block is on screen and the prompt is not, for the half second of quiet: a line logged now is written at once,
     * as it always was, but a question that ends here holds the lines that follow, so its ending comes straight below the
     * choices line and what was logged in its turn below the ending (fix brief 2, L2).
     */
    blockShown(signal: AbortSignal): void {
      const quiet = input.writer.holding()
      waiting = quiet
      if (signal.aborted) quiet.hold()
      else signal.addEventListener('abort', quiet.hold, { once: true })
    },
    async ask(signal: AbortSignal): Promise<string> {
      // The quiet is over: the hold the abort below takes is the one that counts from here.
      waiting?.()
      const held = input.writer.asking(readline)
      prompted = held
      // Before readline's own listener, which clears the line it holds as the question is cancelled: the rows the typed
      // text reached, then the hold, so no line lands between readline's last row and the ending.
      signal.addEventListener('abort', () => {
        rowsTypedAtEnd = readline.getCursorPos().rows
        held.hold()
      }, { once: true })
      // A paste with a second Enter ends one more row before the answer is written; the question's own line is never one.
      readline.on('line', () => { extraLines += 1 })
      try {
        const answer = readline.question(text, { signal })
        promptColumns = readline.getCursorPos().cols
        return await answer
      } finally {
        held.hold()
      }
    },
    answered(typed: string, denied: boolean): void {
      const tag = denied ? `${typed === '' ? '' : ' '}[deny]` : ''
      if (screen === 'plain') {
        output.write(`${printable(typed)}${tag}\n`)
        return
      }
      if (!denied) return
      if (screen === 'dumb') {
        output.write(`${text}${printable(typed)}${tag}\n`)
        return
      }
      // The row drawn again whole, so no column is computed; what a paste echoed below it is cleared.
      moveCursor(output, 0, -(1 + extraLines))
      cursorTo(output, 0)
      clearScreenDown(output)
      output.write(`${text}${printable(typed)}${tag}\n`)
    },
    ended(tag: string | null): void {
      if (tag === null) return
      if (prompted === undefined || screen !== 'cursor') {
        output.write(`${text}${tag}\n`)
        return
      }
      moveCursor(output, 0, -(rowsTypedAtEnd + 1))
      cursorTo(output, promptColumns)
      clearScreenDown(output)
      output.write(`${tag}\n`)
    },
    release(): void {
      waiting?.()
      prompted?.()
    },
  }
}

function approvalQuestion(request: CliRequest): ApprovalQuestion {
  if (request.kind !== APPROVAL_REQUEST_KIND) throw new Error(`The terminal answers approval questions only, not ${request.kind}`)
  const details = QuestionDetailsSchema.parse(request.action.details)
  const call = details.arguments === undefined || details.cwd === undefined ? undefined : { arguments: details.arguments, cwd: details.cwd, description: details.description ?? null, ...(details.effects === undefined ? {} : { effects: details.effects }) }
  return {
    tool: details.tool, rule: details.rule, subject: details.subject, ...(details.wider === undefined ? {} : { widerSubject: details.wider }), reason: details.reason, offeredScopes: details.scopes, expiresAt: details.expiresAt,
    ...(details.workspace ? { workspaceId: details.workspace } : {}), ...(details.workspaceName ? { workspaceName: details.workspaceName } : {}), ...(details.node ? { node: details.node } : {}), ...(call ? { call } : {}),
    ...(details.severity === undefined ? {} : { severity: details.severity }),
    ...(details.judge === undefined ? {} : { judge: details.judge }),
  }
}

/**
 * The choices in the owner's words, numbered over the scopes the rule offers alone, so no `(3)` shows where it offers
 * no `always`, as at the destructive floor (BUCKLE-D05), then over the wider subject's (the delete policy brief): this
 * session or always for the delete's folder and its subfolders; `ds` and `da` for a sensitive file; an ask recorded
 * before this build offers its denials alone.
 */
function choicesLine(question: ApprovalQuestion): string {
  const offered = question.call ? [...question.offeredScopes, ...widerChoices(question)] : []
  const scopes = offered.map((choice, index) => `(${index + 1}) ${choiceLabel(choice)}`)
  const denials = question.rule === 'sensitive_path' ? ['(n) deny', '(ds) deny this session', '(da) always deny'] : ['(n) deny']
  return [...scopes, ...denials].join('  ')
}

/** The wider subject's choices: the session and always scopes the ask offers, for its folder and subfolders. */
function widerChoices(question: ApprovalQuestion): ApprovalChoice[] {
  if (question.widerSubject === undefined) return []
  return question.offeredScopes.flatMap((scope): ApprovalChoice[] => (scope === 'session' ? ['session_below'] : scope === 'always' ? ['always_below'] : []))
}

/**
 * Enter and anything not on offer deny once; exactly the one digit shown beside an offered choice picks it, where the
 * whole action was shown. `1x`, `3.`, or `01` is no key on offer, so it denies (fix brief 1, H2).
 */
function choiceFor(question: ApprovalQuestion, answer: string): ApprovalChoice {
  if (question.rule === 'sensitive_path' && answer === 'ds') return 'deny_session'
  if (question.rule === 'sensitive_path' && answer === 'da') return 'deny_always'
  if (!question.call || !/^[1-9]$/.test(answer)) return 'deny'
  return [...question.offeredScopes, ...widerChoices(question)][Number(answer) - 1] ?? 'deny'
}

function choiceLabel(choice: GrantScope | ApprovalChoice): string {
  if (choice === 'once') return 'approve once'
  if (choice === 'session') return 'approve this session'
  if (choice === 'session_below') return 'approve this session, folder and below'
  if (choice === 'always_below') return 'always approve, folder and below'
  return 'always approve'
}

/**
 * Asks the person at this process's terminal to confirm one decision, after the whole action was shown
 * (owner decision D17); null where the process has no terminal, so nothing can be confirmed.
 */
export type Confirm = (prompt: string) => Promise<boolean>

/**
 * The confirmation `buckle approve` and `buckle client approve` ask for, where both the input and the output the
 * action is printed to are a terminal, with the prompt on that same output: with the action redirected away, a
 * person would confirm what they never saw (review L7 of the slice 5 re-review). Null otherwise: nothing is approved.
 */
export function terminalConfirm(streams: { input: NodeJS.ReadStream; output: NodeJS.WriteStream }): Confirm | null {
  if (!streams.input.isTTY || !streams.output.isTTY) return null
  return prompt => confirmAtTerminal(prompt, { input: streams.input, output: streams.output })
}

/**
 * One yes-or-no at this process's terminal, for `buckle approve` after it showed the whole action (owner
 * decision D17): the word yes confirms; anything else, Enter or Ctrl-C declines. As a question does, it
 * takes keys only once the keyboard has been still with it on screen, and throws away a line typed before.
 */
export async function confirmAtTerminal(prompt: string, options: Pick<TerminalOptions, 'input' | 'output'> = {}): Promise<boolean> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stderr
  const readline = createInterface({ input, output, historySize: 0 })
  const keys = watchKeys(input)
  const closed = new AbortController()
  readline.on('SIGINT', () => closed.abort())
  readline.on('close', () => closed.abort())
  try {
    output.write(prompt)
    await keys.quiet(QUIET_MS, closed.signal)
    closed.signal.throwIfAborted()
    discardTypedLine(readline)
    return (await readline.question('  > ', { signal: closed.signal })).trim().toLowerCase() === 'yes'
  } catch {
    return false
  } finally {
    keys.stop()
    readline.close()
  }
}

const RecoveryDetailsSchema = z.object({
  checkpoint: z.string().regex(/^change-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
  workspace: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  workspaceName: z.string(),
  command: z.string().min(1),
})

type RecoveryEnding = { result: CliConsumerResult } | { error: unknown }

async function recoveryPrompt(input: { request: CliRequest; input: Readable; writer: ConsoleWriter; signal: AbortSignal; interrupt: () => void }): Promise<CliConsumerResult> {
  input.signal.throwIfAborted()
  const details = RecoveryDetailsSchema.parse(input.request.action.details)
  const keyboard = openRecoveryKeyboard(input)
  try {
    await input.writer.block(marked({ workspaceId: details.workspace, workspaceName: details.workspaceName }, [
      `History checkpoint ${details.checkpoint} needs recovery.`,
      printable(details.command),
      'Press r to recover, any other key to leave it pending.',
    ]), new Date())
    return await keyboard.answer()
  } finally { keyboard.close() }
}

function openRecoveryKeyboard(input: { input: Readable; signal: AbortSignal; interrupt: () => void }) {
  const keyboard = input.input as Readable & { isRaw?: boolean; setRawMode?: (raw: boolean) => void }
  const wasRaw = keyboard.isRaw === true
  const wasFlowing = input.input.readableFlowing === true
  const keys = watchKeys(input.input)
  const stopped = new AbortController()
  const ending = Promise.withResolvers<RecoveryEnding>()
  let accepting = false
  let finished = false
  let closed = false

  function close(): void {
    if (closed) return
    closed = true
    stopped.abort()
    input.input.off('data', heard)
    input.input.off('end', ended)
    input.input.off('close', ended)
    input.input.off('error', failed)
    input.signal.removeEventListener('abort', cancelled)
    try { keyboard.setRawMode?.(wasRaw) }
    finally {
      keys.stop()
      if (!wasFlowing && input.input.listenerCount('data') === 0) input.input.pause()
    }
  }

  function finish(result: RecoveryEnding): void {
    if (finished) return
    finished = true
    try { close(); ending.resolve(result) }
    catch (error) { ending.resolve({ error }) }
  }

  function cancelled(): void { finish({ error: input.signal.reason }) }
  function ended(): void { finish({ result: { status: 'denied', reason: 'Terminal input closed' } }) }
  function failed(error: Error): void { finish({ error }) }
  function heard(chunk: Buffer | string): void {
    const key = String(chunk).toLowerCase()
    if (key.includes('\u0003')) {
      finish({ error: new Error('Interrupted') })
      input.interrupt()
    } else if (key.includes('\u0004')) ended()
    else if (accepting) finish({ result: { status: 'answered', answer: { choice: key === 'r' ? 'recover' : 'deny' } } })
  }

  input.input.on('data', heard)
  input.input.once('end', ended)
  input.input.once('close', ended)
  input.input.once('error', failed)
  input.signal.addEventListener('abort', cancelled, { once: true })
  try {
    if (input.signal.aborted) cancelled()
    else if (input.input.readableEnded || input.input.destroyed) ended()
    else { keyboard.setRawMode?.(true); input.input.resume() }
  } catch (error) { finish({ error }) }

  return {
    async answer(): Promise<CliConsumerResult> {
      await keys.quiet(QUIET_MS, stopped.signal)
      accepting = !finished
      const result = await ending.promise
      if ('error' in result) throw result.error
      return result.result
    },
    close,
  }
}
