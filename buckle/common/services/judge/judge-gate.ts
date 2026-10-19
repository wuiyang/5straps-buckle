import type { JsonObject, WorkspacePolicy } from '@5straps/protocol'
import { redactCredentials } from '@5straps/runtime'
import { relative } from 'pathe'
import { baseCommand, commandSubject, parseArgv, shownCommand, shownWords } from '../../domain/argv.js'
import { compileCommandGlob } from '../../domain/command-glob.js'
import { allForms, commandFormsOf } from '../../domain/command-forms.js'
import { describeCall } from '../../domain/describe-call.js'
import type { ResolvedEffect } from '../../domain/effect.js'
import type { PathView } from '../../domain/path-view.js'
import { isInside } from '../../domain/paths.js'
import { logger } from '../../runtime/log.js'
import type { AskCause, PermissionDecision } from '../../domain/permission/decision.js'
import { judgeable, judgePasses, quickCovers, ratedDanger } from '../../domain/permission/judged.js'
import type { JudgeAudit, QuickAudit } from '../../types/ports/action-log.js'
import type { JudgeNote, QuickNote } from '../../domain/approval-instruction.js'
import { clippedResult, type Judge, type JudgeInput, type JudgeMode, type JudgeProvider, type JudgeResult } from '../../types/ports/judge.js'
import type { PackageScanner } from '../../types/ports/package-scan.js'
import { QUICK_STATE_BUDGET_BYTES, type QuickJudge, type QuickJudgeProvider, type QuickJudgeScope, type QuickResult } from '../../types/ports/quick-judge.js'
import { callVariables, codeLoadingReason, codeLoadingVariable, joinedVariables, MAX_SHOWN_VARIABLES, shownVariables } from './call-env.js'
import { assignedVariables, CHANGES_DIRECTORY, changesDirectory, LOADS_ENV_FILE, loadsEnvFile } from './call-forms.js'
import { CODE_REFUSALS, readBunScriptPreloads, readInterpreterCode, valueOptionsOf, type CodeView } from './code-reader.js'
import { judgeCacheKey, type JudgeCache } from './judge-cache.js'
import { withSocket } from './socket-view.js'

type Ask = Extract<PermissionDecision, { kind: 'ask' }>
type Exec = Extract<ResolvedEffect, { kind: 'exec' }>

/** What one stage said of one command: the provider and model it was asked under, and its answer. */
export interface StageRating<R> {
  provider: string
  model: string
  result: R
}

/**
 * What the decision AI said of one command (D91, addendum 2 B): what it was shown (null where its code could not be read
 * whole), each stage that answered, and what that did: the stage whose safe verdict ran the call, an allowed command the
 * quick stage turned into an ask, or one it rated and let run.
 */
export interface JudgedAsk {
  subject: string
  /** Why the destructive floor asked, where a stage rated an ask: a pass lifts that ask alone (passKey). */
  cause?: AskCause
  input: JudgeInput | null
  quick?: StageRating<QuickResult>
  thorough?: StageRating<JudgeResult>
  passedBy?: 'quick' | 'thorough'
  flagged?: true
  screened?: true
  /** The Socket lookup for its packages failed, so a verdict it reached was used and not kept (fix brief 2, H11). */
  socket?: 'unavailable'
}

/** The part of a call the decision AI reads: its effects, the tool and arguments, and the caller's signal. */
interface CallView {
  effects: readonly ResolvedEffect[]
  tool: string
  args: JsonObject
  signal?: AbortSignal
}

/** A workspace's decision AI as one call meets it, built from the settings in force when the call started. */
export interface JudgeGate {
  readonly mode: JudgeMode
  /** Whether any stage can rate here: the decision AI is on and the node holds a key for a stage the settings use. */
  readonly ready: boolean
  /** Whether the quick stage screens allowed commands too (approval.quickJudge all, with its key, in automated mode). */
  readonly screens: boolean
  /** Whether a stage rates this ask: an interpreter ask for the thorough stage, or a command ask the quick stage's scope covers. */
  covers(ask: Ask): boolean
  /** Automated mode: each ask it covers, once per distinct subject, by the routing of addendum 2 B. */
  rate(call: CallView & { asks: readonly Ask[] }): Promise<JudgedAsk[]>
  /** Automated mode, scope all: each command of the call no ask names, by the quick stage alone; a danger verdict flags it. */
  screen(call: CallView & { asked: ReadonlySet<string> }): Promise<JudgedAsk[]>
  /** On the owner's request: every stage that applies to one waiting ask, or to an allowed command flagged earlier (`ask` null). */
  rateOnRequest(call: CallView & { subject: string; ask: Ask | null }): Promise<JudgedAsk | null>
}

