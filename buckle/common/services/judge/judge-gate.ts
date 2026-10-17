import type { JsonObject, WorkspacePolicy } from '@5straps/protocol'
import { redactCredentials } from '@5straps/runtime'
import { relative } from 'pathe'
import { baseCommand, commandSubject, shownCommand, shownWords } from '../../domain/argv.js'
import { compileCommandGlob } from '../../domain/command-glob.js'
import { allForms, commandFormsOf } from '../../domain/command-forms.js'
import { describeCall } from '../../domain/describe-call.js'
import type { ResolvedEffect } from '../../domain/effect.js'
import type { PathView } from '../../domain/path-view.js'
import { isInside } from '../../domain/paths.js'
import type { PermissionDecision } from '../../domain/permission/decision.js'
import { judgeable, judgePasses } from '../../domain/permission/judged.js'
import type { JudgeAudit } from '../../types/ports/action-log.js'
import type { JudgeNote } from '../../domain/approval-instruction.js'
import type { Judge, JudgeInput, JudgeMode, JudgeProvider, JudgeResult } from '../../types/ports/judge.js'
import { readInterpreterCode, type CodeView } from './code-reader.js'
import { judgeCacheKey, type JudgeCache } from './judge-cache.js'

type Ask = Extract<PermissionDecision, { kind: 'ask' }>

/** One rating of one ask's command: what the judge was shown (absent where it was shown nothing), and its answer. */
export interface JudgedAsk {
  subject: string
  provider: JudgeProvider | null
  model: string | null
  input: JudgeInput | null
  result: JudgeResult
}

/** A workspace's decision AI as one call meets it, built from the settings in force when the call started. */
export interface JudgeGate {
  readonly mode: JudgeMode
  /** Why the judge cannot rate in this workspace (a setting or the key missing), or null where it can. */
  readonly missing: string | null
  /** Rates each interpreter ask the judge may answer, once per distinct subject, from the cache where it holds the verdict. */
  rate(input: { asks: readonly Ask[]; effects: readonly ResolvedEffect[]; tool: string; args: JsonObject; signal?: AbortSignal }): Promise<JudgedAsk[]>
}

export interface JudgeSettings {
  mode: JudgeMode
  provider: JudgeProvider
  model: string
  standardScripts: readonly string[]
}

/**
 * The decision AI's gate for one workspace (D91 and its addendum): what it is shown of a call, built from the command as
 * the approver sees it, the code the interpreter runs read through the agent's own view (code-reader.ts), the lists in
 * force, and the sandbox's names for the working directory and the mounts; then the verdict, from the workspace's cache
 * where the same command, code, policy, and model were rated before, else from the judge, which is kept. A standard
 * development script is rated on its command line alone. Where the code cannot be read whole, or a setting or the key
 * is missing, the rating is unavailable without a request, so the call asks as before.
 */
export function createJudgeGate(input: {
  judge: Judge | null
  settings: JudgeSettings
  policy: WorkspacePolicy
  allowedInterpreters: ReadonlySet<string>
  paths: PathView
  view: CodeView
  cache: JudgeCache
}): JudgeGate {
  const { settings, paths } = input
  const missing = settings.mode !== 'off' && input.judge === null ? 'BUCKLE_JUDGE_API_KEY' : null
  const standard = settings.standardScripts.map(glob => compileCommandGlob(glob))
  const lists = {
    allow: [...input.policy.commands.allow], deny: [...input.policy.commands.deny],
    destructive: [...input.policy.commands.destructive ?? []], allowedInterpreters: [...input.allowedInterpreters],
  }
  const shownRoot = paths.mount ?? '/workspace'

  /** A real folder as the sandbox names it: the workspace's view, a named mount's, or the workspace when neither holds it. */
  const sandboxName = (real: string): string => {
    if (isInside(paths.root, real)) return joined(shownRoot, relative(paths.root, real))
    const mount = paths.mountOf(real)
    return mount && mount.target !== mount.source ? joined(mount.target, relative(mount.source, real)) : shownRoot
  }

  function shown(effect: Extract<ResolvedEffect, { kind: 'exec' }>, call: { tool: string; args: JsonObject }): JudgeInput | string {
    const forms = commandFormsOf(effect)
    const interpreters = forms.interpreters.filter(name => !input.allowedInterpreters.has(name))
    const running = allForms(forms).filter(([command = '']) => interpreters.includes(command) || interpreters.includes(baseCommand(command)))
    const standardScript = running.length > 0 && running.every(form => standard.some(glob => glob.matchesLine(form)))
    const cwd = workingDirectory(call.args)
    const code = standardScript ? { kind: 'read' as const, reading: { inline: null, files: [], packages: [] } } : readInterpreterCode({ forms: running, shellForms: allForms(forms), cwd, view: input.view })
    if (code.kind === 'refused') return code.reason
    const shownCwd = sandboxName(cwd)
    return {
      command: shownCommand(effect.command, effect.args),
      argv: shownWords(effect.command, effect.args),
      interpreters,
      ...code.reading,
      packagesTruncated: false,
      truncated: false,
      standardScript,
      policy: lists,
      cwd: shownCwd,
      mounts: [{ target: shownRoot, access: 'read-write' }, ...paths.mounts.filter(mount => !mount.scratch && mount.target !== mount.source).map(mount => ({ target: mount.target, access: mount.access === 'rw' ? 'read-write' as const : 'read-only' as const }))],
      description: describeCall({ tool: call.tool, args: call.args, cwd: shownCwd }),
    }
  }

  /** The real working directory a call names, its own `cwd` argument resolved in the view, else the workspace. */
  function workingDirectory(args: JsonObject): string {
    try { return paths.resolve(typeof args.cwd === 'string' ? args.cwd : '.') } catch { return paths.root }
  }

  return {
    mode: settings.mode,
    missing,
    async rate(call) {
      const subjects = [...new Set(call.asks.filter(judgeable).map(ask => ask.subject))]
      return Promise.all(subjects.map(async (subject): Promise<JudgedAsk> => {
        const { provider, model } = settings
        const unavailable = (reason: string, shownInput: JudgeInput | null = null): JudgedAsk => ({ subject, provider, model, input: shownInput, result: { kind: 'unavailable', reason } })
        if (missing !== null || input.judge === null) return unavailable(`the judge is not set up: ${missing ?? 'approval.judge'} is missing`)
        const effect = call.effects.find((item): item is Extract<ResolvedEffect, { kind: 'exec' }> => item.kind === 'exec' && commandSubject(item.command, item.args) === subject)
        if (!effect) return unavailable('the command was not found in the call')
        const asked = shown(effect, call)
        if (typeof asked === 'string') return unavailable(asked)
        const key = judgeCacheKey({ provider, model, policyUpdatedAt: input.policy.updatedAt, asked })
        const kept = input.cache.get(key)
        if (kept) return { subject, provider, model, input: asked, result: kept }
        const result = await input.judge.judge(asked, { model, ...(call.signal ? { signal: call.signal } : {}) })
        if (result.kind === 'verdict') await input.cache.set(key, result)
        return { subject, provider, model, input: asked, result }
      }))
    },
  }
}

