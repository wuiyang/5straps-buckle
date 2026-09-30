import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import type { CliConsumer, CliRequest } from '@5straps/runtime'
import { JsonValueSchema, PermissionRuleIdSchema, GrantScopeSchema, type GrantScope, type JsonValue, type PermissionRuleId } from '@5straps/protocol'
import { z } from 'zod'
import { describeExpiry, remainingMs } from '../common/domain/approval-deadline.js'
import { describeAction, printable } from '../common/domain/approval-instruction.js'
import type { ApprovalChoice } from '../common/services/approvals/approval-service.js'
import { APPROVAL_REQUEST_KIND } from '../common/services/approvals/interaction.js'
import { QUIET_MS, discardTypedLine, watchKeys } from './terminal-keys.js'

export interface TerminalOptions {
  /** Where the question is asked. This process's terminal unless a caller names another. */
  input?: Readable
  output?: Writable
  /**
   * What Ctrl-C does once every question is dropped. By default SIGINT is raised again, so the
   * process stops exactly as it would have with no question open.
   */
  onInterrupt?: () => void
}

/** What a question shows; an approval request carries every field, so `buckle approvals --watch` shares it. */
export interface ApprovalQuestion {
  tool: string
  rule: PermissionRuleId
  subject: string
  reason: string
  offeredScopes: GrantScope[]
  expiresAt: string
  /** Named only when the question comes from a registered workspace. */
  workspaceId?: string
  /** The node that asks, when the question names it. */
  node?: string
  /** The whole call the ask came from (owner decision D17); absent for an ask recorded without it. */
  call?: { arguments: JsonValue; cwd: string; description: string | null; effects?: readonly string[] }
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
  tool: z.string(), rule: PermissionRuleIdSchema, subject: z.string(), reason: z.string(),
  scopes: z.string().transform(value => value.split(',')).pipe(z.array(GrantScopeSchema).min(1)),
  expiresAt: z.string(), workspace: z.string().optional(), node: z.string().optional(),
  arguments: jsonText(JsonValueSchema).optional(), cwd: z.string().optional(), description: z.string().optional(), effects: jsonText(z.array(z.string())).optional(),
})

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
 * at; the requester times it out from the request's own wait.
 *
 * Ctrl-C at a question stops the process, not just that question: every gated call queues its own,
 * so dropping one at a time would take a key press per question to stop `buckle serve`. The first
 * Ctrl-C closes the terminal and calls `onInterrupt`, whose caller detaches this consumer, which
 * drops every queued question, and raises SIGINT again for the process to shut down as usual.
 */
export function createTerminalConsumer(options: TerminalOptions = {}): CliConsumer {
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
    async prompt(request, { signal }) {
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
      try {
        output.write(describeQuestion(question))
        await keys.quiet(QUIET_MS, cancelled)
        cancelled.throwIfAborted()
        discardTypedLine(readline)
        const answer = (await readline.question(`  ${scopeChoices(question)}  ${denyChoices(question)} > `, { signal: cancelled })).trim().toLowerCase()
        return { status: 'answered', answer: { choice: choiceFor(question, answer) } }
      } finally {
        keys.stop()
        readline.close()
      }
    },
  }
}

/**
 * What a terminal question shows, shared with `buckle approvals --watch` so both read alike: the ask,
 * then the whole action it came from (owner decision D17), nothing cut or paged. The agent chose the
 * tool call, so its text is shown with control characters escaped.
 */
export function describeQuestion(question: ApprovalQuestion): string {
  const workspace = question.workspaceId && question.workspaceId !== 'default' ? `  workspace: ${printable(question.workspaceId)}\n` : ''
  const head = `\n${printable(question.tool)} needs approval\n  ${printable(question.reason)}\n  subject: ${printable(question.subject)}\n${workspace}  ${describeExpiry(question.expiresAt)}\n`
  const { call } = question
  if (!call) return head
  const action = describeAction({
    ...(question.node === undefined ? {} : { node: question.node }), workspace: question.workspaceId ?? 'default', rule: question.rule, subject: question.subject, reason: question.reason,
    description: call.description, cwd: call.cwd, effects: call.effects ?? null, arguments: call.arguments,
  })
  return `${head}${action.join('\n')}\n`
}

function approvalQuestion(request: CliRequest): ApprovalQuestion {
  if (request.kind !== APPROVAL_REQUEST_KIND) throw new Error(`The terminal answers approval questions only, not ${request.kind}`)
  const details = QuestionDetailsSchema.parse(request.action.details)
  const call = details.arguments === undefined || details.cwd === undefined ? undefined : { arguments: details.arguments, cwd: details.cwd, description: details.description ?? null, ...(details.effects === undefined ? {} : { effects: details.effects }) }
  return {
    tool: details.tool, rule: details.rule, subject: details.subject, reason: details.reason, offeredScopes: details.scopes, expiresAt: details.expiresAt,
    ...(details.workspace ? { workspaceId: details.workspace } : {}), ...(details.node ? { node: details.node } : {}), ...(call ? { call } : {}),
  }
}

function scopeChoices(question: ApprovalQuestion): string {
  return question.offeredScopes.map((scope, index) => `${index + 1}) ${scopeLabel(scope)}`).join('  ')
}

function denyChoices(question: ApprovalQuestion): string {
  return question.rule === 'sensitive_path' ? 'n) deny  ds) deny this session  da) always deny' : 'n) deny'
}

/** Enter and anything unrecognised deny once; a number picks an offered scope. */
function choiceFor(question: ApprovalQuestion, answer: string): ApprovalChoice {
  if (question.rule === 'sensitive_path' && answer === 'ds') return 'deny_session'
  if (question.rule === 'sensitive_path' && answer === 'da') return 'deny_always'
  return question.offeredScopes[Number.parseInt(answer, 10) - 1] ?? 'deny'
}

function scopeLabel(scope: GrantScope): string {
  if (scope === 'once') return 'allow once'
  if (scope === 'session') return 'allow this session'
  return 'always allow'
}