export interface JudgeSettings {
  mode: JudgeMode
  provider: JudgeProvider
  model: string
  standardScripts: readonly string[]
  quick: QuickJudgeScope
  quickProvider: QuickJudgeProvider
  quickModel: string
}

/** The programs that run a command as another user: a call with one in it is never a standard script. */
const PRIVILEGE_WRAPPERS = new Set(['sudo', 'doas', 'su', 'pkexec', 'runas'])
/** The extensions of a script `bun run` may name in place of a package.json script. */
const SCRIPT_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i

/** Why the quick stage was not asked about a call larger than it reads (QUICK_STATE_BUDGET_BYTES). */
export const QUICK_OVER_BUDGET = 'the call is larger than the quick stage reads'

/**
 * The decision AI's gate for one workspace (D91 and its addenda): what it is shown of a call, built from the command as
 * the approver sees it, the code the interpreter runs read through the agent's own view (code-reader.ts), the packages
 * with their versions and Socket's view, the lists in force, and the sandbox's names for the working directory and the
 * mounts; then each stage's verdict, from the workspace's cache where the same command, code, packages, policy, provider,
 * and model were rated in the last day, else from the stage, which is kept. Routing, in automated mode: the quick stage
 * first where its scope covers the ask, whose safe verdict at 0.8 or above runs the call and whose danger verdict at 0.8 or
 * above goes to a person; anything else goes to the thorough stage for an interpreter ask or one the quick stage rated,
 * and otherwise to a person. Nothing it says refuses a call.
 */
