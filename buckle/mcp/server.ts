import { randomUUID } from 'node:crypto'
import { CLIENT_CAPABILITIES_META_KEY, McpServer, type ServerContext } from '@modelcontextprotocol/server'
import { useScopeSafe } from '@5straps/runtime'
import type { ApprovalWait, InvokeResponse, JsonObject } from '@5straps/protocol'
import { describeApprovalRequest, reviewCommand } from '../common/domain/approval-instruction.js'
import { logger, withoutCause } from '../common/runtime/log.js'
import { agentFailureMessage } from '../common/services/agent-failure.js'
import { shorterWait } from '../common/services/approvals/approval-service.js'
import { REQUEST_SUPERSEDED } from '../common/services/invocation/invoker.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { AnswerSender } from '../common/types/ports/approval-backend.js'
import type { FormsBackend } from './forms-backend.js'
import { MCP_HOLD_MS } from './holds.js'
import { createResendJoin, sameCallKey, type ResendJoin } from './resend-join.js'

/** Runs one tool call in an operation of its own; over HTTP the request's operation is already open. */
export type ToolCallScope = <T>(run: () => Promise<T>, context: { sessionId: string }) => Promise<T>

export interface McpServerOptions {
  runtime: BuckleRuntime
  serverName: string
  /** The node's serverId, which an elicited action names as the node's terminal names it. */
  serverId?: string
  version: string
  /**
   * A stdio host's forms, through which its answers decide as the forms source while the workspace's forms setting is on,
   * read at each call. Absent over HTTP, where a call's `inputResponses` are never read, so nothing the agent's token
   * reaches answers an ask.
   */
  forms?: FormsBackend
  callScope?: ToolCallScope
  /**
   * Re-register the tools when the runtime's tool list changes. A long-lived server (stdio) does; a
   * server the HTTP handler builds for one request does not, or every request would leave a listener
   * on the runtime for good.
   */
  followToolChanges?: boolean
  /**
   * Whether a tool call's abort is the client's explicit cancel, which withdraws the call's asks.
   * Without it every abort is a dropped transport and the asks stay pending (owner decision D4).
   */
  isCancel?: (reason: unknown) => boolean
  /**
   * Runs before each tool call, and a throw is that call's failure. A stdio server serves one runtime for its whole
   * life, so it asks the registry here whether the workspace is still the one it was started for.
   */
  beforeCall?: () => Promise<void>
  /**
   * The face's own wait for a person, read at each call (the MCP asks brief, item 1): over HTTP the workspace's, at most
   * MCP_HOLD_MS; over stdio the workspace's. A caller's `5straps/approvalWait` only shortens it.
   */
  approvalWait?: () => ApprovalWait | undefined
}

/**
 * Wraps the tool registry as an MCP server. Approvals ride MCP's own elicitation round-trip:
 * a gated call returns `inputRequired`, and the retried request carries the answers.
 */
export function createMcpServer(input: McpServerOptions): McpServer {
  const server = new McpServer({ name: input.serverName, version: input.version })
  let registrations = registerTools(server, input)
  registerSkills(server, input.runtime)

  if (input.followToolChanges !== false) {
    input.runtime.onToolsChanged(() => {
      for (const registration of registrations) registration.remove()
      registrations = registerTools(server, input)
      logger.info('MCP tool list refreshed')
    })
  }

  return server
}

