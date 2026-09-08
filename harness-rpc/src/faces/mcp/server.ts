import { randomUUID } from 'node:crypto'
import { acceptedContent, CLIENT_CAPABILITIES_META_KEY, inputRequired, McpServer, type ServerContext } from '@modelcontextprotocol/server'
import type { ApprovalRequest, GrantScope, InvokeResponse, JsonObject } from '@5straps/protocol'
import { logger } from '../../logger.js'
import type { BuckleRuntime } from '../../runtime.js'

interface ApprovalAnswer extends Record<string, unknown> {
  approve: boolean
  scope?: GrantScope
}

/**
 * Wraps the tool registry as an MCP server. Approvals ride MCP's own elicitation round-trip:
 * a gated call returns `inputRequired`, and the retried request carries the answers.
 */
export function createMcpServer(input: { runtime: BuckleRuntime; serverName: string; version: string; trustedApprovalResponses?: boolean }): McpServer {
  const server = new McpServer({ name: input.serverName, version: input.version })
  registerTools(server, input.runtime, input.trustedApprovalResponses === true)
  registerSkills(server, input.runtime)

  input.runtime.onToolsChanged(() => {
    registerTools(server, input.runtime, input.trustedApprovalResponses === true)
    logger.info('MCP tool list refreshed')
  })

  return server
}

function registerTools(server: McpServer, runtime: BuckleRuntime, trustedApprovalResponses: boolean): void {
  const readers = capabilityReaders(server)

  for (const name of runtime.registry().capabilities().map(capability => capability.name)) {
    const tool = runtime.registry().get(name)

    server.registerTool(
      tool.capability.name,
      {
        description: tool.capability.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.capability.risk === 'read' },
      },
      async (args, context) => {
        const responses = trustedApprovalResponses ? context.mcpReq?.inputResponses : undefined
        const approvalTokens = resolveAnswers({ runtime, responses })

        const response = await runtime.invoke({
          request: {
            requestId: randomUUID(),
            tool: tool.capability.name,
            args: args as JsonObject,
            approvalTokens,
            context: { stageId: typeof context.mcpReq?._meta?.['5straps/stageId'] === 'string' ? String(context.mcpReq._meta['5straps/stageId']).slice(0, 200) : undefined },
          },
          sessionId: mcpSessionId(context),
        })

        if (response.outcome === 'approval_required') {
          return trustedApprovalResponses && supportsElicitation(readers, context)
            ? askForApproval(response.approvals)
            : relayApproval(response.approvals)
        }
        return toCallToolResult(response)
      },
    )
  }
}

/**
 * Hosts that never declared elicitation cannot be prompted, so the approval is handed back as
 * text the agent can relay to its user. This is the fallback that makes Buckle work anywhere.
 */
function relayApproval(approvals: ApprovalRequest[]) {
  const lines = approvals.map(approval =>
    `- ${approval.reason}\n  subject: ${approval.subject}\n  approve with: buckle approve ${approval.token} --scope ${approval.offeredScopes.includes('session') ? 'session' : approval.offeredScopes[0] ?? 'once'}`,
  )
  return {
    isError: true,
    content: [{
      type: 'text' as const,
      text: [
        'This call needs approval from the person you are working with. Ask them, then run the',
        'listed command (or have them run it) and retry.',
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

function askForApproval(approvals: ApprovalRequest[]) {
  const inputRequests = Object.fromEntries(approvals.map(approval => [
    approval.token,
    inputRequired.elicit({
      message: `${approval.tool}: ${approval.reason}\nSubject: ${approval.subject}`,
      requestedSchema: {
        type: 'object',
        properties: {
          approve: { type: 'boolean', description: 'Allow this operation' },
          scope: {
            type: 'string',
            enum: approval.offeredScopes,
            description: 'once, this session, or always for this subject',
          },
        },
        required: ['approve'],
      },
    }),
  ]))
  return inputRequired({ inputRequests })
}

/** Reads elicitation answers keyed by approval token and turns each into a grant. */
function resolveAnswers(input: {
  runtime: BuckleRuntime
  responses: Record<string, unknown> | undefined
}): string[] {
  if (!input.responses) return []

  const tokens: string[] = []
  for (const token of Object.keys(input.responses)) {
    const answer = acceptedContent<ApprovalAnswer>(input.responses, token)
    if (!answer) continue

    const result = input.runtime.approvals.resolve({
      token,
      approved: answer.approve === true,
      scope: answer.scope ?? 'once',
    })
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