export function createJudgeGate(input: {
  judge: Judge | null
  quickJudge: QuickJudge | null
  settings: JudgeSettings
  policy: WorkspacePolicy
  allowedInterpreters: ReadonlySet<string>
  paths: PathView
  view: CodeView
  cache: JudgeCache
  scanner: PackageScanner
  /** False while the dangerously-allow switch is on: the owner asked for no asks, so no allowed command is screened. */
  screening?: boolean
}): JudgeGate {
  const { settings, paths } = input
  const thoroughReady = settings.mode !== 'off' && input.judge !== null
  const quickReady = settings.mode !== 'off' && settings.quick !== 'off' && input.quickJudge !== null
  const standard = settings.standardScripts.map(glob => compileCommandGlob(glob))
  const lists = {
    allow: [...input.policy.commands.allow], deny: [...input.policy.commands.deny],
    destructive: [...input.policy.commands.destructive ?? []], allowedInterpreters: [...input.allowedInterpreters],
  }
  const shownRoot = paths.mount ?? '/workspace'
  const covers = (ask: Ask) => (thoroughReady && judgeable(ask)) || (quickReady && quickCovers(settings.quick, ask))
  const screens = settings.mode === 'automated' && quickReady && settings.quick === 'all' && input.screening !== false

  /** A real folder as the sandbox names it: the workspace's view, a named mount's, or the workspace when neither holds it. */
  const sandboxName = (real: string): string => {
    if (isInside(paths.root, real)) return joined(shownRoot, relative(paths.root, real))
    const mount = paths.mountOf(real)
    return mount && mount.target !== mount.source ? joined(mount.target, relative(mount.source, real)) : shownRoot
  }

  /**
   * What a stage is shown of one command: for an ask, the code of each interpreter the policy does not allow; for an
   * allowed command (`allowed`), the code of every interpreter it runs. A reason in place of it where the code cannot be
   * read whole, where the call sets a variable that changes what code runs, which no stage could see run, where it
   * changes its working directory before the code runs, so the code read at its own may not be the code that runs, or
   * where its runtime loads variables from a file the reader does not follow (fix brief 3, F2).
   */
  function shown(effect: Exec, call: CallView, allowed: boolean, reason: string | null): JudgeInput | string {
    // The call's env argument, and every assignment its own words and shell text make (fix brief 2, H3).
    const forms = commandFormsOf(effect)
    const assigned = assignedVariables(effect, forms)
    const variables = callVariables(call.args)
    // The env argument and the assignments together, at most MAX_SHOWN_VARIABLES, else the call is refused before any
    // other check reads them all (fix brief 3, H3); either way no stage rates it.
    const joined = joinedVariables(variables, assigned.variables, MAX_SHOWN_VARIABLES)
    if (joined === null) return CODE_REFUSALS.truncated
    const loading = codeLoadingVariable([...variables, ...assigned.variables])
    if (loading !== undefined) return codeLoadingReason(loading)
    if (assigned.unread) return CODE_REFUSALS.truncated
    if (changesDirectory(forms)) return CHANGES_DIRECTORY
    if (loadsEnvFile(forms)) return LOADS_ENV_FILE
    const interpreters = forms.interpreters.filter(name => !input.allowedInterpreters.has(name))
    const reading = allowed ? forms.interpreters : interpreters
    const running = allForms(forms).filter(([command = '']) => reading.includes(command) || reading.includes(baseCommand(command)))
    const cwd = workingDirectory(call.args)
    // A standard script is matched as the allow list matches a call, on the words as typed, so `npm run dev` is one though
    // npm runs no interpreter Buckle names; or, inside shell text or behind a wrapper, where every interpreter form it runs
    // is one. Never `bun run <file>`, which runs the workspace's own file and is read as `bun <file>` is, and never a call
    // with a privilege wrapper anywhere in it (fix brief 1, item 15).
    const standardForm = (form: string[]) => standard.some(glob => glob.matchesLine(form)) && !runsFile(form, cwd)
    const privileged = allForms(forms).some(([command = '']) => PRIVILEGE_WRAPPERS.has(baseCommand(command)))
    const typed = [parseArgv(effect.command, effect.args).command, ...effect.args]
    const standardScript = !privileged && (standardForm(typed) || (running.length > 0 && running.every(standardForm)))
    // A standard script's own code is not read, but what bun loads before it is: its preloads and its bunfig.toml's (fix brief 3, R15).
    // The chain tells the reader which forms the call runs itself and which come from shell text, which it reads only as
    // one simple command (fix brief 4, P).
    // The call as typed tells the reader the command word each chain form had before the rules reduced it; a host path
    // Buckle supplies itself (its own node) stands as the name it is shown by (fix brief 6, B1).
    const typedWords = [effect.shownAs ?? effect.command, ...effect.args]
    const code = standardScript ? readBunScriptPreloads({ forms: allForms(forms), chain: forms.chain, typed: typedWords, pieces: forms.pieces, cwd, view: input.view }) : readInterpreterCode({ forms: running, chain: forms.chain, typed: typedWords, pieces: forms.pieces, cwd, view: input.view })
    if (code.kind === 'refused') return code.reason
    const shownCwd = sandboxName(cwd)
    // A host path Buckle supplies itself is shown as the program's name; the agent's own command stays as typed.
    const program = effect.shownAs ?? effect.command
    return {
      command: shownCommand(program, effect.args),
      argv: shownWords(program, effect.args),
      interpreters,
      ...code.reading,
      env: shownVariables(joined),
      packagesTruncated: false,
      truncated: false,
      standardScript,
      policy: lists,
      cwd: shownCwd,
      mounts: [{ target: shownRoot, access: 'read-write' }, ...paths.mounts.filter(mount => !mount.scratch && mount.target !== mount.source).map(mount => ({ target: mount.target, access: mount.access === 'rw' ? 'read-write' as const : 'read-only' as const }))],
      description: describeCall({ tool: call.tool, args: call.args, cwd: shownCwd }),
      reason,
    }
  }

  /**
   * Whether a form is `bun run` naming a file rather than a package.json script: its first operand after `run` and its
   * flags, each flag's value skipped as the code reader skips it (fix brief 2, R15), holds a slash, ends in a script
   * extension, or names a file in the agent's view.
   */
  function runsFile(form: readonly string[], cwd: string): boolean {
    const [command = '', ...args] = form
    if (baseCommand(command) !== 'bun') return false
    const run = operandAt(args, 0, valueOptionsOf('bun'))
    if (args[run] !== 'run') return false
    const operand = args[operandAt(args, run + 1, valueOptionsOf('bun'))]
    if (operand === undefined) return false
    return /[/\\]/.test(operand) || SCRIPT_EXTENSION.test(operand) || typeof input.view.locate(operand, cwd) === 'object'
  }

  /** The real working directory a call names, its own `cwd` argument resolved in the view, else the workspace. */
  function workingDirectory(args: JsonObject): string {
    try { return paths.resolve(typeof args.cwd === 'string' ? args.cwd : '.') } catch { return paths.root }
  }

  /**
   * One command's input, with Socket's view added at most once and only when a stage is asked rather than its cache;
   * `socketFailed` once that lookup failed, so no verdict reached with it is kept (fix brief 2, H11).
   */
  function prepared(asked: JudgeInput, signal: AbortSignal | undefined) {
    let enriched: Promise<JudgeInput> | undefined
    let settled: JudgeInput | undefined
    let failed = false
    return {
      asked,
      sent: async () => {
        enriched ??= withSocket(asked, input.scanner, signal).then((value) => { failed = value.failed; return (settled = value.input) })
        return enriched
      },
      shown: () => settled ?? asked,
      socketFailed: () => failed,
    }
  }
  type Prepared = ReturnType<typeof prepared>

  /** A rating finished: what the stages were shown, and that the Socket lookup failed where it did. */
  const finished = (judged: JudgedAsk, command: Prepared): JudgedAsk => ({ ...judged, input: command.shown(), ...(command.socketFailed() ? { socket: 'unavailable' as const } : {}) })
  async function thorough(command: Prepared, signal: AbortSignal | undefined): Promise<StageRating<JudgeResult>> {
    const { provider, model } = settings
    const key = judgeCacheKey({ provider, model, policyUpdatedAt: input.policy.updatedAt, asked: command.asked })
    const kept = input.cache.get(key)
    if (kept && 'reasoning' in kept) return { provider, model, result: clippedResult(kept) }
    // Clipped whichever adapter answered, before it is kept, so every reader downstream sees the same bounded text.
    const result = clippedResult(await input.judge!.judge(await command.sent(), { model, ...(signal ? { signal } : {}) }))
    if (result.kind === 'verdict' && !command.socketFailed()) await input.cache.set(key, result)
    return { provider, model, result }
  }

  async function quick(command: Prepared, signal: AbortSignal | undefined): Promise<StageRating<QuickResult>> {
    const { quickProvider: provider, quickModel: model } = settings
    const key = judgeCacheKey({ provider, model, policyUpdatedAt: input.policy.updatedAt, asked: command.asked })
    const kept = input.cache.get(key)
    if (kept && 'probabilities' in kept) return { provider, model, result: kept }
    const state = await command.sent()
    // Jev reads 64k tokens a request: past the budget it is not asked at all, and the routing goes on without it.
    if (Buffer.byteLength(JSON.stringify(state)) > QUICK_STATE_BUDGET_BYTES) return { provider, model, result: { kind: 'unavailable', reason: QUICK_OVER_BUDGET } }
    const result = await input.quickJudge!.quick(state, { model, ...(signal ? { signal } : {}) })
    if (result.kind === 'verdict' && !command.socketFailed()) await input.cache.set(key, result)
    return { provider, model, result }
  }

  /**
   * A command no stage was shown, its reason in the place of the first stage that would have rated it, clipped once here
   * (UNREAD_REASON_LIMIT) so the audit entry, the approver note, the terminal line, and the webhook stay bounded.
   */
  function unread(subject: string, reason: string, stage: 'quick' | 'thorough'): JudgedAsk {
    const result = { kind: 'unavailable' as const, reason: clippedReason(reason) }
    return stage === 'quick'
      ? { subject, input: null, quick: { provider: settings.quickProvider, model: settings.quickModel, result } }
      : { subject, input: null, thorough: { provider: settings.provider, model: settings.model, result } }
  }

  /** The routing of addendum 2 B for one ask in automated mode. */
  async function route(ask: Ask, effect: Exec, call: CallView): Promise<JudgedAsk> {
    const quickFirst = quickReady && quickCovers(settings.quick, ask)
    const asked = shown(effect, call, false, ask.reason)
    if (typeof asked === 'string') return { ...unread(ask.subject, asked, quickFirst ? 'quick' : 'thorough'), ...(ask.cause ? { cause: ask.cause } : {}) }
    const command = prepared(asked, call.signal)
    const judged: JudgedAsk = { subject: ask.subject, ...(ask.cause ? { cause: ask.cause } : {}), input: asked }
    if (quickFirst) {
      judged.quick = await quick(command, call.signal)
      if (judgePasses(judged.quick.result)) return finished({ ...judged, passedBy: 'quick' }, command)
      if (ratedDanger(judged.quick.result)) return finished(judged, command)
    }
    // An interpreter ask goes on to the thorough stage; another the quick stage rated without settling it does too.
    if (thoroughReady && (judgeable(ask) || judged.quick?.result.kind === 'verdict')) {
      judged.thorough = await thorough(command, call.signal)
      if (judgePasses(judged.thorough.result)) judged.passedBy = 'thorough'
    }
    return finished(judged, command)
  }

  return {
    mode: settings.mode,
    ready: thoroughReady || quickReady,
    screens,
    covers,
    async rate(call) {
      const chosen = new Map<string, Ask>()
      for (const ask of call.asks) if (covers(ask) && !chosen.has(ask.subject)) chosen.set(ask.subject, ask)
      return Promise.all([...chosen.values()].map((ask) => {
        const effect = execOf(call.effects, ask.subject)
        return effect ? route(ask, effect, call) : Promise.resolve(unread(ask.subject, 'the command was not found in the call', 'thorough'))
      }))
    },
    async screen(call) {
      if (!screens) return []
      const commands = new Map<string, Exec>()
      for (const effect of call.effects) {
        if (effect.kind !== 'exec') continue
        const subject = commandSubject(effect.command, effect.args)
        if (!call.asked.has(subject) && !commands.has(subject)) commands.set(subject, effect)
      }
      return Promise.all([...commands].map(async ([subject, effect]): Promise<JudgedAsk> => {
        const asked = shown(effect, call, true, null)
        if (typeof asked === 'string') return { ...unread(subject, asked, 'quick'), screened: true }
        const command = prepared(asked, call.signal)
        const rating = await quick(command, call.signal)
        return finished({ subject, input: asked, quick: rating, screened: true, ...(ratedDanger(rating.result) ? { flagged: true as const } : {}) }, command)
      }))
    },
    async rateOnRequest(call) {
      const effect = execOf(call.effects, call.subject)
      if (!effect) return null
      const quickApplies = quickReady && (call.ask ? quickCovers(settings.quick, call.ask) : settings.quick === 'all')
      const thoroughApplies = thoroughReady && (call.ask ? judgeable(call.ask) || quickApplies : quickApplies)
      if (!quickApplies && !thoroughApplies) return null
      const asked = shown(effect, call, call.ask === null, call.ask?.reason ?? null)
      if (typeof asked === 'string') return unread(call.subject, asked, thoroughApplies ? 'thorough' : 'quick')
      const command = prepared(asked, call.signal)
      // The owner asked, so every stage that applies rates it, and both verdicts are shown.
      const [quickRating, thoroughRating] = await Promise.all([quickApplies ? quick(command, call.signal) : undefined, thoroughApplies ? thorough(command, call.signal) : undefined])
      const passedBy = thoroughRating && judgePasses(thoroughRating.result) ? 'thorough' as const : quickRating && judgePasses(quickRating.result) ? 'quick' as const : undefined
      return finished({ subject: call.subject, ...(call.ask?.cause ? { cause: call.ask.cause } : {}), input: asked, ...(quickRating ? { quick: quickRating } : {}), ...(thoroughRating ? { thorough: thoroughRating } : {}), ...(passedBy ? { passedBy } : {}) }, command)
    },
  }
}

