import type { JsonObject, JsonValue } from '@5straps/protocol'

/**
 * What Buckle needs from a script VM for code mode (owner decision D82): run an agent's script that can do nothing
 * but call the tools it is handed, answer each call from the host, and say how the script ended. A run is
 * deterministic (a fixed clock start and seed, results applied in their numbered order), so a host that answers it
 * again with the same results in the same order sees the same calls: that is how a script resumes after an ask.
 * The adapter today is pi-codemode's QuickJS (adapters/script-vm/pi-codemode.ts); the owner plans a VM of Buckle's
 * own, which implements this port and nothing else changes.
 */
export interface ScriptVm {
  /** Starts one run, or refuses at once, naming why, when the VM takes no more runs now. */
  start(input: ScriptVmRunInput): ScriptVmRun | { busy: string }
  /**
   * The TypeScript declarations a script reads its tools as, one `declare const tools` block: each tool's
   * description as its doc comment and its input schema as its argument type; every call resolves to `unknown`.
   */
  declare(tools: readonly ScriptVmToolSchema[]): string
  /** The identifier a script calls a tool by, `tools.<identifier>(args)`. */
  identifier(name: string): string
}

/** A tool as its declaration shows it. */
export interface ScriptVmToolSchema {
  name: string
  description: string
  inputSchema: JsonObject
}

/** A tool as the script sees it: `tools.<jsName>(args)`, and its `ALL_TOOLS` entry. */
export interface ScriptVmTool {
  name: string
  /** The identifier the script calls it by; a resumed run passes the one its first run had. */
  jsName: string
  description: string
}

export interface ScriptVmLimits {
  /** The run's deadline from its start, in milliseconds; past it the run ends as `timeout`. */
  deadlineMs: number
  /** The most memory the script's heap may take; past it an allocation fails inside the script. */
  memoryBytes: number
  /** The most output text a run returns: a longer output keeps its start and its end around an omission marker. */
  outputChars: number
}

export interface ScriptVmRunInput {
  script: string
  tools: ScriptVmTool[]
  /** Top-level functions beside `tools`, answered by the host like a tool call and never counted as one. */
  globals: string[]
  limits: ScriptVmLimits
  /** The VM clock's start, in milliseconds since the epoch. */
  startedAt: number
  /** Seeds the VM's randomness: a 32-bit unsigned integer. */
  seed: number
  /** Ends the run as `aborted`, with an error the script cannot catch. */
  signal?: AbortSignal
  /** Names the VM before the script runs (engine, prelude, limits): a resumed run on another VM is refused. */
  onStarted?(fingerprint: string): void
  /** The script made a call; answer it with `ScriptVmRun.deliver`, now or later. */
  onCall(call: ScriptVmCall): void
}

export interface ScriptVmCall {
  /** The VM's own number for the call: 1, 2, ... in the order the script made its calls, tools and globals alike. */
  id: number
  target: 'tool' | 'global'
  /** The tool's name, or the global's. */
  name: string
  /** What the script passed, after a JSON round trip. */
  args: JsonValue | undefined
}

/** A call's answer: a value, or a rejection whose `Error` carries `properties` as its own (such as `code`). */
export type ScriptVmOutcome =
  | { ok: true; value?: JsonValue }
  | { ok: false; message: string; properties?: JsonObject }

export interface ScriptVmRun {
  /**
   * Answers call `id` as result number `seq`: numbered 1, 2, ... without gaps, and applied strictly in that order
   * whatever order they arrive in. `now` is what the VM clock reads while it applies it. Throws for a call not
   * waiting or a number used before; does nothing once the run has ended.
   */
  deliver(seq: number, now: number, id: number, outcome: ScriptVmOutcome): void
  /** Whether the run has its outcome: no call can be answered any more. */
  readonly finished: boolean
  /** Settles once the run has ended and its VM has stopped. */
  readonly result: Promise<ScriptVmResult>
}

export type ScriptVmErrorKind =
  /** The script threw or did not parse. */
  | 'script'
  /** The deadline passed. */
  | 'timeout'
  /** The signal fired. */
  | 'aborted'
  /** The VM failed outside the script's control. */
  | 'sandbox'

export interface ScriptVmError {
  kind: ScriptVmErrorKind
  name?: string
  message: string
  stack?: string
}

/** One item of the script's output, in the order it made them: `text()`, or a `console.*` line. */
export interface ScriptVmOutputItem {
  kind: 'text' | 'console'
  text: string
}

export interface ScriptVmCallRecord {
  id: number
  name: string
  status: 'ok' | 'error' | 'cancelled'
  durationMs: number
}

export interface ScriptVmResult {
  ok: boolean
  /** The script's return value, when it returned one. */
  value?: JsonValue
  /** Cut to `limits.outputChars` (keeping the start and the end), when `outputTruncated`. */
  output: ScriptVmOutputItem[]
  outputTruncated: boolean
  /** Every tool call the script made, globals left out. */
  calls: ScriptVmCallRecord[]
  error?: ScriptVmError
}