/**
 * The notes an ask's call keeps for its approvers (D91): in automated mode what the judge said of each command it rated
 * and did not pass; on request, that each interpreter ask may be rated; nothing otherwise.
 */
export function judgeNotes(input: { gate: JudgeGate | undefined; asks: readonly Ask[]; judged: readonly JudgedAsk[] }): JudgeNote[] {
  const { gate } = input
  if (!gate || gate.missing !== null) return []
  const subjects = [...new Set(input.asks.filter(judgeable).map(ask => ask.subject))]
  if (gate.mode === 'on-request') return subjects.map(subject => ({ subject, onRequest: true as const }))
  if (gate.mode !== 'automated') return []
  return input.judged.filter(item => subjects.includes(item.subject)).map(({ subject, result, model }): JudgeNote => result.kind === 'verdict'
    ? { subject, level: result.level, confidence: result.confidence, model: model ?? result.model, reasoning: redactCredentials(result.reasoning, 'text') }
    : { subject, unavailable: result.reason })
}

/**
 * An ask as the agent is told of it once the judge rated its command and did not pass it (D91): its reason, then the
 * level alone, or that there was no verdict; never the reasoning, which would show an agent how to steer the next rating.
 */
export function withJudgeReason(ask: Ask, judged: readonly JudgedAsk[]): Ask {
  const rating = judgeable(ask) ? judged.find(item => item.subject === ask.subject) : undefined
  if (!rating) return ask
  return { ...ask, reason: `${ask.reason}; ${rating.result.kind === 'verdict' ? `the decision AI rated it ${rating.result.level}` : 'the decision AI gave no verdict'}` }
}

/** A gate for a workspace whose judge is off: it rates nothing, and reads no setting, file, or cache. */
export const JUDGE_OFF: JudgeGate = { mode: 'off', missing: null, rate: () => Promise.resolve([]) }

/**
 * What a call's audit entry keeps of its ratings (D91): the one that did not pass where any did not, else the one that
 * did, each with its provider and model; the reasoning with the credentials the display hides hidden.
 */
export function judgeAuditOf(judged: readonly JudgedAsk[]): JudgeAudit | undefined {
  const chosen = judged.find(item => !judgePasses(item.result)) ?? judged[0]
  if (!chosen) return undefined
  const named = { provider: chosen.provider ?? 'none', model: chosen.model ?? 'none' }
  const { result } = chosen
  if (result.kind === 'unavailable') return { ...named, unavailable: result.reason, passed: false }
  return { ...named, level: result.level, confidence: result.confidence, reasoning: redactCredentials(result.reasoning, 'text'), latencyMs: result.latencyMs, promptDigest: result.promptDigest, passed: judgePasses(result) }
}

function joined(target: string, rest: string): string {
  return rest === '' ? target : `${target.replace(/\/$/, '')}/${rest}`
}