/** The most of a reason no stage rated that Buckle keeps or shows, in characters (fix brief 3, F4). */
export const UNREAD_REASON_LIMIT = 500

/**
 * A reason at most UNREAD_REASON_LIMIT characters long, counted by code point, a longer one cut to end in ` [cut]`, and
 * never inside a JSON escape a quoted name holds (`\u00`), which would read as broken text (fix brief 4, G13).
 */
export function clippedReason(reason: string): string {
  if (reason.length <= UNREAD_REASON_LIMIT) return reason
  const characters = Array.from(reason)
  if (characters.length <= UNREAD_REASON_LIMIT) return reason
  return `${withoutOpenEscape(characters.slice(0, UNREAD_REASON_LIMIT - ' [cut]'.length).join(''))} [cut]`
}

/** A cut text without the JSON escape its end leaves open: a last unescaped backslash whose escape is not whole. */
function withoutOpenEscape(text: string): string {
  const at = text.lastIndexOf('\\')
  if (at < 0 || at < text.length - 6) return text
  let run = 0
  for (let index = at; index >= 0 && text[index] === '\\'; index--) run++
  // An even run is escaped backslashes, each whole; an odd one leaves the last backslash starting an escape.
  if (run % 2 === 0) return text
  const escape = text.slice(at + 1)
  const whole = escape.startsWith('u') ? /^u[0-9a-fA-F]{4}/.test(escape) : escape.length > 0
  return whole ? text : text.slice(0, at)
}

