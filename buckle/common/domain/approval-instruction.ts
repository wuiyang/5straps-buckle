import type { ApprovalRequest, GrantScope, JsonValue, PermissionRuleId } from '@5straps/protocol'
import { describeExpiry } from './approval-deadline.js'

/**
 * Controls (C0, DEL, C1), format characters (bidirectional marks and overrides, zero-width
 * characters, the soft hyphen, tag characters) and the Unicode line and paragraph separators:
 * characters a terminal acts on or hides instead of showing, so an agent-chosen subject could move
 * the cursor, reorder the line a person reads before approving, or pass for a different name.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/**
 * What an agent chose (tool name, subject, reason) as a person sees it: every character above shown
 * as its escape, `\u001b` in the Basic Multilingual Plane and `\u{e0041}` above it. Every rendering
 * of agent-controlled text for a person goes through this.
 */
export function printable(text: string): string {
  return text.replace(UNPRINTABLE, character => {
    const code = character.codePointAt(0)!
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`
  })
}

/** What a relay suggests: a session grant where one is offered, so a retry is not gated again. */
export function preferredScope(offered: GrantScope[]): GrantScope {
  return offered.includes('session') ? 'session' : offered[0] ?? 'once'
}

/** A handle that needs no quoting on a command line: letters, digits, and the punctuation a folder's name usually has. */
const PLAIN_ARGUMENT = /^[A-Za-z0-9._@+:,=/-]+$/

/**
 * A workspace's name as a printed command's argument (D85, Q15): bare where every character is plain, single-quoted
 * otherwise, with a quote inside it closed, escaped, and reopened, as a POSIX shell reads one word. Every character a
 * terminal would act on is shown as its escape first, as every rendering of agent-reachable text is.
 */
export function workspaceArgument(name: string): string {
  const shown = printable(name)
  return PLAIN_ARGUMENT.test(shown) ? shown : `'${shown.replaceAll('\'', '\'\\\'\'')}'`
}

/** Where a command names the workspace an ask waits in: its name, which `--workspace` takes (D85, Q15). */
interface NamedWorkspace { workspaceId?: string; workspaceName?: string }

/** The `--workspace` flag a printed command carries: the name where it is known, else the id, and nothing where neither is. */
function workspaceFlag(input: NamedWorkspace): string {
  const handle = input.workspaceName ?? input.workspaceId
  return handle === undefined ? '' : ` --workspace ${workspaceArgument(handle)}`
}

/**
 * The exact command that answers one request. A token is issued and resolved inside one workspace's own state, so
 * `buckle approve <token>` names the workspace it waits in, by its name (D85, Q15): the approver's commands default to
 * the workspace holding their directory, which is not always this one.
 */
export function approveCommand(input: NamedWorkspace & { request: ApprovalRequest }): string {
  return `buckle approve ${input.request.token} --scope ${preferredScope(input.request.offeredScopes)}${workspaceFlag(input)}`
}

/** The command that denies one request: the only decision an ask recorded before this build takes (owner decision D17). */
export function denyCommand(input: NamedWorkspace & { request: ApprovalRequest }): string {
  return `buckle approve ${input.request.token} --deny${workspaceFlag(input)}`
}

/**
 * The command that shows every waiting ask's whole action (owner decision D17): what a relayed instruction
 * sends a person to first, before any command that decides.
 */
export function reviewCommand(input: NamedWorkspace): string {
  return `buckle approvals${workspaceFlag(input)}`
}

/**
 * The command that has the decision AI rate one waiting ask at the owner's request (D91, addendum C), in the workspace it
 * waits in; with --approve-if-safe it approves the ask once where the verdict is safe at 0.8 or above.
 */
export function judgeCommand(input: NamedWorkspace & { request: { token: string } }): string {
  return `buckle approvals judge ${input.request.token}${workspaceFlag(input)}`
}

/**
 * What the decision AI said of an ask's command (D91), kept with the call the ask came from: the thorough stage's verdict
 * or why it gave none, with the quick stage's beside it; the quick stage's alone; or, in a workspace whose judge rates on
 * request, that it was not asked yet. The reasoning is the model's, with the
 * credentials the display hides hidden. A floor ask's note carries FLOOR_WARNING (`warning`), a constant, never a
 * reasoning (addendum 3 R2).
 */
