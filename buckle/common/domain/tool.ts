import { z } from 'zod'
import type { ApprovalRequest, CapabilityRisk, InvokeResponse, JsonObject, JsonValue, ToolCapability } from '@5straps/protocol'
import { TOOL_NAME_PATTERN } from '@5straps/protocol'
import type { ToolEffect } from './effect.js'

/**
 * One value filled into a browser from a secret reference (docs/secrets.md): its file as the rules judged it and as
 * written, its NAME, and the sha256 of the value it was, so a file changed since is told apart while the page still holds
 * the value it was filled with.
 */
export interface FilledSecret {
  real: string
  written: string
  name: string
  digest: string
}

export interface ToolContext {
  requestId: string
  sessionId: string
  stageId?: string
  /**
   * The stage the change history files this call's changes under: the caller's stage or run, else, for a call a
   * script made, the code_run call that sent the script, else this call's own requestId (invoker.ts historyStage).
   * Set by the invoker, so a tool that checkpoints its own changes files them where every other write goes.
   */
  historyStage?: string
  historyTurnStage?: string | null
  historyParentRequestId?: string
  timeoutMs: number
  signal: AbortSignal
  /**
   * Set by the invoker on a tool that takes the workspace's write lock itself (`managesHistory`, the isolated shell): called
   * once that lock is held and the tool's copy of the workspace is taken, just before its program starts. It throws
   * CodeChangedError where the code a pass of the decision AI rated has changed since, and the tool then runs nothing
   * (fix brief 9, B31).
   */
  beginRun?: () => void
  /**
   * Set beside `beginRun`: runs `wait`, the tool's wait for the workspace's write lock and its work under that lock before
   * the program starts, outside the call's timer, as the invoker's own wait for the lock and its checkpoint are, under the
   * signal it hands `wait`, the caller's cancel and the shutdown alone. The timer then goes on with the time it had left
   * (D91 follow-ups, F4 residue).
   */
  untimed?: <T>(wait: (signal: AbortSignal | undefined) => Promise<T>) => Promise<T>
  /**
   * Whether the rules allow reading an absolute host path the tool reached mid-call (a listed child
   * beneath its judged directory, a searched file), judged where it lands now; never an agent's name.
   */
  authorizeRead?: (path: string) => Promise<boolean>
  /**
   * Whether the rules allow writing an absolute host path the tool reaches mid-call (a file a revert rewrites), judged
   * where it lands now as the entry it is, beside the approvals this call spent; never an agent's name. A rule that would
   * ask a person is no allowance: the tool refuses, since nobody can be asked mid-call.
   */
  authorizeWritePath?: (path: string) => Promise<boolean>
  /** Whether a real path is one the call's permission check judged as a read; a reader refuses any other. */
  authorizeReadTarget?: (target: string) => boolean
  /** Whether a real path is one the call's permission check judged as a write; a writer refuses any other. */
  authorizeWrite?: (target: string) => boolean
  /** Whether a real entry path is one the call's permission check judged as a delete; a remover refuses any other. */
  authorizeDelete?: (target: string) => boolean
  /**
   * Whether a restore of the change history, as planned under the execution lock, is the one the call's permission check
   * judged: the same checkpoint, newest checkpoint, and count. A restorer refuses any other, as the history moved since.
   */
  authorizeRestore?: (plan: { checkpoint: string; head: string; undoes: number }) => boolean
  /**
   * Marks a real path as a file this session has seen the content of, read or written, for the destructive-write check
   * (the fs-verbs brief): a later write that empties or halves it asks no person on that account.
   */
  known?: (target: string) => void
  /**
   * The entry at a real path (a file, or a folder with everything in it) now stands at `to`, or is gone (`to` is null): the
   * session read sets follow it and forget whatever stood at `to`, so a file moved onto a path someone read does not count as read.
   */
  relocated?: (from: string, to: string | null) => void
  /**
   * The request headers whose values Buckle filled from secret references (docs/secrets.md): a fetch drops them on a
   * hop to another origin, as it drops a credential header.
   */
  secretHeaders?: readonly string[]
  /**
   * The values a browser fill or type call hands the browser from secret references (docs/secrets.md), each by its file,
   * NAME, and sha256, never the value: the browser pack records them before the browser runs, so every later browser call
   * on the workspace, in any Buckle process, is masked by them while a browser may still show them.
   */
  secretFills?: readonly FilledSecret[]
  /**
   * The permission rules' verdict on reaching a URL mid-call, with this session's grants and the
   * approvals this call consumed, so a fetch honours what the owner approved without a copy of
   * the allow logic.
   */
  judgeNetwork?: (url: URL) => Promise<NetworkVerdict>
  /**
   * Handed only to a tool that declares `reachesTools` (code mode, owner decision D82): one call of another tool,
   * judged, approved, and audited as a direct call is, built by the invoker from this call and never by the tool.
   */
  invokeNested?: (call: NestedCall) => Promise<InvokeResponse>
  /**
   * Beside `invokeNested`: the key this call's nested calls are named under (`code:<key>:<id>`), a hash of the
   * session, the actor, and this call's tool and arguments, so a re-sent script names its calls as before.
   */
  nestedKey?: string
  /**
   * Beside `invokeNested`: this call's requestId, which its nested calls carry as their `parentRequestId` unless a call
   * names its own. Their stage stays this call's (final review of 0.1.4, finding invoker 701).
   */
  nestedParent?: string
  /**
   * Beside `invokeNested`: forgets the outcomes Buckle keeps for re-sends of these nested calls, once the script
   * that made them has finished, so running the same script again runs its calls again.
   */
  forgetNested?: (ids: readonly number[]) => void
  /**
   * Beside `invokeNested`: withdraws asks the script's calls left pending, through the approval service as a denied
   * sibling's are, when no call will ever spend them (review of the code-mode slice, coordinator decision 5).
   */
  withdrawNested?: (tokens: readonly string[]) => Promise<void>
  /**
   * Beside `invokeNested`: whether the outer caller itself cancelled, its own signal aborted with a reason its cancel
   * test accepts, so asks the script already collected are withdrawn too; false for a deadline, an end, or a shutdown
   * (re-review of the code-mode slice, finding new-surface index.ts:338).
   */
  callerCancelled?: () => boolean
  /** Handed by the files route alone, to the tool whose `transfer` names its kind: the bytes of one `buckle cp`. */
  file?: FileChannel
}