/** The index of the first operand from `from` on, past options and the value of each that takes one, or after a `--`; -1 for none. */
function operandAt(args: readonly string[], from: number, values: readonly string[]): number {
  for (let index = from; index < args.length; index++) {
    const word = args[index]!
    if (word === '--') return index + 1 < args.length ? index + 1 : -1
    if (!word.startsWith('-')) return index
    if (values.includes(word)) index++
  }
  return -1
}

/** The command a subject names among a call's effects. */
function execOf(effects: readonly ResolvedEffect[], subject: string): Exec | undefined {
  return effects.find((item): item is Exec => item.kind === 'exec' && commandSubject(item.command, item.args) === subject)
}

/**
 * The notes an ask's call keeps for its approvers (D91): in automated mode what each stage said of each command it rated
 * and did not pass, a command the quick stage flagged among them; on request, that each ask a stage covers may be rated;
 * nothing otherwise.
 */
export function judgeNotes(input: { gate: JudgeGate | undefined; asks: readonly Ask[]; judged: readonly JudgedAsk[] }): JudgeNote[] {
  const { gate } = input
  if (!gate || !gate.ready) return []
  const waiting = new Set(input.asks.filter(ask => gate.covers(ask) || ask.cause === 'judge').map(ask => ask.subject))
  if (gate.mode === 'on-request') return [...waiting].map(subject => ({ subject, onRequest: true as const }))
  if (gate.mode !== 'automated') return []
  return input.judged.filter(item => waiting.has(item.subject)).map(judgeNoteOf)
}