function registerTools(server: McpServer, options: McpServerOptions): Array<ReturnType<McpServer['registerTool']>> {
  const { runtime, serverName, forms } = options
  const inScope = options.callScope ?? (run => run())
  const readers = capabilityReaders(server)
  const registrations: Array<ReturnType<McpServer['registerTool']>> = []

  for (const name of runtime.manifest().tools.map(capability => capability.name)) {
    const tool = runtime.registry().get(name)

    registrations.push(server.registerTool(
      tool.capability.name,
      {
        description: tool.capability.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.capability.risk === 'read' },
      },
      async (args, context) => inScope(async () => {
        try {
          await options.beforeCall?.()
          const hints = callHints(context.mcpReq?._meta)
          if ('refused' in hints) return refusedHint(hints.refused)
          // Off, the call gets the relay text and the answers it carries are not read.
          const opened = forms !== undefined && runtime.approvalForms() ? forms : undefined
          const approvalTokens = opened ? await opened.answer(context.mcpReq?.inputResponses, transportSender()) : []
          // The host asks its user itself, so the call reports back at once instead of waiting.
          const elicits = opened !== undefined && supportsElicitation(readers, context) ? opened : undefined
          const wait = elicits ? { mode: 'none' as const } : shorterWait(options.approvalWait?.(), hints.approvalWait)

          const { response, replay } = await invokeJoined({
            runtime, joins: joinsOf(runtime), tool: tool.capability.name, args: args as JsonObject, hints, approvalTokens, sessionId: mcpSessionId(context), signal: context.mcpReq?.signal,
            ...(options.isCancel ? { isCancel: options.isCancel } : {}), ...(wait ? { wait } : {}),
          })

          if (response.outcome === 'approval_required') {
            return elicits
              ? elicits.forms(response.approvals)
              : relayApproval({ response, workspaceId: runtime.workspaceId, workspaceName: runtime.workspaceName(), ...(options.serverId === undefined ? {} : { nodeName: options.serverId }) })
          }
          return toCallToolResult(response, replay)
        } catch (error) {
          return failedCall(error)
        }
      }, { sessionId: mcpSessionId(context) }),
    ))
  }
  return registrations
}

/** The MCP calls each runtime remembers for a re-send, kept as long as the runtime: an HTTP server lives for one request. */
const joins = new WeakMap<BuckleRuntime, ResendJoin>()

function joinsOf(runtime: BuckleRuntime): ResendJoin {
  const existing = joins.get(runtime)
  if (existing) return existing
  const created = createResendJoin()
  joins.set(runtime, created)
  return created
}

/**
 * One call through the invoker under the requestId a re-send joins by (the MCP asks brief, items 2 and 3): the client's
 * own `5straps/requestId`, else the one an identical call that asked was given, else a new one. A call that asks is
 * remembered under sameCallKey. It is forgotten once a call under that key answered its outcome to a client still there
 * within MCP_HOLD_MS, inside any client's own timeout; it is kept where the answer was approval_required, the client
 * left, a newer call carried the wait on, or the outcome came later than that, as a client may have stopped reading.
 * `replay` is set where the invoker answered with an earlier run's outcome instead of running the call.
 */
async function invokeJoined(input: {
  runtime: BuckleRuntime
  joins: ResendJoin
  tool: string
  args: JsonObject
  hints: CallHints
  approvalTokens: string[]
  sessionId: string
  signal?: AbortSignal
  isCancel?: (reason: unknown) => boolean
  wait?: ApprovalWait
}): Promise<{ response: InvokeResponse; replay?: Replay }> {
  const { hints } = input
  const key = sameCallKey({ sessionId: input.sessionId, actor: useScopeSafe()?.context.actor, tool: input.tool, args: input.args })
  const remembered = hints.requestId === undefined ? input.joins.requestIdOf(key) : undefined
  const requestId = hints.requestId ?? remembered ?? randomUUID()
  const arrived = performance.now()
  let asked = false
  let replay: Replay | undefined
  const response = await input.runtime.invoke({
    request: { requestId, tool: input.tool, args: input.args, approvalTokens: input.approvalTokens, context: { ...(hints.stageId === undefined ? {} : { stageId: hints.stageId }) } },
    sessionId: input.sessionId,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.isCancel ? { isCancel: input.isCancel } : {}),
    ...(input.wait ? { approvalWait: input.wait } : {}),
    onReplayed: (earlier) => { replay = earlier },
    // An agent sends an undecided call again, so an ask it leaves may lapse (ApprovalRequestInput.resends).
    resends: true,
    // A client that names its own requestId joins by it, and nothing is remembered for it.
    ...(hints.requestId === undefined ? { onAsked: () => { asked = true; input.joins.remember(key, requestId) } } : {}),
  })
  const answered = { response, ...(replay ? { replay } : {}) }
  if (hints.requestId !== undefined || (!asked && remembered === undefined && response.outcome !== 'approval_required')) return answered
  if (delivered({ response, arrived, ...(input.signal ? { signal: input.signal } : {}) })) input.joins.forget(key)
  else input.joins.remember(key, requestId)
  return answered
}

/** An answer that came from an earlier run of the same call, and when that run ended (absent while it ran). */
type Replay = { at?: number }