export type JudgeNote = (
  | { subject: string; level: 'safe' | 'warning' | 'danger'; confidence: number; model: string; reasoning: string; latencyMs?: number; quick?: QuickNote }
  | { subject: string; unavailable: string; quick?: QuickNote }
  | { subject: string; onRequest: true }
  | { subject: string; quick: QuickNote }
) & { warning?: typeof FLOOR_WARNING }

/**
 * The one line a floor ask's note carries (addendum 3 R2): the built-in floor (sudo and the destructive commands) or the
 * workspace's destructive list asked, and no stage of the decision AI ever passes such a call, whatever it rates it.
 */
export const FLOOR_WARNING = 'a command at the destructive floor always needs a person'

/** What the quick stage said beside the thorough stage's verdict, or alone (D91, addendum 2 B): Jev writes no reasoning. */
export type QuickNote = { level: 'safe' | 'warning' | 'danger'; confidence: number; model: string; latencyMs: number } | { unavailable: string }

/** The note about one ask, which only an interpreter ask at the destructive floor carries. */
export function judgeNoteFor(notes: readonly JudgeNote[] | undefined, ask: { rule: string; subject: string }): JudgeNote | undefined {
  return ask.rule === 'destructive_command' ? notes?.find(note => note.subject === ask.subject) : undefined
}

/**
 * A note as one line beside the whole action (D91, brief item 4): `danger (0.92, gpt-6-luna, 900 ms): <reasoning>`, why
 * there is no verdict, or the command that asks for one; with the quick stage's verdict first where it rated, as
 * `quick: warning (0.90, jev-1.13.0, 120 ms); thorough: danger (0.92, gpt-6-luna, 900 ms): <reasoning>`. Every route passes it through printable() as it does the rest.
 */
export function judgeLine(note: JudgeNote, input: NamedWorkspace & { token?: string | undefined; approves?: boolean }): string {
  const rated = ratingLine(note, input)
  // A floor ask's note leads with its one constant warning line (addendum 3 R2).
  return note.warning === undefined ? rated : rated === '' ? note.warning : `${note.warning}; ${rated}`
}

/** A note's ratings as one line: judgeLine without the floor warning. */
function ratingLine(note: JudgeNote, input: NamedWorkspace & { token?: string | undefined; approves?: boolean }): string {
  if ('onRequest' in note) return note.warning === undefined ? onRequestLine(input) : floorRequestLine(input)
  const quick = 'quick' in note && note.quick ? `quick: ${'level' in note.quick ? `${note.quick.level} (${note.quick.confidence.toFixed(2)}, ${note.quick.model}, ${note.quick.latencyMs} ms)` : `no verdict: ${note.quick.unavailable}`}` : null
  const thorough = 'level' in note ? `${note.level} (${note.confidence.toFixed(2)}, ${note.model}${note.latencyMs === undefined ? '' : `, ${note.latencyMs} ms`}): ${note.reasoning}` : 'unavailable' in note ? `no verdict: ${note.unavailable}` : null
  if (quick === null) return thorough ?? ''
  return thorough === null ? quick : `${quick}; thorough: ${thorough}`
}

/** That a floor ask was not rated yet, and the command that rates it on request, which never approves one (addendum 3 R2). */
function floorRequestLine(input: NamedWorkspace & { token?: string | undefined }): string {
  return input.token === undefined ? 'not asked; the decision AI rates it on request' : `not asked; ${judgeCommand({ ...input, request: { token: input.token } })} rates it`
}

/**
 * That a waiting ask's command was not rated yet, and the command that rates it on request; that its --approve-if-safe
 * approves a safe verdict once only where the thorough stage can rate (`approves`, read when the line is shown), since
 * the quick stage's verdict approves nothing (fix brief 9, B37).
 */
function onRequestLine(input: NamedWorkspace & { token?: string | undefined; approves?: boolean }): string {
  if (input.token === undefined) return 'not asked; the decision AI rates it on request'
  const command = judgeCommand({ ...input, request: { token: input.token } })
  return input.approves === false ? `not asked; ${command} asks it` : `not asked; ${command} asks it, and with --approve-if-safe approves a safe verdict once`
}

