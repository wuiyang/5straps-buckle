import { auditOperation } from '../../services/audit-operation.js'
import { createFileActionLog } from '../../adapters/action-log/file-action-log.js'
import { actionsPath } from '../../config.js'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import type { GrantScope, InvokeResponse } from '@5straps/protocol'
import { GrantScopeSchema } from '@5straps/protocol'
import type { BuckleConfig } from '../../config.js'
import { createRuntime, type BuckleRuntime } from '../../runtime.js'
import { createCliApprovalChannel } from '../../adapters/approval/cli-approval-channel.js'
import { buildToolArgs, commandToToolName, parseArgsOptions, toolNameToCommand } from './arguments.js'
import { policyCommand, policyMigrateCommand } from './policy.js'
import { workspaceRegistryCommand } from './workspace.js'
import { BUCKLE_VERSION } from '../../version.js'

export interface CliResult {
  exitCode: number
}

export async function runCli(input: { argv: string[]; config: BuckleConfig }): Promise<CliResult> {
  const [command, ...rest] = input.argv
  if (!command || command === 'help' || command === '--help' || command === '-h') return printUsage()
  if (command === '--version' || command === '-v') return printVersion()
  // Before the runtime, because a stored pattern the runtime refuses to compile is what sends
  // the owner here in the first place.
  if (command === 'policy' && rest[0] === 'migrate') return auditOperation({ actions: createFileActionLog(actionsPath(input.config)), workspaceId: 'default', tool: 'cli_policy_migrate', sessionId: 'local-owner', isSuccessful: result => result.exitCode === 0, operation: () => policyMigrateCommand({ config: input.config, argv: rest.slice(1) }) })

  const runtime = await createRuntime({ config: input.config, channel: () => createCliApprovalChannel() })

  if (['approve', 'grants', 'workspace', 'workspaces', 'history', 'plugin', 'policy'].includes(command)) {
    return auditOperation({ actions: runtime.actions, workspaceId: runtime.workspaceId, tool: `cli_${command}`, sessionId: 'local-owner', isSuccessful: result => result.exitCode === 0,
      operation: () => dispatchRuntimeCommand({ runtime, config: input.config, command, rest }),
    })
  }
  return dispatchRuntimeCommand({ runtime, config: input.config, command, rest })
}

function dispatchRuntimeCommand(input: { runtime: BuckleRuntime; config: BuckleConfig; command: string; rest: string[] }): CliResult | Promise<CliResult> {
  const { runtime, command, rest } = input
  if (command === 'tools') return printTools(runtime)
  if (command === 'manifest') return print(runtime.manifest())
  if (command === 'skills') return printSkills(runtime, rest)
  if (command === 'approve') return approve(runtime, rest)
  if (command === 'grants') return grants(runtime, rest)
  if (command === 'workspace') return workspaceRegistryCommand({ config: input.config, runtime, argv: rest })
  if (command === 'workspaces') return shellWorkspacesCommand(runtime, rest)
  if (command === 'history') return historyCommand(runtime, rest)
  if (command === 'log') return printLog(runtime, rest)
  if (command === 'plugin') return plugin(runtime, rest)
  if (command === 'policy') return policyCommand(runtime, rest)
  if (command === 'call') return callByName(runtime, rest)
  return callByCommand(runtime, command, rest)
}

function printVersion(): CliResult {
  process.stdout.write(`${BUCKLE_VERSION}\n`)
  return { exitCode: 0 }
}

