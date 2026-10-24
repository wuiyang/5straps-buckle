import { randomUUID } from 'node:crypto'
import { acceptedContent, CLIENT_CAPABILITIES_META_KEY, inputRequired, McpServer, type ServerContext } from '@modelcontextprotocol/server'
import type { ApprovalRequest, GrantScope, InvokeResponse, JsonObject } from '@5straps/protocol'
import { describeApprovalRequest, describeAsk, describeAskOfShownCall, describeCallAsks, reviewCommand } from '../common/domain/approval-instruction.js'
import { logger, withoutCause } from '../common/runtime/log.js'
import { agentFailureMessage } from '../common/services/agent-failure.js'
import type { ApprovalAuthority, PendingAsk } from '../common/services/approvals/approval-registry.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'

interface ApprovalAnswer extends Record<string, unknown> {
  approve?: boolean
  action?: 'allow_once' | 'deny' | 'deny_session' | 'always_deny'
  scope?: GrantScope
}

/** Runs one tool call in an operation of its own; over HTTP the request's operation is already open. */
export type ToolCallScope = <T>(run: () => Promise<T>, context: { sessionId: string }) => Promise<T>

export interface McpServerOptions {
  runtime: BuckleRuntime
  serverName: string
  /** The node's serverId, which an elicited action names as the node's terminal names it. */
  serverId?: string
  version: string
  trustedApprovalResponses?: boolean
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
  const { runtime, serverName } = options
  const trustedApprovalResponses = options.trustedApprovalResponses === true
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
          const responses = trustedApprovalResponses ? context.mcpReq?.inputResponses : undefined
          const approvalTokens = await resolveAnswers({ runtime, responses, authority: trustedApprovalResponses ? 'admin' : 'agent' })
          // The host asks its user itself, so the call reports back at once instead of waiting.
          const elicits = trustedApprovalResponses && supportsElicitation(readers, context)

          const response = await runtime.invoke({
            request: {
              requestId: randomUUID(),
              tool: tool.capability.name,
              args: args as JsonObject,
              approvalTokens,
              context: { stageId: typeof context.mcpReq?._meta?.['5straps/stageId'] === 'string' ? String(context.mcpReq._meta['5straps/stageId']).slice(0, 200) : undefined },
            },
            sessionId: mcpSessionId(context),
            signal: context.mcpReq.signal,
            ...(options.isCancel ? { isCancel: options.isCancel } : {}),
            ...(elicits ? { approvalWait: { mode: 'none' as const } } : {}),
          })

          if (response.outcome === 'approval_required') {
            return elicits
              ? askForApproval({ approvals: response.approvals, waiting: runtime.approvalService.waiting(), workspaceId: runtime.workspaceId, workspaceName: runtime.workspaceName(), approves: runtime.judgeApproves(), ...(options.serverId === undefined ? {} : { node: options.serverId }) })
              : relayApproval({ approvals: response.approvals, workspaceId: runtime.workspaceId, workspaceName: runtime.workspaceName(), ...(options.serverId === undefined ? {} : { nodeName: options.serverId }) })
          }
          return toCallToolResult(response)
        } catch (error) {
          return failedCall(error)
        }
      }, { sessionId: mcpSessionId(context) }),
    ))
  }
  return registrations
}

/**
 * Hosts that never declared elicitation cannot be prompted, so the approval is handed back as
 * text the agent can relay to its user. This is the fallback that makes Buckle work anywhere,
 * which is why it names the node and the workspace: the person may hold several, and the command
 * only answers the workspace it names.
 */
