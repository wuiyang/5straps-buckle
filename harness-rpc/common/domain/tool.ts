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
  authorizeRead?: (path: string) => Promise<boolean>
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

export interface ToolDefinition<TInput> {
  managesHistory?: boolean
  name: string
  description: string
  risk: CapabilityRisk
  tags?: string[]
  input: z.ZodType<TInput, JsonObject>
  effects: (input: TInput) => ToolEffect[]
  run: (input: TInput, context: ToolContext) => Promise<JsonValue>
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

export function defineTool<TInput>(pack: string, definition: ToolDefinition<TInput>): RegisteredTool {
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
      return {
        managesHistory: definition.managesHistory,
        effects: definition.effects(input),
        execute: context => definition.run(input, context),
      }
    },
  }
}