function printUsage(): CliResult {
  process.stdout.write(`buckle ${BUCKLE_VERSION}, the 5straps execution node

  buckle init                        Write an environment file for a workspace, with fresh tokens
  buckle serve                       Serve the native RPC and MCP HTTP faces
  buckle mcp                         Serve MCP over stdio
  buckle tools                       List available tools
  buckle manifest                    Print the full manifest
  buckle skills [name]               List skills, or print one

  buckle <group> <verb> [args]       Run a tool, e.g. buckle fs read src/app.ts
  buckle call <tool> --json '{...}'  Run a tool with raw JSON arguments

  buckle approve <token> [--scope once|session|always]
  buckle grants list | revoke <id>
  buckle workspace list | add <id> --root <dir>
  buckle workspace token list | add <workspace> | revoke <workspace> <token-id>
  buckle workspaces list | inspect <id> | publish <id> | discard <id> | prune
  buckle history list | restore <id> | restore-stage <stage> <session> | recover <id> | prune
  buckle log [--limit N] [--json]    Show what this node actually did
  buckle plugin list | add <id> <specifier> | remove <id>
  buckle policy show | allow-command | deny-command | allow-url | mount | migrate | ...

  buckle --version                   Print the version
`)
  return { exitCode: 0 }
}

/** The audit view. Every attempt appears, so a refusal is as visible as a success. */
function printLog(runtime: BuckleRuntime, argv: string[]): CliResult {
  const { values } = parseArgs({
    args: argv,
    options: { limit: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: false,
  })
  const limit = Number.parseInt(values.limit ?? '50', 10)
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    process.stderr.write('--limit must be a positive integer\n')
    return { exitCode: 1 }
  }

  const entries = runtime.actions.read(limit)
  if (values.json) return print(entries)
  if (entries.length === 0) {
    process.stdout.write('No actions recorded yet.\n')
    return { exitCode: 0 }
  }

  for (const entry of entries) {
    process.stdout.write(`${entry.at}  ${entry.outcome.padEnd(17)} ${entry.tool.padEnd(18)} ${entry.durationMs}ms\n`)
    for (const effect of entry.effects) process.stdout.write(`    ${effect}\n`)
    for (const ask of entry.asked ?? []) process.stdout.write(`    asked: ${ask}\n`)
    for (const grant of entry.approvedBy ?? []) process.stdout.write(`    allowed by: ${grant}\n`)
    if (entry.detail) process.stdout.write(`    ${entry.detail}\n`)
  }
  return { exitCode: 0 }
}

function printTools(runtime: BuckleRuntime): CliResult {
  for (const capability of runtime.registry().capabilities()) {
    const { group, verb } = toolNameToCommand(capability.name)
    process.stdout.write(`${`${group} ${verb}`.padEnd(24)} ${capability.risk.padEnd(8)} ${capability.description}\n`)
  }
  return { exitCode: 0 }
}

function printSkills(runtime: BuckleRuntime, argv: string[]): CliResult {
  const [name] = argv
  const skills = runtime.skills()
  if (!name) {
    for (const skill of skills) process.stdout.write(`${skill.name.padEnd(24)} ${skill.description}\n`)
    return { exitCode: 0 }
  }
  const skill = skills.find(candidate => candidate.name === name)
  if (!skill) return fail(`Unknown skill: ${name}`)
  process.stdout.write(`${skill.content}\n`)
  return { exitCode: 0 }
}

function approve(runtime: BuckleRuntime, argv: string[]): CliResult {
  const { positionals, values } = parseArgs({
    args: argv,
    options: { scope: { type: 'string' }, deny: { type: 'boolean' } },
    allowPositionals: true,
  })
  const token = positionals[0]
  if (!token) return fail('Usage: buckle approve <token> [--scope once|session|always] [--deny]')

  const scope = GrantScopeSchema.safeParse(values.scope ?? 'once')
  if (!scope.success) return fail(`Invalid scope: ${values.scope}`)

  const result = runtime.approvals.resolve({ token, approved: values.deny !== true, scope: scope.data }, 'admin')
  if (!result.ok) return fail(result.reason)
  process.stdout.write(`${values.deny ? 'Denied' : 'Approved'} ${token}\n`)
  return { exitCode: 0 }
}

