import { z } from 'zod'
import type { ApprovalRequest, CapabilityRisk, InvokeResponse, JsonObject, JsonValue, ToolCapability } from '@5straps/protocol'
import { TOOL_NAME_PATTERN } from '@5straps/protocol'
import type { ToolEffect } from './effect.js'

export interface ToolContext {
  requestId: string
  sessionId: string
  stageId?: string
  timeoutMs: number
  signal: AbortSignal
  /**
   * Whether the rules allow reading an absolute host path the tool reached mid-call (a listed child
   * beneath its judged directory, a searched file), judged where it lands now; never an agent's name.
   */
  authorizeRead?: (path: string) => Promise<boolean>
  /** Whether a real path is one the call's permission check judged as a read; a reader refuses any other. */
  authorizeReadTarget?: (target: string) => boolean
  /** Whether a real path is one the call's permission check judged as a write; a writer refuses any other. */
  authorizeWrite?: (target: string) => boolean
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
   * Beside `invokeNested`: forgets the outcomes Buckle keeps for re-sends of these nested calls, once the script
   * that made them has finished, so running the same script again runs its calls again.
   */
  forgetNested?: (ids: readonly number[]) => void
}

/** One call a script makes: its number in the script, the tool, its arguments, and what cancels it. */
export interface NestedCall {
  id: number
  tool: string
  args: JsonObject
  signal?: AbortSignal
}

/**
 * `granted`: allowed by an owner's approval for that host. `allowed`: allowed with no approval
 * involved, so the caller still checks where the name resolves. `refused`: the rules deny or
 * would ask, with their reason.
 */
export type NetworkVerdict = { kind: 'granted' } | { kind: 'allowed' } | { kind: 'refused'; reason: string }

export interface ToolDefinition<TInput, TJudged = undefined> {
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
  /** The call's own time limit from its input, within the node's maximum; the request's when it names none. */
  timeoutMs?: (input: TInput) => number | undefined
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
  /** The authoring schema, handed to MCP so it registers the same contract the CLI parses. */
  inputSchema: z.ZodType<unknown, JsonObject>
  prepare(args: JsonObject): PreparedCall
}

export interface PreparedCall {
  managesHistory?: boolean
  exclusive?: boolean
  reachesTools?: boolean
  timeoutMs?: number
  effects: ToolEffect[]
  execute(context: ToolContext): Promise<JsonValue>
}

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
        effects: definition.effects(input, judged),
        execute: context => definition.run(input, context, judged),
      }
    },
  }
}