/** Whether a call's final outcome reached a client still there: its connection open, and within the hold cap. */
function delivered(input: { response: InvokeResponse; arrived: number; signal?: AbortSignal }): boolean {
  const { response } = input
  if (response.outcome === 'approval_required' || (response.outcome === 'error' && response.error.code === REQUEST_SUPERSEDED)) return false
  return input.signal?.aborted !== true && performance.now() - input.arrived < MCP_HOLD_MS
}

const STAGE_HINT = '5straps/stageId'
const WAIT_HINT = '5straps/approvalWait'
const REQUEST_HINT = '5straps/requestId'
const MAX_WAIT_MS = 2_147_483_647
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What a call's `_meta` asks of it (the MCP asks brief, item 3): its stage, a shorter wait, and the requestId it joins by. */
interface CallHints {
  stageId?: string
  approvalWait?: ApprovalWait
  requestId?: string
}

/**
 * Reads a call's hints. `5straps/approvalWait` is milliseconds, 0 for none; it shortens the face's own hold and never
 * lengthens it. `5straps/requestId` is a UUID the client chooses, sent again to join the call's ask exactly. A hint that
 * reads otherwise refuses the call, naming it; a stage that is not text is ignored, as before.
 */
function callHints(meta: Record<string, unknown> | undefined): CallHints | { refused: string } {
  const stage = meta?.[STAGE_HINT]
  const wait = meta?.[WAIT_HINT]
  const requestId = meta?.[REQUEST_HINT]
  if (wait !== undefined && !(typeof wait === 'number' && Number.isSafeInteger(wait) && wait >= 0 && wait <= MAX_WAIT_MS)) {
    return { refused: `${WAIT_HINT} takes a whole number of milliseconds from 0 to ${MAX_WAIT_MS}, 0 to answer at once; nothing was asked or run` }
  }
  if (requestId !== undefined && !(typeof requestId === 'string' && UUID.test(requestId))) {
    return { refused: `${REQUEST_HINT} takes a UUID such as crypto.randomUUID() makes, sent again to join the call's ask; nothing was asked or run` }
  }
  return {
    ...(typeof stage === 'string' ? { stageId: stage.slice(0, 200) } : {}),
    ...(typeof wait === 'number' ? { approvalWait: wait === 0 ? { mode: 'none' as const } : { mode: 'finite' as const, ms: wait } } : {}),
    ...(typeof requestId === 'string' ? { requestId } : {}),
  }
}

function refusedHint(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: `INVALID_HINT: ${message}` }] }
}

/**
 * Hosts that never declared elicitation cannot be prompted, so the approval is handed back as
 * text the agent can relay to its user. This is the fallback that makes Buckle work anywhere,
 * which is why it names the node and the workspace: the person may hold several, and the command
 * only answers the workspace it names. It is no error (the MCP asks brief, item 1): the call is
 * waiting, and the same call sent again once it is decided joins its ask. The structured content
 * is /v1/invoke's own approval_required answer, which Rings reads.
 */
function relayApproval(input: { response: Extract<InvokeResponse, { outcome: 'approval_required' }>; workspaceId: string; workspaceName: string; nodeName?: string }) {
  const lines = input.response.approvals.map(request => {
    const [first, ...rest] = describeApprovalRequest({ request, workspaceId: input.workspaceId, workspaceName: input.workspaceName, ...(input.nodeName === undefined ? {} : { nodeName: input.nodeName }) })
    return [`- ${first}`, ...rest.map(line => `  ${line}`)].join('\n')
  })
  const review = reviewCommand({ workspaceId: input.workspaceId, workspaceName: input.workspaceName })
  const { requestId, outcome, approvals } = input.response
  return {
    isError: false,
    content: [{
      type: 'text' as const,
      text: [
        `This call needs approval from the person you are working with. Ask them to read the whole action in \`${review}\``,
        `or answer it in \`${review} --watch\`; the listed approve command shows the action again and asks them to confirm.`,
        'Once it is decided, send this same call again: it joins this ask, and runs once if it was approved.',
        '',
        ...lines,
      ].join('\n'),
    }],
    structuredContent: { outcome, requestId, approvals },
  }
}