function relayApproval(input: { approvals: ApprovalRequest[]; workspaceId: string; workspaceName: string; nodeName?: string }) {
  const lines = input.approvals.map(request => {
    const [first, ...rest] = describeApprovalRequest({ request, workspaceId: input.workspaceId, workspaceName: input.workspaceName, ...(input.nodeName === undefined ? {} : { nodeName: input.nodeName }) })
    return [`- ${first}`, ...rest.map(line => `  ${line}`)].join('\n')
  })
  const review = reviewCommand({ workspaceId: input.workspaceId, workspaceName: input.workspaceName })
  return {
    isError: true,
    content: [{
      type: 'text' as const,
      text: [
        `This call needs approval from the person you are working with. Ask them to read the whole action in \`${review}\``,
        `or answer it in \`${review} --watch\`; the listed approve command shows the action again and asks them to confirm. Then retry.`,
        '',
        ...lines,
      ].join('\n'),
    }],
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

/**
 * One form per ask, whose message is the whole action as the node's terminal shows it (owner decision D17):
 * the ask, then every argument, the directory, the effects and the node's summary from the call the ask
 * recorded. An ask recorded before this build has no whole call: its form says so and offers denials only.
 * A call that made several asks is shown whole once, in the form of its first ask, which lists the others;
 * each other form names that ask (review M1 of the slice 5 re-review).
 */
function askForApproval(input: { approvals: ApprovalRequest[]; waiting: PendingAsk[]; workspaceId: string; workspaceName: string; approves: boolean; node?: string }) {
  const refOf = new Map(input.waiting.map(ask => [ask.request.token, ask.callRef]))
  const group = (ref: string | undefined) => ref === undefined ? [] : input.approvals.filter(approval => refOf.get(approval.token) === ref)
  const shownWith = new Map<string, string>()
  const inputRequests = Object.fromEntries(input.approvals.map((approval) => {
    const call = recordedCall(input.waiting, approval.token)
    const ref = refOf.get(approval.token)
    const shown = { ...approval, workspaceId: input.workspaceId, workspaceName: input.workspaceName, approves: input.approves, ...(input.node === undefined ? {} : { node: input.node }), ...(call ? { call } : {}) }
    const earlier = ref === undefined ? undefined : shownWith.get(ref)
    if (call && ref !== undefined && earlier === undefined) shownWith.set(ref, approval.token)
    const asks = group(ref)
    const lines = !call ? describeAsk(shown) : earlier !== undefined ? describeAskOfShownCall(shown, earlier) : [...describeAsk(shown), ...(asks.length > 1 ? describeCallAsks(asks) : [])]
    const message = lines.join('\n')
    return [approval.token, call ? approvalForm({ approval, message }) : denialForm({ approval, message })]
  }))
  return inputRequired({ inputRequests })
}

/** The whole call an ask recorded, or undefined for one recorded before this build. */
function recordedCall(waiting: PendingAsk[], token: string): NonNullable<PendingAsk['call']> | undefined {
  const call = waiting.find(ask => ask.request.token === token)?.call
  return call?.complete ? call : undefined
}

function approvalForm(input: { approval: ApprovalRequest; message: string }) {
  const { approval } = input
  return inputRequired.elicit({
    message: input.message,
    requestedSchema: {
      type: 'object',
      properties: approval.rule === 'sensitive_path' ? {
        action: { type: 'string', enum: ['allow_once', 'deny', 'deny_session', 'always_deny'], description: 'Allow once, Deny, Deny this session, Always deny' },
      } : {
        approve: { type: 'boolean', description: 'Allow this operation' },
        scope: {
          type: 'string',
          enum: approval.offeredScopes,
          description: 'once, this session, or always for this subject',
        },
      },
      required: [approval.rule === 'sensitive_path' ? 'action' : 'approve'],
    },
  })
}

/** An ask nobody was shown whole: it may be denied here, never approved. */
function denialForm(input: { approval: ApprovalRequest; message: string }) {
  const sensitive = input.approval.rule === 'sensitive_path'
  return inputRequired.elicit({
    message: input.message,
    requestedSchema: {
      type: 'object',
      properties: {
        action: sensitive
          ? { type: 'string', enum: ['deny', 'deny_session', 'always_deny'], description: 'Deny, Deny this session, Always deny' }
          : { type: 'string', enum: ['deny'], description: 'Deny' },
      },
      required: ['action'],
    },
  })
}

/** Reads elicitation answers keyed by approval token and turns each into a grant. */
async function resolveAnswers(input: {
  runtime: BuckleRuntime
  responses: Record<string, unknown> | undefined
  authority: ApprovalAuthority
}): Promise<string[]> {
  if (!input.responses) return []

  const waiting = input.runtime.approvalService.waiting()
  const tokens: string[] = []
  for (const token of Object.keys(input.responses)) {
    const answer = acceptedContent<ApprovalAnswer>(input.responses, token)
    if (!answer) continue

    const approved = answer.action ? answer.action === 'allow_once' : answer.approve === true
    // Owner decision D17: an ask whose whole call was never kept was never shown whole, so no answer approves it.
    if (approved && waiting.some(ask => ask.request.token === token) && !recordedCall(waiting, token)) {
      logger.warn('Elicited approval refused: the ask was recorded before this build, so its whole action was never shown')
      continue
    }
    // Ruling 3 of 2026-09-25: an answer from the owner's own stdio host counts as a person's.
    const result = await input.runtime.approvalService.answer({ decision: {
      token,
      approved,
      scope: answer.action === 'deny_session' ? 'session' : answer.action === 'always_deny' ? 'always' : answer.action ? 'once' : answer.scope ?? 'once',
    }, authority: input.authority })
    if (result.ok) tokens.push(token)
    else logger.warn('Elicited approval was rejected', { reason: result.reason })
  }
  return tokens
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

function toCallToolResult(response: Extract<InvokeResponse, { outcome: 'ok' | 'error' }>) {
  if (response.outcome === 'error') {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `${response.error.code}: ${response.error.message}` }],
    }
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(response.output, null, 2) }] }
}

function mcpSessionId(context: { sessionId?: string }): string {
  return context.sessionId ?? 'mcp'
}
