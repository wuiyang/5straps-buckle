import { parseArgs } from 'node:util'
import { GrantScopeSchema, type GrantScope } from '@5straps/protocol'
import { describeExpiry } from '../common/domain/approval-deadline.js'
import { FLOOR_WARNING } from '../common/types/ports/approval-backend.js'
import { approveCommand, denyCommand, describeAction, describeAsk, judgeLine, judgeNoteFor, printable, sameCallNote, workspaceArgument, workspaceLabel } from '../common/domain/approval-instruction.js'
import { RECORDED_BEFORE_NOTE } from '../common/domain/approval/recorded-before-note.js'
import { auditOf, judgeNoteOf } from '../common/services/judge/judge-gate.js'
import { floorCause } from '../common/domain/permission/judged.js'
import { shownCall } from '../common/domain/approval/asked-call.js'
import type { PendingAsk } from '../common/domain/approval/ledger-state.js'
import { saveEndingLine, settleUnsaved, unsavedOf, type SaveEnding, type Unsaved } from '../common/adapters/approval/grant-save-question.js'
import type { CoreDecisionInput, CoreDecisionReceipt } from '../common/services/approvals/core-approval-api.js'
import type { DecisionBody } from '../common/types/ports/approval-backend.js'
import { floorSubjectPath } from '../common/domain/permission/subjects.js'
import { SCRIPT_CALL_NOTE } from '../common/domain/describe-call.js'
import type { WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { NodeConfig } from '../common/runtime/config.js'
import { logger } from '../common/runtime/log.js'
import { watchApprovals } from './approvals-watch.js'
import { APPROVE_USAGE, APPROVALS_USAGE } from './usage.js'
import { SAVE_FAILED_EXIT } from './exit-codes.js'
import { fail, print } from './output.js'
import type { CliResult } from './result.js'
import type { OwnerPrompts, ApproverCommandInput } from './command.js'
import type { ChooseSave } from './terminal-consumer.js'
export { APPROVE_USAGE, APPROVALS_USAGE } from './usage.js'

/**
 * `buckle approvals --all` and `buckle approve --all`: over every online workspace (Q9, Phase 1b item 4). A token is
 * answered in the workspace whose queue holds it, and audited in its log; a node with one online workspace reads as a
 * single one; the list and the watch over several are audited in the node's log.
 */
export async function runApproverCommand(input: ApproverCommandInput): Promise<CliResult> {
  const runtimes = await onlineRuntimes(input.workspaces)
  if (runtimes.length === 0) return input.nodeAudited(() => fail('No workspace is online, so none has asks waiting. Name one with --workspace <name>, or serve one again with buckle workspace enable <name>.'))
  // A watch follows the online workspaces as they change, however many there are at its start (finding 10).
  const watching = input.command === 'approvals' && input.argv.includes('--watch')
  if (runtimes.length === 1 && !watching) return input.runOnWorkspace(runtimes[0]!)
  // An option the command does not take is refused with its usage, in the node's log, before any workspace is chosen.
  const unusable = refusedArguments(input.command, input.argv)
  if (unusable) return input.nodeAudited(() => fail(unusable))
  const token = input.command === 'approve' ? approveArguments(input.argv).positionals[0] : approvalsArguments(input.argv).positionals[1]
  if (token !== undefined) {
    const holder = holderOfAsk(runtimes, token)
    if (typeof holder !== 'string') return input.runOnWorkspace(holder)
    // Refused before any workspace is chosen: recorded in the node's log, as the list across them is (finding 31).
    return input.nodeAudited(() => fail(holder))
  }
  if (input.command === 'approve') return input.nodeAudited(() => fail(APPROVE_USAGE))
  return input.nodeAudited(() => approvalsAcross({ runtimes, workspaces: input.workspaces, config: input.config, argv: input.argv }))
}

/**
 * Every online workspace's runtime; one that will not open is named with its reason, once for each `told`, and the
 * rest are answered.
 */
async function onlineRuntimes(workspaces: WorkspaceManager, told = new Set<string>()): Promise<BuckleRuntime[]> {
  const runtimes: BuckleRuntime[] = []
  for (const workspace of workspaces.list().filter(item => item.online)) {
    try { runtimes.push((await workspaces.resolve(workspace.id)).runtime) } catch (error) {
      if (!told.has(workspace.id)) process.stderr.write(`Workspace ${workspace.name} could not open, so its asks are left out: ${error instanceof Error ? error.message : String(error)}\n`)
      told.add(workspace.id)
    }
  }
  return runtimes
}

/** The workspace whose queue holds `token` waiting, or why none is chosen: none or several hold it. */
function holderOfAsk(runtimes: BuckleRuntime[], token: string): BuckleRuntime | string {
  const holding = runtimes.filter(runtime => runtime.approvalApi.waitingAsk(token) !== undefined)
  if (holding.length === 1) return holding[0]!
  const names = (list: BuckleRuntime[]) => list.map(runtime => runtime.workspaceName()).join(', ')
  if (holding.length > 1) return `${printable(token)} is waiting in workspaces ${names(holding)}; name one with --workspace <name>`
  return `Nothing named ${printable(token)} is waiting in any online workspace (${names(runtimes)}); to repeat a decision already recorded, name its workspace with --workspace <name>`
}

interface CommandInput {
  config: NodeConfig
  runtime: BuckleRuntime
  argv: string[]
}


function approvalsArguments(argv: string[]) {
  return parseArgs({ args: argv, options: { json: { type: 'boolean' }, watch: { type: 'boolean' }, 'approve-if-safe': { type: 'boolean' } }, allowPositionals: true })
}

/**
 * Why an approver command's words are refused before it runs: the option parseArgs does not know, then the command's
 * usage, so the person reads a refusal and not a stack; null where they parse.
 */
function refusedArguments(command: string, argv: string[]): string | null {
  try {
    if (command === 'approve') approveArguments(argv)
    else approvalsArguments(argv)
    return null
  } catch (error) {
    if (!(error instanceof TypeError) || !String((error as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS')) throw error
    return `${error.message.split('. ')[0]}\n${command === 'approve' ? APPROVE_USAGE : APPROVALS_USAGE}`
  }
}

/** Why the arguments name no listing, no watch and no single ask, or null. */
function approvalsRefusal({ values, positionals }: ReturnType<typeof approvalsArguments>): string | null {
  const [action, token, ...extra] = positionals
  if (action !== undefined && ((action !== 'show' && action !== 'judge') || token === undefined || extra.length > 0 || values.watch)) return APPROVALS_USAGE
  if (values['approve-if-safe'] && action !== 'judge') return '--approve-if-safe is for buckle approvals judge <token>'
  if (action === 'judge' && values.json) return APPROVALS_USAGE
  if (values.watch && values.json) return '--watch asks in the terminal, so it takes no --json'
  return null
}

export async function approvals(input: CommandInput): Promise<CliResult> {
  const unusable = refusedArguments('approvals', input.argv)
  if (unusable) return fail(unusable)
  const parsed = approvalsArguments(input.argv)
  const refusal = approvalsRefusal(parsed)
  if (refusal) return fail(refusal)
  const { values, positionals: [action, token] } = parsed
  const { runtime } = input
  if (action === 'judge' && token !== undefined) return judgeWaitingAsk({ runtime, token, approveIfSafe: values['approve-if-safe'] === true, node: input.config.serverId })
  if (token !== undefined) return showAsk({ runtime, token, json: values.json === true, node: input.config.serverId })
  if (values.watch) return watch({ runtimes: async () => [runtime], pinned: runtime.workspaceName() })
  if (values.json) return print(listingOf(runtime))
  const waiting = runtime.approvalApi.waiting()
  if (waiting.length === 0) process.stdout.write(`Nothing is waiting for a decision in workspace ${runtime.workspaceName()}.\n`)
  else printWaiting({ runtime, waiting, node: input.config.serverId })
  return { exitCode: 0 }
}

/** `buckle approvals` over several workspaces (Q9): each one's asks under its name, or one line where none waits. */
async function approvalsAcross(input: { runtimes: BuckleRuntime[]; workspaces: WorkspaceManager; config: NodeConfig; argv: string[] }): Promise<CliResult> {
  const parsed = approvalsArguments(input.argv)
  const refusal = approvalsRefusal(parsed)
  if (refusal) return fail(refusal)
  if (parsed.values.watch) {
    const told = new Set<string>()
    // Each poll reads the online workspaces again, and closes the runtime this process opened for one taken offline or
    // removed since, once it has no work, as `buckle serve` does at each look at the registry (closeUnserved).
    return watch({ runtimes: async () => {
      const online = await onlineRuntimes(input.workspaces, told)
      await input.workspaces.closeUnserved().catch((error: unknown) => { logger.error('Could not close a workspace this watch no longer follows', { error }) })
      return online
    } })
  }
  if (parsed.values.json) return print(input.runtimes.flatMap(listingOf))
  let any = false
  for (const runtime of input.runtimes) {
    const waiting = runtime.approvalApi.waiting()
    if (waiting.length === 0) continue
    any = true
    process.stdout.write(`Workspace ${workspaceLabel(runtime.workspaceId, runtime.workspaceName())}:\n`)
    printWaiting({ runtime, waiting, node: input.config.serverId })
  }
  if (!any) process.stdout.write(`Nothing is waiting for a decision in any online workspace (${input.runtimes.map(runtime => runtime.workspaceName()).join(', ')}).\n`)
  return { exitCode: 0 }
}

/**
 * One workspace's asks as `buckle approvals --json` lists them: the whole call each came from (owner decision D17),
 * redacted and never cut, once per request group: each ask names it by callRef and the group's first carries it
 * (review M1 of the slice 5 re-review). An ask recorded before this build has none, and is listed with the command
 * that denies it (review L6 of the slice 5 re-review).
 */
function listingOf(runtime: BuckleRuntime) {
  return runtime.approvalApi.listing().map((entry) => {
    const { callRef, call, ...request } = entry
    // An ask whose whole call is listed, inline or by its group's callRef, is approvable (review L5 of the continuation review).
    const shown = callRef !== undefined || call !== undefined
    const command = shown ? { approveCommand: approveCommand({ request, ...named(runtime) }) } : { denyCommand: denyCommand({ request, ...named(runtime) }) }
    return { ...request, workspaceId: runtime.workspaceId, workspaceName: runtime.workspaceName(), ...command, ...(callRef === undefined ? {} : { callRef }), ...(call === undefined ? {} : { call }) }
  })
}

/** One workspace's waiting asks as `buckle approvals` prints them, each group's whole action once, with its first ask. */
function printWaiting(input: { runtime: BuckleRuntime; waiting: PendingAsk[]; node: string }): void {
  const { runtime } = input
  const shownWith = new Map<string, string>()
  for (const { request, call, callRef } of input.waiting) {
    process.stdout.write(`${request.token}  ${printable(request.tool)}\n`)
    process.stdout.write(`    ${request.rule}: ${printable(request.subject)}\n`)
    process.stdout.write(`    ${printable(request.reason)}\n`)
    if (request.severity !== undefined) process.stdout.write(`    severity: ${request.severity}\n`)
    process.stdout.write(`    scopes: ${request.offeredScopes.join(' | ')}\n`)
    process.stdout.write(`    ${describeExpiry(request.expiresAt)}\n`)
    const shown = shownCall(call)
    // An ask recorded before this build is denied or re-sent, never approved (owner decision D17).
    process.stdout.write(`    ${shown ? approveCommand({ request, ...named(runtime) }) : denyCommand({ request, ...named(runtime) })}\n`)
    const earlier = callRef === undefined ? undefined : shownWith.get(callRef)
    const action = !shown
      ? [`  ${RECORDED_BEFORE_NOTE}`]
      : earlier !== undefined
        ? [`  ${sameCallNote(earlier)}`]
        : describeAction({ node: input.node, workspace: workspaceLabel(runtime.workspaceId, runtime.workspaceName()), rule: request.rule, subject: request.subject, reason: request.reason, ...shown, ...judgeOfAsk({ call, request, runtime }) })
    if (shown && callRef !== undefined && earlier === undefined) shownWith.set(callRef, request.token)
    process.stdout.write(`${action.map(line => `  ${line}`).join('\n')}\n`)
  }
}

/**
 * One ask whole, as `buckle approve` shows it, deciding nothing; for a call a code_run script made, the script's text
 * too, which the audit log keeps only the size of, from the record kept at the ask. The call shown whole is what is
 * approved (owner decision D17); the script is its context (review of the code-mode slice, coordinator decision 4).
 */
function showAsk(input: { runtime: BuckleRuntime; token: string; json: boolean; node: string }): CliResult {
  const { runtime, token } = input
  const ask = runtime.approvalApi.waitingAsk(token)
  if (!ask) return fail(`Nothing named ${printable(token)} is waiting for a decision in workspace ${runtime.workspaceName()}`)
  const script = runtime.scriptOfAsk(token)
  if (input.json) return print({ ...ask.request, workspaceId: runtime.workspaceId, ...(ask.call ? { call: ask.call } : {}), ...(script === null ? {} : { script }) })
  process.stdout.write(`${token}\n${describeWaitingAsk({ ask, node: input.node, runtime }).join('\n')}\n`)
  if (script !== null) process.stdout.write(`\nThe code_run script that made this call:\n${script.split('\n').map(printable).join('\n')}\n`)
  else if (ask.call?.description?.startsWith(SCRIPT_CALL_NOTE)) process.stdout.write('\nA code_run script made this call. Its text is kept for ten minutes once the script stops at this ask; while the call still waits inside the script, it is not kept yet.\n')
  return { exitCode: 0 }
}

/**
 * `buckle approvals judge <token> [--approve-if-safe]` (D91, addenda C and 2 B): every stage of the decision AI that
 * applies rates one waiting ask at the owner's request, its code read afresh, and the whole action is printed with both
 * verdicts beside it, as `buckle approvals show` prints it. With --approve-if-safe, the thorough stage's safe verdict at
 * 0.8 or above approves the ask once, the stage and its model named as who decided it; the quick stage's verdict is a
 * rating alone, and anything else approves nothing (addendum 3 R1), as does a floor ask, whose line says so (R2). Exit 1
 * where no stage gave a verdict.
 */
async function judgeWaitingAsk(input: { runtime: BuckleRuntime; token: string; approveIfSafe: boolean; node: string }): Promise<CliResult> {
  const { runtime, token } = input
  const rated = await runtime.judgeAsk(token)
  if (rated.kind === 'refused') return fail(printable(rated.reason))
  const { ask, judged } = rated
  const line = judgeLine(judgeNoteOf(judged), { token, ...named(runtime) })
  process.stdout.write(`${token}\n${describeAsk({ ...ask.request, workspaceId: runtime.workspaceId, workspaceName: runtime.workspaceName(), node: input.node, ...(ask.call?.complete ? { call: ask.call } : {}), judge: line }).join('\n')}\n`)
  const results = [judged.quick?.result, judged.thorough?.result].filter(result => result !== undefined)
  if (results.every(result => result.kind === 'unavailable')) {
    process.stdout.write(`The decision AI gave no verdict, so nothing is approved; ${token} is still waiting in workspace ${runtime.workspaceName()}.\n`)
    return { exitCode: 1, detail: `judge ${token} no verdict`, judge: auditOf(judged, false) }
  }
  const levels = results.flatMap(result => (result.kind === 'verdict' ? [result.level] : [])).join(', ')
  // A floor ask always needs a person: --approve-if-safe approves nothing for one, whatever both stages said (addendum 3 R2).
  // The ledger's floor mark counts too, so an ask recorded before the marks, which reads as the floor, is told so here.
  if (input.approveIfSafe && (floorCause(judged.cause) || ask.floor)) {
    process.stdout.write(`${FLOOR_WARNING[0]!.toUpperCase()}${FLOOR_WARNING.slice(1)}, so nothing is approved; ${token} is still waiting in workspace ${runtime.workspaceName()}.\n`)
    return { exitCode: 0, detail: `judge ${token} ${levels}`, judge: auditOf(judged, false) }
  }
  // Only the thorough stage approves: where it did not rate the ask, or gave no verdict, that is what the owner is told,
  // never "not safe" under a safe quick verdict (fix brief 9, B37).
  if (input.approveIfSafe && judged.thorough === undefined) {
    process.stdout.write(`Only the thorough stage can approve; it did not rate this ask, so nothing is approved; ${token} is still waiting in workspace ${runtime.workspaceName()}.\n`)
    return { exitCode: 0, detail: `judge ${token} ${levels}`, judge: auditOf(judged, false) }
  }
  if (input.approveIfSafe && judged.thorough?.result.kind === 'unavailable') {
    process.stdout.write(`The thorough stage gave no verdict, so nothing is approved; ${token} is still waiting in workspace ${runtime.workspaceName()}.\n`)
    return { exitCode: 0, detail: `judge ${token} ${levels}`, judge: auditOf(judged, false) }
  }
  const passing = judged.passedBy === 'thorough' ? judged.thorough : undefined
  if (!input.approveIfSafe || passing === undefined) {
    process.stdout.write(`${input.approveIfSafe ? 'Not safe at 0.8 or above, so nothing is approved' : 'Nothing is approved'}; ${token} is still waiting in workspace ${runtime.workspaceName()}.\n`)
    return { exitCode: 0, detail: `judge ${token} ${levels}`, judge: auditOf(judged, false) }
  }
  const rater = `${judged.passedBy}:${passing.provider}:${passing.result.kind === 'verdict' ? passing.result.model : passing.model}`
  // The once binds to the code the thorough stage rated: a retry after that code changed does not spend it (fix brief 9, B31).
  const receipt = await runtime.approvalApi.decide({ source: 'judge', decision: { token, outcome: 'approve', scope: 'once' }, rater, ...(judged.bound ? { code: judged.bound } : {}) })
  if (receipt.status === 'refused') return { ...fail(`${receipt.error.message} in workspace ${runtime.workspaceName()}`), judge: auditOf(judged, false) }
  process.stdout.write(`Approved ${token} once in workspace ${runtime.workspaceName()}, on the decision AI's ${judged.passedBy} stage's safe verdict, as you asked.\n`)
  return { exitCode: 0, detail: `judge ${token} safe, approved once`, judge: auditOf(judged, true) }
}

/**
 * Asks about each request as it arrives, in a terminal of its own beside `buckle serve`. A Ctrl-C
 * that reaches the process as a signal, where readline is not reading keys, stops it the same way.
 * Each answer is audited in the node's log, where `buckle approve` records its own.
 */
async function watch(input: { runtimes: () => Promise<BuckleRuntime[]>; pinned?: string }): Promise<CliResult> {
  // The action and the prompt go to stdout, so both ends must be a terminal, as terminalConfirm requires for buckle
  // approve: with stdout redirected a key would grant an action never seen (review L2 of the continuation review).
  if (!process.stdin.isTTY || !process.stdout.isTTY) return fail(`buckle approvals --watch needs a terminal to ask in, on both its input and its output. ${noTerminal(input.pinned)}`)
  const interrupted = new AbortController()
  const interrupt = () => interrupted.abort()
  process.once('SIGINT', interrupt)
  try {
    const sources = async () => (await input.runtimes()).map(runtime => ({ approvals: runtime.approvalApi, workspaceId: runtime.workspaceId, workspaceName: runtime.workspaceName(), judgeApproves: () => runtime.judgeApproves() }))
    return await watchApprovals({ sources, input: process.stdin, output: process.stdout, errors: process.stderr, signal: interrupted.signal })
  } finally {
    process.off('SIGINT', interrupt)
  }
}




function approveArguments(argv: string[]) {
  return parseArgs({ args: argv, options: { scope: { type: 'string' }, deny: { type: 'boolean' }, host: { type: 'string' }, below: { type: 'boolean' } }, allowPositionals: true })
}

export async function approve(input: CommandInput & OwnerPrompts): Promise<CliResult> {
  const unusable = refusedArguments('approve', input.argv)
  if (unusable) return fail(unusable)
  const { positionals, values } = approveArguments(input.argv)
  const token = positionals[0]
  if (!token) return fail(APPROVE_USAGE)

  const scope = GrantScopeSchema.safeParse(values.scope ?? 'once')
  if (!scope.success) return fail(`Invalid scope: ${values.scope}`)

  const { runtime } = input
  // The named ask alone, and its call file alone, however many asks its call made (review M1 of the slice 5 re-review).
  const ask = runtime.approvalApi.waitingAsk(token)
  // --below grants the ask's wider subject (the delete policy brief): a delete's folder and its subfolders, for the session or always.
  const below = values.below === true ? belowFolder({ ask, token, scope: scope.data, deny: values.deny === true, host: values.host !== undefined }) : null
  if (below !== null && 'refusal' in below) return fail(below.refusal)
  if (ask) process.stdout.write(`${token}\n${describeWaitingAsk({ ask, node: input.config.serverId, runtime }).join('\n')}\n`)
  // A token no longer waiting reaches the queue as it is: it can repeat the decision already recorded, and decide nothing new.
  if (values.deny !== true && ask) {
    if (!ask.call?.complete) return fail(`Not approved: ${printable(token)} was ${RECORDED_BEFORE_NOTE}. Deny it with ${denyCommand({ request: ask.request, ...named(runtime) })}`)
    if (!input.confirm) return fail(`Not approved: buckle approve records an approval only after a person at a terminal confirms the action above, and this process's input and output are not both a terminal. ${noTerminal(runtime.workspaceName())}`)
    const widened = values.host !== undefined ? ` for ${printable(values.host)}` : below !== null ? ` for every delete in ${printable(below.folder)} and its subfolders` : ''
    if (!await input.confirm(`Approve ${token} (${scope.data})${widened} in workspace ${runtime.workspaceName()}? Type yes to approve; anything else leaves it waiting.\n`)) {
      process.stdout.write(`Nothing decided; ${token} is still waiting in workspace ${runtime.workspaceName()}\n`)
      return { exitCode: 1 }
    }
  }
  const decision: DecisionBody = { token, outcome: values.deny === true ? 'deny' : 'approve', scope: scope.data, ...(below === null ? {} : { widen: 'below' }) }
  // `BUCKLE-D18`: `--host` widens a network approval to a pattern, from `buckle approve` alone.
  const sent: CliDecision = { source: 'cli', decision, ...(values.host === undefined ? {} : { hostPattern: values.host }) }
  const receipt = await runtime.approvalApi.decide(sent)
  const unsaved = unsavedOf({ decision, receipt })
  if (receipt.status === 'refused' && unsaved === undefined) return fail(`${receipt.error.message} in workspace ${runtime.workspaceName()}`)
  const recorded = receipt.status === 'refused' ? undefined : recordedLine({ receipt, decision, workspaceName: runtime.workspaceName() })
  if (recorded) process.stdout.write(`${recorded.line}\n`)
  if (unsaved === undefined) return { exitCode: 0, ...(recorded?.detail === undefined ? {} : { detail: recorded.detail }) }
  return approveUnsaved({ unsaved, sent, runtime, chooseSave: input.chooseSave, ...(recorded?.detail === undefined ? {} : { detail: recorded.detail }) })
}

/** The decision `buckle approve` sends, as it sends it again on a retry. */
type CliDecision = Extract<CoreDecisionInput, { source: 'cli' }>

/** What `buckle approve` prints of a recorded decision, and the line its audit entry keeps of a widened one. */
function recordedLine(input: { receipt: Exclude<CoreDecisionReceipt, { status: 'refused' }>; decision: DecisionBody; workspaceName: string }): { line: string; detail?: string } {
  /** For the command's audit entry: what a widened approval covers. */
  const { decision: { token, scope }, workspaceName } = input
  const applied = input.receipt.status === 'applied' ? input.receipt : undefined
  if (applied?.granted !== undefined) return { line: `Approved ${token} (${scope}) for ${printable(applied.granted)}, every delete in that folder and its subfolders, in workspace ${workspaceName}`, detail: `write_scope ${scope} approval widened to the folder and its subfolders` }
  if (applied?.widened) {
    const { pattern, askedBy } = applied.widened
    return { line: `Approved ${token} (${scope}) for ${pattern}, asked by ${printable(askedBy)}, in workspace ${workspaceName}`, detail: `network_egress ${scope} approval widened to ${pattern}, asked by ${askedBy}` }
  }
  return { line: `${input.decision.outcome === 'deny' ? 'Denied' : 'Approved'} ${token} in workspace ${workspaceName}` }
}

/** The exit a save question's ending gives `buckle approve`. */
const SAVE_ENDING_EXITS: Readonly<Record<SaveEnding['ending'], number>> = { saved: 0, skipped: 0, dropped: SAVE_FAILED_EXIT, denied_once: 0, left: SAVE_FAILED_EXIT, refused: 1 }

/**
 * A decision `buckle approve` sent whose grant did not save (the owner's ruling: a warning, and a retry or a skip): at a
 * terminal, the save question until it saves, is skipped, or is left; without one, the warning and the commands that
 * retry and skip it. Its audit entry keeps the warning, which names no path.
 */
async function approveUnsaved(input: { unsaved: Unsaved; sent: CliDecision; runtime: BuckleRuntime; chooseSave: ChooseSave | null; detail?: string }): Promise<CliResult> {
  const { unsaved, sent, runtime } = input
  const noted = (ending: string) => [input.detail, unsaved.warning, ending].filter(part => part !== undefined).join('; ')
  // Only a lasting denial that did not save left nothing recorded.
  const applied = unsaved.kind === 'denial' ? {} : { applied: true as const }
  if (input.chooseSave === null) {
    const untaken = untakenSave({ unsaved, decision: sent.decision, workspaceName: runtime.workspaceName() })
    process.stderr.write(`${unsaved.warning}.\n${untaken}\n`)
    return { exitCode: SAVE_FAILED_EXIT, detail: noted(untaken), ...applied }
  }
  const { token } = sent.decision
  const ending = await settleUnsaved({
    decision: sent.decision, unsaved,
    route: {
      ask: input.chooseSave,
      retry: () => runtime.approvalApi.decide(sent),
      skipSave: () => runtime.approvalApi.skipSave({ source: 'cli', token }),
      denyOnce: () => runtime.approvalApi.decide({ source: 'cli', decision: { token, outcome: 'deny', scope: 'once' } }),
    },
  })
  const line = saveEndingLine(ending)
  process.stdout.write(`${line}\n`)
  return { exitCode: SAVE_ENDING_EXITS[ending.ending], detail: noted(line), ...applied }
}

/** Where `buckle approve` had no terminal to ask at: a retry is the same command, and a lasting denial's skip a once denial. */
function untakenSave(input: { unsaved: Unsaved; decision: DecisionBody; workspaceName: string }): string {
  const { token, scope } = input.decision
  if (input.unsaved.kind === 'removal') return 'The next decision or the workspace opening again removes it; the same command sent again retries now.'
  if (input.unsaved.kind !== 'denial') return 'Retry with the same command; to skip, run it at a terminal and answer s.'
  const named = { request: { token }, workspaceName: input.workspaceName }
  return `Retry with: ${denyCommand({ ...named, scope })}. To deny this call once instead: ${denyCommand(named)}`
}

/**
 * The folder `--below` grants, named by the waiting ask's wider subject, or why there is none to grant. It widens an
 * approval, never a denial, and a host pattern is the other widening, which does not combine with it.
 */
function belowFolder(input: { ask: PendingAsk | undefined; token: string; scope: GrantScope; deny: boolean; host: boolean }): { folder: string } | { refusal: string } {
  if (input.deny) return { refusal: '--below widens an approval; deny without it' }
  if (input.scope === 'once') return { refusal: 'A once approval covers the one call that asked; grant the folder and its subfolders with --scope session or --scope always' }
  if (input.host) return { refusal: '--below and --host do not combine: --host widens a network approval, --below a delete outside the workspace\'s folder' }
  if (!input.ask) return { refusal: `Not approved: nothing named ${printable(input.token)} is waiting for a decision, so --below has no folder to grant` }
  const wider = input.ask.request.widerSubject
  if (wider === undefined) return { refusal: `Not approved: ${printable(input.token)} offers no folder and subfolders to grant; --below takes a delete outside the workspace's folder. Approve it without --below` }
  return { folder: floorSubjectPath(wider) ?? wider }
}

/** The decision AI's line for a waiting ask, where its call carries a note about its command (D91). */
function judgeOfAsk(input: { call: PendingAsk['call']; request: PendingAsk['request']; runtime: BuckleRuntime }): { judge?: string } {
  const note = judgeNoteFor(input.call?.judge, input.request)
  return note === undefined ? {} : { judge: judgeLine(note, { token: input.request.token, ...named(input.runtime), approves: input.runtime.judgeApproves() }) }
}

/** The workspace a printed command names: by its name (D85, Q15), beside the id the listing carries. */
function named(runtime: BuckleRuntime): { workspaceId: string; workspaceName: string } {
  return { workspaceId: runtime.workspaceId, workspaceName: runtime.workspaceName() }
}

/**
 * Where a decision goes when this process has no terminal (review L12 of the slice 5 re-review): approving takes a
 * person at a terminal, or a person's device where the node serves its admin face; denying works anywhere.
 */
function noTerminal(workspaceName?: string): string {
  const named = workspaceName === undefined ? '' : ` --workspace ${workspaceArgument(workspaceName)}`
  return `At a terminal, answer asks in buckle approvals --watch${named}, or approve one with buckle approve <token>${named}, which shows the action and asks to confirm. Without one, list them with buckle approvals${named} and deny one with buckle approve <token> --deny${named}. Where the node sets BUCKLE_EXPERIMENTAL_ADMIN_HTTP=true, a person's enrolled device approves with buckle client approve <node-url> <token>${named}.`
}

/** One waiting ask, followed by its whole action before a decision. */
function describeWaitingAsk(input: { ask: PendingAsk; node: string; runtime: BuckleRuntime }): string[] {
  const { request, call } = input.ask
  return describeAsk({ ...request, workspaceId: input.runtime.workspaceId, workspaceName: input.runtime.workspaceName(), node: input.node, approves: input.runtime.judgeApproves(), ...(call?.complete ? { call } : {}) })
}