/**
 * Reads whatever the connected client declared. Where that lives depends on the protocol
 * revision it speaks, so there is one reader per place a declaration can appear rather than a
 * revision test: revision 2026-07-28 repeats the capabilities in every request envelope, while a
 * 2025 era connection states them once in its `initialize` handshake. A connection fills exactly
 * one of the two, so the first reader with an answer is the answer.
 */
type CapabilityReader = (context: ServerContext) => unknown

function capabilityReaders(server: McpServer): CapabilityReader[] {
  return [
    // The envelope narrows through isRecord because the SDK ships its key set as an empty type.
    context => isRecord(context.mcpReq.envelope) ? context.mcpReq.envelope[CLIENT_CAPABILITIES_META_KEY] : undefined,
    // Deprecated in favour of the envelope, and still the only answer a 2025 era client gives.
    () => server.server.getClientCapabilities(),
  ]
}

function supportsElicitation(readers: CapabilityReader[], context: ServerContext): boolean {
  return readers.some(read => acceptsFormElicitation(read(context)))
}

/**
 * A bare `elicitation` declaration means form support, which is how the SDK itself reads it. A
 * client that declared URL mode alone cannot answer an approval form, so it keeps the relay text
 * rather than drawing a refusal from the SDK's own capability gate.
 */
function acceptsFormElicitation(capabilities: unknown): boolean {
  const elicitation = isRecord(capabilities) ? capabilities['elicitation'] : undefined
  return isRecord(elicitation) && ('form' in elicitation || !('url' in elicitation))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function registerSkills(server: McpServer, runtime: BuckleRuntime): void {
  for (const skill of runtime.skills()) {
    server.registerResource(
      skill.name,
      `buckle://skills/${skill.id}`,
      { description: skill.description, mimeType: 'text/markdown' },
      async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: skill.content }] }),
    )
  }
}

/**
 * A failure that escaped the invoker, such as an audit or approval write that could not be made: the
 * SDK would hand its message to the agent, so the agent gets path-free text and the owner's log the
 * failure's name, own message and stack (review M1 of B15-B17), never a cause that quotes a state file (slice 7 review
 * R7-RR-3).
 */
function failedCall(error: unknown) {
  logger.error('MCP tool call failed before it had an outcome', { error: withoutCause(error) })
  return { isError: true, content: [{ type: 'text' as const, text: agentFailureMessage(error) }] }
}

/** The `_meta` key that marks an answer replayed from an earlier run (review of the MCP asks slice, finding M1). */
const REPLAYED_META = '5straps/replayed'

/**
 * A replayed answer says so first, in words and in `_meta`: the client may have read this run's outcome already, and
 * an agent that sends an identical call to run it again (a test after an edit) must not take the old output for a new one.
 * The face forgets the call once the replay is delivered, so the next identical call runs.
 */
function replayNotice(replay: Replay): string {
  const when = replay.at === undefined ? '' : ` (at ${new Date(replay.at).toISOString()})`
  return `Replayed: this call already ran${when} for its approval and was not run again, so this is that run's answer. To run it anew, send the call again.`
}

function toCallToolResult(response: Extract<InvokeResponse, { outcome: 'ok' | 'error' }>, replay?: Replay) {
  const text = response.outcome === 'error' ? `${response.error.code}: ${response.error.message}` : JSON.stringify(response.output, null, 2)
  const history = response.outcome === 'ok' ? response.meta.history : undefined
  return {
    ...(response.outcome === 'error' ? { isError: true } : {}),
    content: [{ type: 'text' as const, text: replay ? `${replayNotice(replay)}\n\n${text}` : text }, ...(history ? [{ type: 'text' as const, text: `History warning: checkpoint ${history.checkpoint} may not be fully restorable${history.reason ? `: ${history.reason}` : '.'}` }] : [])],
    ...(replay || history ? { _meta: { ...(replay ? { [REPLAYED_META]: true } : {}), ...(history ? { '5straps/history': history } : {}) } } : {}),
  }
}

// The actor the transport authenticated for this request: the agent token's over HTTP, the host's over stdio.
function transportSender(): AnswerSender | undefined {
  const caller = useScopeSafe()?.context.actor
  return caller === undefined ? undefined : { caller }
}

function mcpSessionId(context: { sessionId?: string }): string {
  return context.sessionId ?? 'mcp'
}
