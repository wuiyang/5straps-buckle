/**
 * The decision AI (D91): a standard model the node asks to rate one interpreter invocation that the owner's policy
 * admitted but Buckle cannot read as shell. It sees what this input holds and nothing else: the command as an approver
 * sees it, the code it runs from the workspace's own files, the workspace's lists in force, where the command runs as
 * the sandbox names it, the mounts it can reach, and the variables the call itself sets. No value of the node's own
 * environment, host path, or credential is part of it.
 * The SDK that asks a provider is one adapter (adapters/judge/ai-sdk.ts), and each provider one file beside it.
 */
export interface Judge {
  judge(input: JudgeInput, options: JudgeOptions): Promise<JudgeResult>
}

/** The providers a workspace's judge may name (approval.judgeProvider), each an adapter of this port. */
export const JUDGE_PROVIDERS = ['openai-compatible'] as const
export type JudgeProvider = typeof JUDGE_PROVIDERS[number]

/**
 * When a workspace hands unknown interpreter calls and script file runs to the decision AI (approval.judge): never; when its owner asks
 * (`buckle approvals judge <token>`); or at each call, where a safe rating runs the call without a person.
 */
export const JUDGE_MODES = ['off', 'on-request', 'automated'] as const
export type JudgeMode = typeof JUDGE_MODES[number]

/** A model name as approval.judgeModel holds it: no blank and no control character, at most 200 characters. */
export const JUDGE_MODEL_NAME = /^[^\s\p{Cc}]{1,200}$/u

/** How one rating is asked: the model the workspace names (approval.judgeModel), and the caller's signal. */
export interface JudgeOptions {
  model: string
  signal?: AbortSignal
}

import { redactCredentials } from '@5straps/runtime'
import type { SocketSummary } from './package-scan.js'

/** One of the workspace's own files the code runs: a script the command names, or a local file one imports. */
export interface JudgeFile {
  /** As the sandbox names it, never a host path. */
  path: string
  sha256: string
  bytes: number
  content: string
}

export interface JudgeInput {
  /** The command as an approver sees it: whole, quoted, and with the credentials the display hides hidden. */
  command: string
  /** Its words, each as the shown command shows it. */
  argv: string[]
  /** The interpreters the reading limit named: the programs the policy does not allow. */
  interpreters: string[]
  /** The code the command line hands the interpreter itself (`-c`, `-e`), or null. */
  inline: string | null
  /**
   * The variables the call sets: its `env` argument and the values its own words and shell text assign (fix brief 2,
   * H3), sorted by name, each value as the agent gave it with a secret's hidden (fix brief 1, item 14). A call setting
   * one that changes what code runs (CODE_LOADING_VARIABLES), wherever it sets it, is never rated.
   */
  env: Array<{ name: string; value: string }>
  /** The scripts the command names and every local file they import, transitively, each read once. */
  files: JudgeFile[]
  /** The third-party packages the code imports, each with the version installed where Buckle finds one and Socket's view of it: their code is not read. */
  packages: JudgePackage[]
  /** Whether more packages carried a version than Socket was asked about (PACKAGE_SCAN_LIMIT), so some keep no summary. */
  packagesTruncated: boolean
  /** Whether the code ran past what is read; a call whose code does is never rated, so a rated input says false. */
  truncated: boolean
  /** Whether the command is one of the owner's standard development scripts, rated on its command line alone. */
  standardScript: boolean
  /**
   * For a standard script naming a package.json script (`npm run build`, `npm test`, `pnpm dev`, `bun run dev`), that
   * script's text from the working directory's package.json, with the credentials the display hides hidden and clipped as
   * a reasoning is: context for the stages, not code Buckle read; absent for every other call (addendum 3 R3).
   */
  scriptText?: string
  /** The workspace's command lists in force, the node's floor included. */
  policy: { allow: string[]; deny: string[]; destructive: string[]; allowedInterpreters: string[] }
  /** The working directory as the sandbox names it: `/workspace`, or a folder inside it, never a host path. */
  cwd: string
  /** The places the command can reach, each as the sandbox names it, with its access. */
  mounts: Array<{ target: string; access: 'read-write' | 'read-only' }>
  /** The node's own summary of the call, as an approver reads it, when there is one. */
  description: string | null
  /** Why Buckle asked about the command, as an approver reads it; null for an allowed command the quick stage screens. */
  reason: string | null
}

/**
 * A third-party package the code imports (D91, addendum 2 C): its name, its version from the nearest
 * `node_modules/<name>/package.json` inside the workspace or its mount (null where none is found, and always for Python),
 * and Socket's summary of that version where the node has one.
 */
export interface JudgePackage {
  name: string
  version: string | null
  socket: SocketSummary | null
}

/** The three levels every rating answers in, from both stages. */
export const JUDGE_LEVELS = ['safe', 'warning', 'danger'] as const
export type JudgeLevel = typeof JUDGE_LEVELS[number]

export type JudgeResult =
  | { kind: 'verdict'; level: JudgeLevel; confidence: number; reasoning: string; model: string; latencyMs: number; promptDigest: string }
  /** No verdict: a timeout, the network, a refusal, an answer that is no verdict, an echo of another command, code past what is read, or no key. Never names a host path or a key. */
  | { kind: 'unavailable'; reason: string }

export type JudgeVerdict = Extract<JudgeResult, { kind: 'verdict' }>

/**
 * The most of a thorough verdict's reasoning Buckle keeps or shows, in characters (fix brief 1, items 18 and 23), so a
 * result entry stays inside the audit log's 64 KiB: the audit entry, the approver's line, the webhook, the cache, and
 * `buckle approvals judge` all read it clipped.
 */
export const JUDGE_REASONING_LIMIT = 2_000
const CUT = '\n[cut]'

/**
 * A reasoning with the credentials the display hides hidden, whatever its length (fix brief 3, F7), so none is kept raw,
 * judge-cache.json included; then at most JUDGE_REASONING_LIMIT characters long, a longer one cut to end in `[cut]` on a
 * line of its own (fix brief 2, R18), so a credential line cut inside its value stays a NAME=value line the display's
 * redaction still hides, and no part of the value shows.
 */
export function clippedReasoning(reasoning: string): string {
  const hidden = redactCredentials(reasoning, 'text')
  if (hidden.length <= JUDGE_REASONING_LIMIT) return hidden
  const characters = Array.from(hidden)
  return characters.length <= JUDGE_REASONING_LIMIT ? hidden : `${characters.slice(0, JUDGE_REASONING_LIMIT - CUT.length).join('')}${CUT}`
}

/** A rating with its reasoning redacted and clipped (clippedReasoning), before anything keeps or shows it; no verdict as it came. */
export function clippedResult(result: JudgeResult): JudgeResult {
  return result.kind === 'verdict' ? { ...result, reasoning: clippedReasoning(result.reasoning) } : result
}

/** The judge of a node with none: every rating is unavailable. */
export const nullJudge: Judge = {
  judge: () => Promise.resolve({ kind: 'unavailable', reason: 'the judge is off' }),
}