/**
 * What a person is told about a request that is waiting: what it wants, where it is waiting, how
 * long it stays answerable, the command that shows its whole action, and only then the command that
 * answers it (owner decision D17: a relayed line never stands in for the action). One home, because the
 * same lines go to an MCP client's user and a terminal, and an instruction that named neither the node
 * nor the workspace was not actionable on a node serving several. The approval webhook names the same
 * workspace in fields of its own (webhook-notifier.ts).
 */
export function describeApprovalRequest(input: NamedWorkspace & { request: ApprovalRequest; nodeName?: string }): string[] {
  const { request } = input
  const workspace = input.workspaceId ? `workspace ${workspaceLabel(input.workspaceId, input.workspaceName)}` : null
  return [
    printable(request.reason),
    `subject: ${printable(request.subject)}`,
    `${describeExpiry(request.expiresAt)}`,
    ...(input.nodeName || workspace ? [`waiting on ${[input.nodeName ? `node ${printable(input.nodeName)}` : null, workspace].filter(Boolean).join(', ')}`] : []),
    `see the whole action with: ${reviewCommand(input)}`,
    `then approve with: ${approveCommand(input)} (it shows the action again and asks to confirm)`,
  ]
}

/**
 * What every route says of an ask recorded before this build, or whose kept call file is missing or damaged: its
 * whole call cannot be shown, so nobody approves it; it can be denied, or the call re-sent under the same requestId,
 * which records it again (owner decision D17; review L4 of the continuation review).
 */
export const RECORDED_BEFORE_NOTE = 'recorded before this build, or its kept call is missing or damaged: its whole call cannot be shown, so it cannot be approved; deny it, or have the agent re-send the call to ask again'

/**
 * A workspace as every approver names it (D85, Q15): its name, which the owner chose, knows it by, and types after
 * `--workspace`; its id, a UUID nobody types, only where no name is known.
 */
export function workspaceLabel(id: string, name?: string): string {
  return printable(name ?? id)
}

/** Arguments past this size get a line naming their size before anything else, so a person knows how much follows. */
export const LARGE_ACTION_BYTES = 64 * 1_024

/** An action as a person decides on it: the whole call and where it runs (owner decision D17). */
export interface ShownAction {
  node?: string
  /** As workspaceLabel prints it. */
  workspace?: string
  rule: string
  subject: string
  reason: string
  description: string | null
  cwd: string | null
  effects: readonly string[] | null
  arguments: JsonValue | null
  /** What the decision AI said of the command, as judgeLine puts it (D91). */
  judge?: string
}

/** A call as an approver shows it: the one the ask recorded whole (owner decision D17). */
export interface ShownCall {
  arguments: JsonValue
  cwd: string
  description: string | null
  effects?: readonly string[]
  /** What the decision AI said of the call's interpreter asks (D91). */
  judge?: readonly JudgeNote[]
}

/** One waiting ask as an approver shows it: the request, and the whole call it recorded when there is one. */
export interface ShownAsk {
  tool: string
  rule: PermissionRuleId
  subject: string
  /** What a person may grant for the session or always in place of `subject`: a delete's folder and its subfolders. */
  widerSubject?: string
  reason: string
  expiresAt: string
  /** The workspace the ask waits in, which every approver names with its name (the workspace-model brief, item 6). */
  workspaceId?: string
  workspaceName?: string
  node?: string
  /** Absent for an ask recorded before this build: it is shown with RECORDED_BEFORE_NOTE and never approved. */
  call?: ShownCall
  /** Its token, which the command asking the decision AI names. */
  token?: string
  /** The decision AI's line, where a route has it already put (the serve terminal's question); else read from the call. */
  judge?: string
  /**
   * Whether the thorough stage can approve here, read by the line a route builds from the call: false drops the promise
   * that --approve-if-safe approves, which Jev's verdict never does (D91 follow-up F6). Absent keeps the promise.
   */
  approves?: boolean
}

/**
 * What every route that decides shows before a decision, so the serve terminal, `buckle approvals --watch`,
 * `buckle approve` and MCP elicitation read alike (owner decision D17): the ask, then its whole action. `expiry` words
 * the request expiry: ISO UTC by default, the serve terminal's local time where it passes describeLocalExpiry (C4).
 */