/**
 * The bytes of one file copy (`buckle cp`), beside a call and never in its arguments, so no byte passes through a model:
 * the request body the files route streams in (fs_receive), or the response it streams out (fs_send).
 */
export type FileChannel = IncomingFile | OutgoingFile

/** A PUT /v1/files body, which fs_receive reads as its bytes land, once the call is judged and never before. */
export interface IncomingFile {
  kind: 'receive'
  body: ReadableStream<Uint8Array> | null
}

/**
 * A GET /v1/files response, which fs_send fills from the file it opened: `send` resolves once the route has handed on
 * every chunk, and rejects where the caller left, a chunk failed, or the call's `signal` fired (its timeout, the
 * shutdown), whether or not the caller is still reading, which the route cuts the response short for.
 */
export interface OutgoingFile {
  kind: 'send'
  send(file: { size: number; sha256: string; chunks: AsyncIterable<Uint8Array>; signal: AbortSignal }): Promise<void>
}

/** One call a script makes: its number in the script, the tool, its arguments, and what cancels it. */
export interface NestedCall {
  id: number
  tool: string
  args: JsonObject
  signal?: AbortSignal
  /**
   * The code_run call to name as its parent, when not this run's: a resumed script's first run's, so its calls before
   * and after an ask name one (review of the code-mode slice, finding docs-rules code-mode.md:111; final review of
   * 0.1.4, finding invoker 701).
   */
  parentRequestId?: string
  /**
   * Told when the tool itself begins to run, past every check and approval: from then the call has run, its effects
   * unknown if it is cut (re-review of the code-mode slice, finding new-surface index.ts:302).
   */
  onExecute?: () => void
}

/**
 * `granted`: allowed by an owner's approval for that host. `allowed`: allowed with no approval
 * involved, so the caller still checks where the name resolves. `refused`: the rules deny or
 * would ask, with their reason.
 */
export type NetworkVerdict = { kind: 'granted' } | { kind: 'allowed' } | { kind: 'refused'; reason: string }

