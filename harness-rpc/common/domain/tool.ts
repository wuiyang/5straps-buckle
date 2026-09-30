import { z } from 'zod'
import type { CapabilityRisk, JsonObject, JsonValue, ToolCapability } from '@5straps/protocol'
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
  name: string
  description: string
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
  /** The authoring schema, handed to MCP so it registers the same contract the CLI parses. */
  inputSchema: z.ZodType<unknown, JsonObject>
  prepare(args: JsonObject): PreparedCall
}

export interface PreparedCall {
  managesHistory?: boolean
  exclusive?: boolean
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

export function defineTool<TInput, TJudged = undefined>(pack: string, definition: ToolDefinition<TInput, TJudged>): RegisteredTool {
  if (!TOOL_NAME_PATTERN.test(definition.name)) {
    throw new Error(`Tool name is not MCP-safe: ${definition.name}`)
  }

  return {
    capability: {
      name: definition.name,
      description: definition.description,
      // toJSONSchema returns a plain JSON object; JsonObject is the wire type for the same shape.
      inputSchema: z.toJSONSchema(definition.input, { io: 'input' }) as JsonObject,
      risk: definition.risk,
      tags: definition.tags ?? [],
      pack,
    },
    inputSchema: definition.input as z.ZodType<unknown, JsonObject>,
    prepare(args) {
      const parsed = definition.input.safeParse(args)
      if (!parsed.success) throw new ToolInputError(z.prettifyError(parsed.error))
      const input = parsed.data
      const judged = (definition.judge ? definition.judge(input) : undefined) as TJudged
      return {
        managesHistory: definition.managesHistory,
        exclusive: definition.exclusive,
        effects: definition.effects(input, judged),
        execute: context => definition.run(input, context, judged),
      }
    },
  }
}