export function describeAsk(ask: ShownAsk, expiry: (expiresAt: string) => string = describeExpiry): string[] {
  const head = askHead(ask, expiry)
  const { call } = ask
  if (!call) return [...head, `  ${RECORDED_BEFORE_NOTE}`]
  const workspace = ask.workspaceId === undefined && ask.workspaceName === undefined ? undefined : workspaceLabel(ask.workspaceId ?? '', ask.workspaceName)
  const note = judgeNoteFor(call.judge, ask)
  const judge = ask.judge ?? (note === undefined ? undefined : judgeLine(note, ask))
  return [...head, ...describeAction({
    ...(ask.node === undefined ? {} : { node: ask.node }), ...(workspace === undefined ? {} : { workspace }), rule: ask.rule, subject: ask.subject, reason: ask.reason,
    description: call.description, cwd: call.cwd, effects: call.effects ?? null, arguments: call.arguments, ...(judge === undefined ? {} : { judge }),
  })]
}

/**
 * An ask whose request group's whole call another ask of the group already showed, above it: the ask, then where
 * its action is, so a call is shown once however many asks it made (review M1 of the slice 5 re-review).
 */
export function describeAskOfShownCall(ask: ShownAsk, shownWith: string): string[] {
  return [...askHead(ask), `  ${sameCallNote(shownWith)}`]
}

/** Said of an ask whose call was shown whole above, with the ask named first. */
export function sameCallNote(shownWith: string): string {
  return `its call is the one shown whole above with ${printable(shownWith)}; that is the whole action`
}

/** The asks one call made, listed where its whole action is shown once (review M1 of the slice 5 re-review). */
export function describeCallAsks(requests: ReadonlyArray<{ token: string; rule: string; subject: string }>): string[] {
  return [`  asks:     this call makes ${requests.length}, each decided on its own`, ...requests.map(request => `            ${printable(request.token)}  ${printable(request.rule)}: ${printable(request.subject)}`)]
}

function askHead(ask: ShownAsk, expiry: (expiresAt: string) => string = describeExpiry): string[] {
  return [
    `${printable(ask.tool)} needs approval${ask.workspaceId === undefined ? '' : ` in workspace ${workspaceLabel(ask.workspaceId, ask.workspaceName)}`}`,
    `  ${printable(ask.reason)}`,
    `  subject: ${printable(ask.subject)}`,
    ...(ask.widerSubject === undefined ? [] : [`  or:      ${printable(ask.widerSubject)} (every delete in that folder and its subfolders, for the session or always)`]),
    `  ${expiry(ask.expiresAt)}`,
  ]
}

/**
 * The lines every approver shows for one action (owner decision D17): a size line first when the arguments
 * pass LARGE_ACTION_BYTES, then the node and workspace, the node's summary, the rule, subject and reason, the
 * directory, every judged effect and the whole arguments as indented JSON. Nothing is cut or paged; every
 * line passes through printable(), since the agent chose most of it.
 */
export function describeAction(action: ShownAction): string[] {
  const shown = action.arguments === null ? null : JSON.stringify(action.arguments, null, 2)
  const bytes = shown === null ? 0 : Buffer.byteLength(shown)
  return [
    ...(bytes > LARGE_ACTION_BYTES ? [`  size:     ${bytes} bytes of arguments, every one shown below`] : []),
    ...(action.node === undefined ? [] : [`  node:     ${printable(action.node)}`]),
    ...(action.workspace === undefined ? [] : [`  workspace: ${action.workspace}`]),
    `  does:     ${action.description === null ? 'not described' : printable(action.description)}`,
    `  rule:     ${printable(action.rule)}`,
    `  subject:  ${printable(action.subject)}`,
    `  reason:   ${printable(action.reason)}`,
    ...(action.judge === undefined ? [] : [`  judge:    ${printable(action.judge)}`]),
    `  in:       ${action.cwd === null ? 'not recorded' : printable(action.cwd)}`,
    ...(action.effects === null ? ['  effects:  not recorded'] : action.effects.length === 0 ? ['  effects:  none'] : action.effects.map((effect, index) => `${index === 0 ? '  effects:  ' : '            '}${printable(effect)}`)),
    ...(shown === null ? ['  arguments: not recorded'] : ['  arguments:', ...shown.split('\n').map(line => `    ${printable(line)}`)]),
  ]
}