export interface ToolDefinition<TInput, TJudged = undefined> {
  /**
   * Takes the workspace's write lock itself and checkpoints its own changes: the isolated shell, whose program runs in a
   * copy of the workspace's folder. It is handed `beginRun` and `untimed`, and no stage of the decision AI rates code it
   * would read from outside that folder (judge-gate.ts, CallView fromCopy).
   */
  managesHistory?: boolean
  /**
   * Runs under the workspace's history write lock even where it declares no write, so no other call writes
   * while it runs: git_push, whose launch checks read the repository config git then reads (review H3).
   */
  exclusive?: boolean
  /**
   * Calls other tools through `ToolContext.invokeNested` (owner decision D82). Its own deadline, from `timeoutMs`,
   * ends it, and its nested calls each take the history lock they need, so it takes none itself.
   */
  reachesTools?: boolean
  /** Never called from a script: the code tools themselves (D82, point 3: no nesting of scripts). */
  outsideScripts?: boolean
  /**
   * Run by the files route alone, with the bytes of a `buckle cp` (ToolContext.file): never listed in the manifest, over
   * MCP, or to a script, and unavailable to any call that carries no file of this kind, as an unknown tool is.
   */
  transfer?: FileChannel['kind']
  /**
   * What the tool settled before any rule judged the call that its description names beside the arguments, for the
   * person who approves it (fs_send: the file's size as it stands then).
   */
  facts?: (input: TInput, judged: TJudged) => JsonObject
  /**
   * What the call's result entry keeps as it is, beside the arguments' shape, which the audit log otherwise hides: the
   * facts that say which file moved (fs_receive and fs_send: the path, credentials hidden, the bytes and the digest),
   * with the call's output where it ran. Never a file's content.
   */
  audited?: (input: TInput, output: JsonValue | undefined) => JsonObject
  /**
   * What each file the call writes holds afterwards, for the destructive-write check (the fs-verbs brief): `size`, the
   * bytes it is left with, worked out from the input alone, or from the file as it stands, which `current` hands where
   * the session may read the file without asking a person (null otherwise). A path left out is not checked.
   */
  written?: (input: TInput, current: (path: string) => Buffer | null, judged: TJudged) => WrittenFile[]
  /** The call's own time limit from its input, within the node's maximum; the request's when it names none. */
  timeoutMs?: (input: TInput) => number | undefined
  /**
   * Beside `reachesTools`: what of the input names its nested calls and their replay record, in place of the whole
   * input. code_run's is its script alone, so a re-send with another timeoutMs resumes the same script (review of
   * the code-mode slice, finding docs-rules SKILL.md:67).
   */
  replayKey?: (input: TInput) => JsonObject
  name: string
  /** Read whenever the tool is listed, so a description built from other tools follows them (code_run's). */
  description: string | (() => string)
  risk: CapabilityRisk
  tags?: string[]
  input: z.ZodType<TInput, JsonObject>
  /**
   * What the call acts on that its input does not name, settled once before any rule judges it (a push's
   * destination): its effects are declared from it and its run acts on it, so a change made while the call
   * waits for approval is refused rather than followed (GPT review of c71dee5, git destination binding).
   */
  judge?: (input: TInput) => TJudged
  effects: (input: TInput, judged: TJudged) => ToolEffect[]
  run: (input: TInput, context: ToolContext, judged: TJudged) => Promise<JsonValue>
}

/**
 * A tool with its input generic closed over, so a registry can hold tools with unrelated
 * input types without casting. Parsing happens once per call and the result is threaded
 * through effects and execution.
 */
export interface RegisteredTool {
  capability: ToolCapability
  reachesTools?: boolean
  outsideScripts?: boolean
  /** Run by the files route alone (ToolDefinition.transfer). */
  transfer?: FileChannel['kind']
  /** The authoring schema, handed to MCP so it registers the same contract the CLI parses. */
  inputSchema: z.ZodType<unknown, JsonObject>
  prepare(args: JsonObject): PreparedCall
}

export interface PreparedCall {
  managesHistory?: boolean
  exclusive?: boolean
  reachesTools?: boolean
  timeoutMs?: number
  replayKey?: JsonObject
  /** ToolDefinition.facts, settled with the effects. */
  facts?: JsonObject
  /** ToolDefinition.audited, for the call's result entry. */
  audited?: (output: JsonValue | undefined) => JsonObject
  /** ToolDefinition.written, for the destructive-write check. */
  written?: (current: (path: string) => Buffer | null) => WrittenFile[]
  effects: ToolEffect[]
  execute(context: ToolContext): Promise<JsonValue>
}

/** A file a call writes, as the agent's path names it, and the bytes it holds afterwards. */
export interface WrittenFile { path: string; size: number }

export class ToolInputError extends Error {
  readonly code: string

