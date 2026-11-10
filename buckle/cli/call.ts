import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import type { InvokeResponse } from '@5straps/protocol'
import { describeApprovalRequest } from '../common/domain/approval-instruction.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { buildToolArgs, commandToToolName, parseArgsOptions } from './arguments.js'
import { APPROVAL_REQUIRED_EXIT } from './exit-codes.js'
import type { CliResult } from './result.js'
import { fail, print } from './output.js'

export async function callByName(runtime: BuckleRuntime, argv: string[]): Promise<CliResult> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: { json: { type: 'string' } },
    allowPositionals: true,
  })
  const toolName = positionals[0]
  if (!toolName) return fail("Usage: buckle call <tool> --json '{...}'")
  if (!runtime.registry().has(toolName)) return fail(`Unknown tool: ${toolName}`)

  return invoke(runtime, toolName, JSON.parse(values.json ?? '{}'))
}

export async function callByCommand(runtime: BuckleRuntime, group: string, argv: string[]): Promise<CliResult> {
  const [verb, ...rest] = argv
  const toolName = commandToToolName(group, verb ?? '')
  if (!runtime.registry().has(toolName)) return fail(`Unknown command: ${group} ${verb ?? ''}`.trim())

  const capability = runtime.registry().get(toolName).capability
  const { positionals, values } = parseArgs({
    args: rest,
    options: parseArgsOptions(capability),
    allowPositionals: true,
  })
  return invoke(runtime, toolName, buildToolArgs({
    capability,
    positionals,
    flags: values as Record<string, string | boolean | string[]>,
  }))
}

/** Stable across invocations: each CLI run is its own process, so a per-pid id would make
 * every 'session' grant single-use. `buckle grants revoke` ends it. */
const CLI_SESSION_ID = 'cli'

async function invoke(runtime: BuckleRuntime, tool: string, args: unknown): Promise<CliResult> {
  const response = await runtime.invoke({
    request: { requestId: randomUUID(), tool, args: args as Record<string, never>, approvalTokens: [], context: { stageId: process.env.BUCKLE_STAGE_ID } },
    sessionId: CLI_SESSION_ID,
  })
  return reportResponse({ response, workspaceId: runtime.workspaceId, workspaceName: runtime.workspaceName() })
}

function reportResponse(input: { response: InvokeResponse; workspaceId: string; workspaceName: string }): CliResult {
  const { response } = input
  if (response.outcome === 'ok') {
    const history = response.meta.history
    if (history) process.stderr.write(`History warning: checkpoint ${history.checkpoint} may not be fully restorable${history.reason ? `: ${history.reason}` : '.'}\n`)
    return print(response.output)
  }

  if (response.outcome === 'approval_required') {
    // Leads with buckle approvals, which shows the whole action, and names buckle approve after it (owner decision D17).
    for (const approval of response.approvals) {
      const [first, ...rest] = describeApprovalRequest({ request: approval, workspaceId: input.workspaceId, workspaceName: input.workspaceName })
      process.stderr.write(`Approval required: ${first}\n${rest.map(line => `  ${line}\n`).join('')}`)
    }
    return { exitCode: APPROVAL_REQUIRED_EXIT }
  }

  process.stderr.write(`${response.error.code}: ${response.error.message}\n`)
  return { exitCode: 1 }
}