/**
 * The serve terminal's line for a command a stage passed (fix brief 1, item 22), once the call is checked again (fix
 * brief 2, H9 and H13): the stage, the model that answered, the level and confidence, and the command subject as the
 * approver display shows it, credentials hidden. Where the call now runs, it says so; where other asks remain
 * (`waitingFor`, their rule kinds), it says the call still waits for them, naming no subject, env value, or key. The
 * webhook is not called for a pass.
 */
export function announcePass(judged: JudgedAsk, waitingFor: readonly string[]): void {
  const rating = judged.passedBy === 'quick' ? judged.quick : judged.passedBy === 'thorough' ? judged.thorough : undefined
  if (rating?.result.kind !== 'verdict') return
  const { level, confidence, model } = rating.result
  const rules = [...new Set(waitingFor)]
  const then = rules.length === 0 ? 'so it runs without asking' : `and the call still waits for ${listed(rules)}`
  logger.info(`The decision AI's ${judged.passedBy} stage rated a command ${level}, ${then}`, { stage: judged.passedBy, model, level, confidence, subject: judged.subject })
}

/** Names in prose: `a`, `a and b`, `a, b, and c`. */
function listed(names: readonly string[]): string {
  return names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`
}

/** One rating as the note an approver reads beside the action: the thorough stage's verdict where it ran, the quick stage's beside it. */
export function judgeNoteOf(judged: JudgedAsk): JudgeNote {
  const { subject } = judged
  const quick = judged.quick ? quickNoteOf(judged.quick) : undefined
  const beside = quick ? { quick } : {}
  if (judged.thorough) {
    const { result, model } = judged.thorough
    return result.kind === 'verdict'
      ? { subject, level: result.level, confidence: result.confidence, model, reasoning: redactCredentials(result.reasoning, 'text'), latencyMs: result.latencyMs, ...beside }
      : { subject, unavailable: result.reason, ...beside }
  }
  return quick ? { subject, quick } : { subject, unavailable: 'no stage rated it' }
}

function quickNoteOf(rating: StageRating<QuickResult>): QuickNote {
  const { result } = rating
  return result.kind === 'verdict' ? { level: result.level, confidence: result.confidence, model: result.model, latencyMs: result.latencyMs } : { unavailable: result.reason }
}

/**
 * An ask as the agent is told of it once the decision AI rated its command and did not pass it (D91): its reason, then the
 * level alone, the thorough stage's where it ran, or that there was no verdict; never the reasoning, which would show an
 * agent how to steer the next rating.
 */
export function withJudgeReason(ask: Ask, judged: readonly JudgedAsk[]): Ask {
  const rating = ask.rule === 'destructive_command' && ask.cause !== 'judge' ? judged.find(item => item.subject === ask.subject && !item.screened) : undefined
  if (!rating) return ask
  const result = rating.thorough?.result ?? rating.quick?.result
  if (!result) return ask
  return { ...ask, reason: `${ask.reason}; ${result.kind === 'verdict' ? `the decision AI rated it ${result.level}` : 'the decision AI gave no verdict'}` }
}

/** A gate for a workspace whose decision AI is off: it rates nothing, and reads no setting, file, or cache. */
export const JUDGE_OFF: JudgeGate = {
  mode: 'off', ready: false, screens: false, covers: () => false,
  rate: () => Promise.resolve([]), screen: () => Promise.resolve([]), rateOnRequest: () => Promise.resolve(null),
}

/**
 * What a call's audit entry keeps of its ratings (D91): a command the quick stage flagged, else an ask none passed, else
 * one a stage passed, else an allowed command the quick stage rated; each stage's verdict with its provider and model,
 * the thorough reasoning with the credentials the display hides hidden.
 */
export function judgeAuditOf(judged: readonly JudgedAsk[]): JudgeAudit | undefined {
  const asked = judged.filter(item => !item.screened)
  const chosen = judged.find(item => item.flagged) ?? asked.find(item => item.passedBy === undefined) ?? asked[0] ?? judged[0]
  return chosen ? auditOf(chosen) : undefined
}

/** One rating as an audit entry keeps it; `passed` says whether it ran or approved the call (on request: whether the owner's command approved it). */
export function auditOf(item: JudgedAsk, passed = item.passedBy !== undefined): JudgeAudit {
  const quick = item.quick ? quickAuditOf(item.quick) : undefined
  const marks = { ...(item.passedBy ? { passedBy: item.passedBy } : {}), ...(item.flagged ? { flagged: true as const } : {}), ...(item.screened ? { screened: true as const } : {}), ...(item.socket ? { socket: item.socket } : {}) }
  if (item.thorough) {
    const { provider, model, result } = item.thorough
    const beside = { ...(quick ? { quick } : {}), ...marks }
    return result.kind === 'unavailable'
      ? { provider, model, unavailable: result.reason, passed: false, ...beside }
      : { provider, model, level: result.level, confidence: result.confidence, reasoning: redactCredentials(result.reasoning, 'text'), latencyMs: result.latencyMs, promptDigest: result.promptDigest, passed, ...beside }
  }
  return { quick: quick!, passed, ...marks }
}

function quickAuditOf(rating: StageRating<QuickResult>): QuickAudit {
  const { provider, model, result } = rating
  return result.kind === 'verdict'
    ? { provider, model: result.model, level: result.level, confidence: result.confidence, probabilities: result.probabilities, latencyMs: result.latencyMs }
    : { provider, model, unavailable: result.reason }
}

function joined(target: string, rest: string): string {
  return rest === '' ? target : `${target.replace(/\/$/, '')}/${rest}`
}