  /** A refusal the caller may not retry differently carries `PERMISSION_DENIED` instead. */
  constructor(message: string, options?: { code?: string }) {
    super(message)
    this.code = options?.code ?? 'INVALID_TOOL_INPUT'
  }
}

export class ToolExecutionError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(message: string, options?: { code?: string; retryable?: boolean }) {
    super(message)
    this.code = options?.code ?? 'TOOL_EXECUTION_FAILED'
    this.retryable = options?.retryable ?? false
  }
}

/**
 * Thrown by a tool that takes the workspace's write lock itself (`managesHistory`) where its wait for that lock ended
 * before its run hook (`ToolContext.beginRun`), busy past its bound or cut by a cancel or the shutdown: nothing ran, so the
 * invoker settles the call as one that never started, as it settles its own wait for the lock, and answers as `cause`
 * does (D91 follow-ups, F4 residue).
 */
export class LockWaitError extends Error {
  constructor(cause: unknown) {
    super('The wait for the workspace\'s write lock ended before the program started', { cause })
    this.name = 'LockWaitError'
  }
}

/**
 * Thrown by a tool that reaches tools when a call it made needs a person (owner decision D82, point 6): the invoker
 * answers the outer call `approval_required` with these asks, each recorded whole by the nested call that made it.
 */
export class NestedApprovalRequired extends Error {
  readonly approvals: ApprovalRequest[]

  constructor(approvals: ApprovalRequest[]) {
    super('A call the script made needs approval')
    this.approvals = approvals
  }
}

/** A script run again that makes other calls than its earlier run did, which Buckle refuses to mix (owner decision D82). */
export const CODE_REPLAY_DIVERGED = 'CODE_REPLAY_DIVERGED'

/**
 * Why a script's call still running is cancelled once its script has ended (owner decision D82): Buckle's own abort,
 * audited as SCRIPT_ENDED rather than as a failure of the tool, and never the caller's cancel, so an ask the call
 * waits on stays pending (review of the code-mode slice, finding approvals-replay 685).
 */
export class ScriptEndedError extends Error {
  readonly code = 'SCRIPT_ENDED'

  constructor() {
    super('The script that made this call ended before the call did; if it had started, its effects are unknown')
  }
}

export function defineTool<TInput, TJudged = undefined>(pack: string, definition: ToolDefinition<TInput, TJudged>): RegisteredTool {
  if (!TOOL_NAME_PATTERN.test(definition.name)) {
    throw new Error(`Tool name is not MCP-safe: ${definition.name}`)
  }

  const { description } = definition
  const capability: ToolCapability = {
    name: definition.name,
    description: typeof description === 'string' ? description : '',
    // toJSONSchema returns a plain JSON object; JsonObject is the wire type for the same shape.
    inputSchema: z.toJSONSchema(definition.input, { io: 'input' }) as JsonObject,
    risk: definition.risk,
    tags: definition.tags ?? [],
    pack,
  }
  // Enumerable, so the manifest's JSON and every spread read it as it stands at that moment.
  if (typeof description === 'function') Object.defineProperty(capability, 'description', { get: description, enumerable: true })
  return {
    capability,
    ...(definition.reachesTools ? { reachesTools: true } : {}),
    ...(definition.outsideScripts ? { outsideScripts: true } : {}),
    ...(definition.transfer ? { transfer: definition.transfer } : {}),
    inputSchema: definition.input as z.ZodType<unknown, JsonObject>,
    prepare(args) {
      const parsed = definition.input.safeParse(args)
      if (!parsed.success) throw new ToolInputError(z.prettifyError(parsed.error))
      const input = parsed.data
      const judged = (definition.judge ? definition.judge(input) : undefined) as TJudged
      return {
        managesHistory: definition.managesHistory,
        exclusive: definition.exclusive,
        ...(definition.reachesTools ? { reachesTools: true } : {}),
        ...(definition.timeoutMs ? { timeoutMs: definition.timeoutMs(input) } : {}),
        ...(definition.replayKey ? { replayKey: definition.replayKey(input) } : {}),
        ...(definition.facts ? { facts: definition.facts(input, judged) } : {}),
        ...(definition.audited ? { audited: (output: JsonValue | undefined) => definition.audited!(input, output) } : {}),
        ...(definition.written ? { written: (current: (path: string) => Buffer | null) => definition.written!(input, current, judged) } : {}),
        effects: definition.effects(input, judged),
        execute: context => definition.run(input, context, judged),
      }
    },
  }
}