function grants(runtime: BuckleRuntime, argv: string[]): CliResult {
  const [action, id] = argv
  if (action === 'revoke') {
    if (!id) return fail('Usage: buckle grants revoke <id>')
    if (!runtime.grants.revoke(id)) return fail(`Grant not found: ${id}`)
    process.stdout.write(`Revoked ${id}\n`)
    return { exitCode: 0 }
  }
  for (const grant of runtime.grants.list()) {
    process.stdout.write(`${grant.id}  ${grant.scope.padEnd(8)} ${grant.rule.padEnd(20)} ${grant.subject}\n`)
  }
  return { exitCode: 0 }
}

async function plugin(runtime: BuckleRuntime, argv: string[]): Promise<CliResult> {
  const [action, id, specifier] = argv
  if (action === 'add') {
    if (!id || !specifier) return fail('Usage: buckle plugin add <id> <module-specifier>')
    runtime.plugins.add({ id, specifier })
    await runtime.reload()
    process.stdout.write(`Added plugin ${id}\n`)
    return { exitCode: 0 }
  }
  if (action === 'remove') {
    if (!id) return fail('Usage: buckle plugin remove <id>')
    if (!runtime.plugins.remove(id)) return fail(`Plugin not found: ${id}`)
    await runtime.reload()
    process.stdout.write(`Removed plugin ${id}\n`)
    return { exitCode: 0 }
  }
  for (const entry of runtime.plugins.list()) {
    process.stdout.write(`${entry.id.padEnd(24)} ${entry.enabled ? 'enabled ' : 'disabled'} ${entry.specifier}\n`)
  }
  return { exitCode: 0 }
}

async function callByName(runtime: BuckleRuntime, argv: string[]): Promise<CliResult> {
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

async function callByCommand(runtime: BuckleRuntime, group: string, argv: string[]): Promise<CliResult> {
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
  return reportResponse(response)
}

function reportResponse(response: InvokeResponse): CliResult {
  if (response.outcome === 'ok') return print(response.output)

  if (response.outcome === 'approval_required') {
    for (const approval of response.approvals) {
      process.stderr.write(
        `Approval required: ${approval.reason}\n  subject: ${approval.subject}\n  buckle approve ${approval.token} --scope ${defaultScope(approval.offeredScopes)}\n`,
      )
    }
    return { exitCode: 3 }
  }

  process.stderr.write(`${response.error.code}: ${response.error.message}\n`)
  return { exitCode: 1 }
}

function defaultScope(offered: GrantScope[]): GrantScope {
  return offered.includes('session') ? 'session' : (offered[0] ?? 'once')
}

function print(value: unknown): CliResult {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  return { exitCode: 0 }
}

function fail(message: string): CliResult {
  process.stderr.write(`${message}\n`)
  return { exitCode: 1 }
}

async function historyCommand(runtime: BuckleRuntime, argv: string[]): Promise<CliResult> {
  const [command = 'list', id] = argv
  if (command === 'list') return print(runtime.history.list())
  if (command === 'prune') return print(await runtime.history.prune())
  if (command === 'restore-stage' && id && argv[2]) return print(await runtime.history.restoreStage(id, argv[2]))
  if (command === 'restore' && id) return print(await runtime.history.restore(id))
  if (command === 'recover' && id) return print(await runtime.history.recover(id))
  return fail('Usage: buckle history list | restore <id> | restore-stage <stage> <session> | recover <id> | prune')
}

async function shellWorkspacesCommand(runtime: BuckleRuntime, argv: string[]): Promise<CliResult> {
  const [command = 'list', id] = argv
  if (command === 'list') return print(runtime.shellWorkspaces.list())
  if (command === 'prune') return print(await runtime.shellWorkspaces.prune())
  if (command === 'inspect' && id) return print(await runtime.shellWorkspaces.inspect(id))
  if (command === 'publish' && id) return print(await runtime.shellWorkspaces.publish(id))
  if (command === 'discard' && id) return print(await runtime.shellWorkspaces.discard(id))
  return fail('Usage: buckle workspaces list | inspect <id> | publish <id> | discard <id> | prune')
}
