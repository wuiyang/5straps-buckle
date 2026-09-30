import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { actionsPath, loadConfig, type BuckleConfig } from '../common/runtime/config.js'
import { environmentFilePath } from '../common/runtime/environment.js'
import { auditOperation } from '../common/services/audit/audit-operation.js'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import type { InvokeResponse } from '@5straps/protocol'
import { GrantScopeSchema } from '@5straps/protocol'
import { describeExpiry } from '../common/domain/approval-deadline.js'
import { approveCommand, denyCommand, describeAction, describeApprovalRequest, describeAsk, printable, RECORDED_BEFORE_NOTE } from '../common/domain/approval-instruction.js'
import type { PendingAsk } from '../common/services/approvals/approval-registry.js'
import { WorkspaceError, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { CheckpointSummary } from '../common/services/history/journal.js'
import { initializeCommon, type BuckleCommon } from '../common/runtime/initialize.js'
import { withOperationScope } from '@5straps/runtime'
import { logger } from '../common/runtime/log.js'
import { setupCli } from './setup.js'
import { buildToolArgs, commandToToolName, parseArgsOptions, toolNameToCommand } from './arguments.js'
import { policyCommand, repairStoredPolicy } from './policy.js'
import { keysCommand } from './keys.js'
import { StoredPolicyError } from '../common/domain/policy.js'
import { isStateBusy } from '../common/services/state-busy.js'
import { watchApprovals } from './approvals-watch.js'
import { CHECK_URL_BAD_INPUT, checkUrlCommand, checkUrlUnreadable } from './check-url.js'
import { workspaceRegistryCommand } from './workspace.js'
import { runInit } from './init.js'
import { settingsCommand } from './settings.js'
import { BUCKLE_VERSION } from '../common/runtime/version.js'
import { confirmAtTerminal } from './terminal-consumer.js'

export interface CliResult {
  exitCode: number
  /** For the command's audit entry: what a widened approval covers. */
  detail?: string
}

/** Needs no node config beyond where the audit log lives: init is what writes the configuration. */
export function runInitCommand(argv: string[]): Promise<CliResult> {
  return auditOperation({ actions: createFileActionLog(actionsPath(loadConfig())), workspaceId: 'default', tool: 'cli_init', sessionId: 'local-owner', isSuccessful: result => result.exitCode === 0, operation: () => runInit(argv) })
}

export function runSettingsCommand(argv: string[]): Promise<CliResult> {
  return settingsCommand({ argv, environment: process.env, environmentFile: environmentFilePath(), cwd: process.cwd() })
}

/** Help and the version, which need no configuration; null for every other command. */
export function answerWithoutConfiguration(argv: string[]): CliResult | null {
  const [command] = argv
  if (!command || command === 'help' || command === '--help' || command === '-h') return printUsage()
  if (command === '--version' || command === '-v') return printVersion()
  return null
}

/**
 * Asks the person at this process's terminal to confirm one decision, after the whole action was shown
 * (owner decision D17); null where the process has no terminal, so nothing can be confirmed.
 */
export type Confirm = (prompt: string) => Promise<boolean>

export async function runCli(input: { argv: string[]; config: BuckleConfig; confirm?: Confirm | null }): Promise<CliResult> {
  const answered = answerWithoutConfiguration(input.argv)
  if (answered) return answered
  const [command = '', ...rest] = input.argv
  const confirm = input.confirm !== undefined ? input.confirm : process.stdin.isTTY ? (prompt: string) => confirmAtTerminal(prompt) : null

  // One command is one process owner: its common runtime closes when the command ends.
  const common = initializeCommon({ config: input.config, role: 'cli' })
  // A terminal answers a gated call in place; without one the call reports back at once (exit 3).
  const cli = setupCli({ terminal: process.stdin.isTTY ? { input: process.stdin, output: process.stderr } : null })
  common.bindRequester(cli.requestCli)
  common.owner.onClose('waiters', 'terminal questions', () => cli.close())
  try {
    return await runCliCommand({ common, config: input.config, command, rest, confirm })
  } catch (error) {
    if (isStateBusy(error)) return fail(error.message)
    throw error
  } finally {
    await common.owner.close().catch((error: unknown) => {
      logger.error('Buckle closed with errors', { error })
    })
  }
}

async function runCliCommand(input: { common: BuckleCommon; config: BuckleConfig; command: string; rest: string[]; confirm: Confirm | null }): Promise<CliResult> {
  const { common, command, rest } = input
  try {
    await common.start()
  } catch (error) {
    // check-url's exit 1 means denied, so a node it cannot read must not look like one.
    if (command === 'check-url') return checkUrlUnreadable(error)
    if (command === 'policy' && error instanceof StoredPolicyError) return repairStoredPolicy({ config: input.config, argv: rest, failure: error })
    throw error
  }
  const runtime = await common.services.getWorkspaceRuntime()
  const workspaces = await common.services.getWorkspaces()
  const scope = common.owner.registry.createScope({ context: { actor: 'local-owner' } })
  return withOperationScope(scope, async () => {
    (await common.services.getInteraction(scope)).bind('prompt')
    return runAuditedCommand({ runtime, workspaces, config: input.config, command, rest, confirm: input.confirm })
  })
}

/** The commands that run no tool. Any other command resolves to one: `call`, and every `<group> <verb>`. */
const OWNER_COMMANDS: readonly string[] = Object.freeze(['tools', 'manifest', 'skills', 'approve', 'approvals', 'check-url', 'grants', 'workspace', 'workspaces', 'history', 'log', 'plugin', 'policy', 'keys'])

/** Whether a command runs a tool on the node's root, so a project outside that root is warned (owner decision D5, review M5 of B20-B22). */
export function runsTool(argv: readonly string[]): boolean {
  const [command] = argv
  return command !== undefined && !OWNER_COMMANDS.includes(command)
}

async function runAuditedCommand(input: CommandContext): Promise<CliResult> {
  const { runtime, command } = input
  try {
    if (['approve', 'approvals', 'check-url', 'grants', 'workspace', 'workspaces', 'history', 'plugin', 'policy', 'keys'].includes(command)) {
      // A check that answers denied or asks has still succeeded; only bad input failed.
      const isSuccessful = command === 'check-url' ? (result: CliResult) => result.exitCode !== CHECK_URL_BAD_INPUT : (result: CliResult) => result.exitCode === 0
      return await auditOperation({ actions: runtime.actions, workspaceId: runtime.workspaceId, tool: `cli_${command}`, sessionId: 'local-owner', isSuccessful, describe: result => result.detail,
        operation: () => dispatchRuntimeCommand(input),
      })
    }
    return await dispatchRuntimeCommand(input)
  } finally {
    // One command is one process, and the batch timer is unreferenced so it never holds the
    // process open: without this the entry a CLI call recorded reached Rings for no call at all.
    await runtime.reporter.flush()
  }
}

interface CommandContext { runtime: BuckleRuntime; workspaces: WorkspaceManager; config: BuckleConfig; command: string; rest: string[]; confirm: Confirm | null }

function dispatchRuntimeCommand(input: CommandContext): CliResult | Promise<CliResult> {
  const { runtime, command, rest } = input
  if (runsTool([command])) return command === 'call' ? callByName(runtime, rest) : callByCommand(runtime, command, rest)
  if (command === 'tools') return printTools(runtime)
  if (command === 'manifest') return print(runtime.manifest())
  if (command === 'skills') return printSkills(runtime, rest)
  if (command === 'approve') return reportWorkspaceErrors(() => approve({ config: input.config, runtime, workspaces: input.workspaces, argv: rest, confirm: input.confirm }))
  if (command === 'approvals') return reportWorkspaceErrors(() => approvals({ config: input.config, runtime, workspaces: input.workspaces, argv: rest }))
  if (command === 'check-url') return checkUrlCommand({ argv: rest, allowedHosts: input.config.allowedHosts, runtimeFor: workspace => runtimeForWorkspace({ runtime, workspaces: input.workspaces, workspace }) })
  if (command === 'grants') return grants(runtime, rest)
  if (command === 'workspace') return workspaceRegistryCommand({ config: input.config, runtime, argv: rest })
  if (command === 'workspaces') return shellWorkspacesCommand(runtime, rest)
  if (command === 'history') return historyCommand(runtime, rest)
  if (command === 'log') return printLog(runtime, rest)
  if (command === 'plugin') return plugin(runtime, rest)
  if (command === 'policy') return policyCommand(runtime, rest, input.workspaces)
  if (command === 'keys') return keysCommand({ config: input.config, argv: rest })
  throw new Error(`No handler for the owner command ${command}`)
}

function printVersion(): CliResult {
  process.stdout.write(`${BUCKLE_VERSION}\n`)
  return { exitCode: 0 }
}

function printUsage(): CliResult {
  process.stdout.write(`buckle ${BUCKLE_VERSION}, the 5straps execution node

  buckle init                        Write an environment file for a workspace, with fresh tokens
  buckle init --pair <code> --rings <url>   Redeem a Rings pairing code and register this node
  buckle serve                       Serve the native RPC and MCP HTTP faces
  buckle mcp                         Serve MCP over stdio
  buckle tools                       List available tools
  buckle manifest                    Print the full manifest
  buckle skills [name]               List skills, or print one

  buckle <group> <verb> [args]       Run a tool, e.g. buckle fs read src/app.ts
  buckle call <tool> --json '{...}'  Run a tool with raw JSON arguments

  buckle approvals [--json] [--workspace <id>]   Requests waiting for a decision
  buckle approvals --watch [--workspace <id>]    Ask about each request as it arrives
  buckle approve <token> [--scope once|session|always] [--host '*.example.com'] [--deny] [--workspace <id>]
                                   Shows the whole action, then approves only once you confirm at a terminal
  buckle check-url <url|host> [--session <id>] [--workspace <id>]   Exits 0 approved, 1 denied, 3 asks, 4 not listed
  buckle grants list | revoke <id>
  buckle workspace list | add <id> --root <dir>
  buckle workspace token list | add <workspace> | revoke <workspace> <token-id>
  buckle workspaces list | inspect <id> | publish <id> | discard <id> | prune
  buckle history list | restore <id> | restore-stage <stage> <session> | recover <id> | prune
  buckle log [--limit N] [--json]    Show what this node actually did
  buckle plugin list | add <id> <specifier> | remove <id>
  buckle policy show | allow-command | deny-command | allow-url | mount | ...
  buckle policy deny-tool <tool> | allow-tool <tool>   Refuse a tool outright, or lift that
  buckle settings show | set <key> <value> | unset <key>   Node settings in the environment file
  buckle keys enroll <public-key> --purpose <p> --workspace <w> | list | revoke <key-id>
                                   Client keys trusted for signed setup and approvals, by scope
  buckle client keygen | key | request <METHOD> <url>     This device's signing key, and a signed request with it

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

  // The tool name, effects, subjects and detail all carry what an agent sent (review L1 of B13-B14, `buckle log`).
  for (const entry of entries) {
    process.stdout.write(`${entry.at}  ${entry.outcome.padEnd(17)} ${printable(entry.tool).padEnd(18)} ${entry.durationMs}ms\n`)
    for (const effect of entry.effects) process.stdout.write(`    ${printable(effect)}\n`)
    for (const ask of entry.asked ?? []) process.stdout.write(`    asked: ${printable(ask)}\n`)
    for (const grant of entry.approvedBy ?? []) process.stdout.write(`    allowed by: ${printable(grant)}\n`)
    if (entry.detail) process.stdout.write(`    ${printable(entry.detail)}\n`)
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

/** A named workspace that is unknown, disabled or retired is a typo to report, not a crash. */
async function reportWorkspaceErrors(operation: () => Promise<CliResult>): Promise<CliResult> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof WorkspaceError) return fail(error.message)
    throw error
  }
}

interface CommandInput {
  config: BuckleConfig
  runtime: BuckleRuntime
  workspaces: WorkspaceManager
  argv: string[]
}

/**
 * Whose queue is being answered. A token is issued and resolved inside one workspace's own state,
 * so a request from a registered child workspace is reachable only through that workspace's
 * runtime; the node's own is the default.
 */
async function runtimeForWorkspace(input: { runtime: BuckleRuntime; workspaces: WorkspaceManager; workspace?: string }): Promise<BuckleRuntime> {
  if (!input.workspace || input.workspace === 'default') return input.runtime
  return (await input.workspaces.resolve(input.workspace)).runtime
}

/**
 * The queue a person answers from. `buckle approve` needs a token, and a request only reaches a
 * terminal when a prompt was on screen there, so without this the tokens waiting on a node were
 * readable through the admin API alone.
 */
async function approvals(input: CommandInput): Promise<CliResult> {
  const { values } = parseArgs({ args: input.argv, options: { json: { type: 'boolean' }, watch: { type: 'boolean' }, workspace: { type: 'string' } }, allowPositionals: false })
  if (values.watch && values.json) return fail('--watch asks in the terminal, so it takes no --json')
  const runtime = await runtimeForWorkspace({ ...input, workspace: values.workspace })
  if (values.watch) return watch(runtime, input.runtime)
  const waiting = runtime.approvalService.waiting()
  // The whole call each ask came from (owner decision D17), redacted and never cut; an ask recorded before this build has none.
  const callOf = (call: (typeof waiting)[number]['call']) => call?.complete ? { call: { arguments: call.arguments, cwd: call.cwd, description: call.description, effects: call.effects ?? [] } } : {}
  if (values.json) return print(waiting.map(({ request, call }) => ({ ...request, workspaceId: runtime.workspaceId, approveCommand: approveCommand({ request, workspaceId: runtime.workspaceId }), ...callOf(call) })))
  if (waiting.length === 0) {
    process.stdout.write(`Nothing is waiting for a decision in workspace ${runtime.workspaceId}.\n`)
    return { exitCode: 0 }
  }

  for (const { request, call } of waiting) {
    process.stdout.write(`${request.token}  ${printable(request.tool)}\n`)
    process.stdout.write(`    ${request.rule}: ${printable(request.subject)}\n`)
    process.stdout.write(`    ${printable(request.reason)}\n`)
    process.stdout.write(`    scopes: ${request.offeredScopes.join(' | ')}\n`)
    process.stdout.write(`    ${describeExpiry(request.expiresAt)}\n`)
    const shown = callOf(call).call
    // An ask recorded before this build is denied or re-sent, never approved (owner decision D17).
    process.stdout.write(`    ${shown ? approveCommand({ request, workspaceId: runtime.workspaceId }) : denyCommand({ request, workspaceId: runtime.workspaceId })}\n`)
    const action = shown
      ? describeAction({ node: input.config.serverId, workspace: runtime.workspaceId, rule: request.rule, subject: request.subject, reason: request.reason, ...shown })
      : [`  ${RECORDED_BEFORE_NOTE}`]
    process.stdout.write(`${action.map(line => `  ${line}`).join('\n')}\n`)
  }
  return { exitCode: 0 }
}

/**
 * Asks about each request as it arrives, in a terminal of its own beside `buckle serve`. A Ctrl-C
 * that reaches the process as a signal, where readline is not reading keys, stops it the same way.
 * Each answer is audited in the node's log, where `buckle approve` records its own.
 */
async function watch(runtime: BuckleRuntime, node: BuckleRuntime): Promise<CliResult> {
  if (!process.stdin.isTTY) return fail('buckle approvals --watch needs a terminal to ask in; use buckle approvals and buckle approve instead')
  const interrupted = new AbortController()
  const interrupt = () => interrupted.abort()
  process.once('SIGINT', interrupt)
  try {
    return await watchApprovals({ approvals: runtime.approvalService, actions: node.actions, workspaceId: runtime.workspaceId, input: process.stdin, output: process.stdout, errors: process.stderr, signal: interrupted.signal })
  } finally {
    process.off('SIGINT', interrupt)
  }
}

/**
 * Decides one ask at the node. Owner decision D17: the whole action is printed first, as `buckle approvals`
 * shows it, and an approval is recorded only after the person at a terminal confirms it. Without a terminal
 * nothing is approved (a denial still is), and an ask recorded before this build, whose whole call was never
 * kept, can only be denied (review H2).
 */
async function approve(input: CommandInput & { confirm: Confirm | null }): Promise<CliResult> {
  const { positionals, values } = parseArgs({
    args: input.argv,
    options: { scope: { type: 'string' }, deny: { type: 'boolean' }, workspace: { type: 'string' }, host: { type: 'string' } },
    allowPositionals: true,
  })
  const token = positionals[0]
  if (!token) return fail("Usage: buckle approve <token> [--scope once|session|always] [--host '*.example.com'] [--deny] [--workspace <id>]")

  const scope = GrantScopeSchema.safeParse(values.scope ?? 'once')
  if (!scope.success) return fail(`Invalid scope: ${values.scope}`)

  const runtime = await runtimeForWorkspace({ ...input, workspace: values.workspace })
  const ask = runtime.approvalService.waiting().find(entry => entry.request.token === token)
  if (ask) process.stdout.write(`${token}\n${describeWaitingAsk({ ask, node: input.config.serverId, workspaceId: runtime.workspaceId }).join('\n')}\n`)
  // A token no longer waiting reaches the queue as it is: it can repeat the decision already recorded, and decide nothing new.
  if (values.deny !== true && ask) {
    if (!ask.call?.complete) return fail(`Not approved: ${printable(token)} was ${RECORDED_BEFORE_NOTE}. Deny it with ${denyCommand({ request: ask.request, workspaceId: runtime.workspaceId })}`)
    if (!input.confirm) return fail(`Not approved: buckle approve records an approval only after a person at a terminal confirms the action above, and this process has none. Answer it in buckle approvals --watch${runtime.workspaceId === 'default' ? '' : ` --workspace ${runtime.workspaceId}`}, or run buckle approve in a terminal; --deny works anywhere`)
    const widened = values.host === undefined ? '' : ` for ${printable(values.host)}`
    if (!await input.confirm(`Approve ${token} (${scope.data})${widened} in workspace ${runtime.workspaceId}? Type yes to approve; anything else leaves it waiting.\n`)) {
      process.stdout.write(`Nothing decided; ${token} is still waiting in workspace ${runtime.workspaceId}\n`)
      return { exitCode: 1 }
    }
  }
  // `BUCKLE-D18`: `--host` widens a network approval to a pattern, under the owner's authority alone.
  const result = await runtime.approvalService.answer({ decision: { token, approved: values.deny !== true, scope: scope.data }, authority: 'admin', ...(values.host === undefined ? {} : { widenTo: values.host }) })
  if (!result.ok) return fail(`${result.reason} in workspace ${runtime.workspaceId}`)
  if (result.widened) {
    const { pattern, askedBy } = result.widened
    process.stdout.write(`Approved ${token} (${scope.data}) for ${pattern}, asked by ${printable(askedBy)}, in workspace ${runtime.workspaceId}\n`)
    return { exitCode: 0, detail: `network_egress ${scope.data} approval widened to ${pattern}, asked by ${askedBy}` }
  }
  process.stdout.write(`${values.deny ? 'Denied' : 'Approved'} ${token} in workspace ${runtime.workspaceId}\n`)
  return { exitCode: 0 }
}

async function grants(runtime: BuckleRuntime, argv: string[]): Promise<CliResult> {
  const [action, id] = argv
  if (action === 'revoke') {
    if (!id) return fail('Usage: buckle grants revoke <id>')
    if (!await runtime.grants.revoke(id)) return fail(`Grant not found: ${id}`)
    process.stdout.write(`Revoked ${id}\n`)
    return { exitCode: 0 }
  }
  for (const grant of runtime.grants.list()) {
    process.stdout.write(`${grant.id}  ${grant.denied ? 'DENY ' : 'ALLOW'} ${grant.scope.padEnd(8)} ${grant.rule.padEnd(20)} ${printable(grant.subject)}${grant.pattern ? '  (host pattern)' : ''}\n`)
  }
  return { exitCode: 0 }
}

async function plugin(runtime: BuckleRuntime, argv: string[]): Promise<CliResult> {
  const [action, id, specifier] = argv
  if (action === 'add') {
    if (!id || !specifier) return fail('Usage: buckle plugin add <id> <module-specifier>')
    await runtime.plugins.add({ id, specifier })
    await runtime.reload()
    process.stdout.write(`Added plugin ${id}\n`)
    return { exitCode: 0 }
  }
  if (action === 'remove') {
    if (!id) return fail('Usage: buckle plugin remove <id>')
    if (!await runtime.plugins.remove(id)) return fail(`Plugin not found: ${id}`)
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
  return reportResponse({ response, workspaceId: runtime.workspaceId })
}

/** One waiting ask as `buckle approve` shows it before deciding: the ask, then its whole action (owner decision D17). */
function describeWaitingAsk(input: { ask: PendingAsk; node: string; workspaceId: string }): string[] {
  const { request, call } = input.ask
  return describeAsk({ ...request, workspaceId: input.workspaceId, node: input.node, ...(call?.complete ? { call } : {}) })
}

function reportResponse(input: { response: InvokeResponse; workspaceId: string }): CliResult {
  const { response } = input
  if (response.outcome === 'ok') return print(response.output)

  if (response.outcome === 'approval_required') {
    // Leads with buckle approvals, which shows the whole action, and names buckle approve after it (owner decision D17).
    for (const approval of response.approvals) {
      const [first, ...rest] = describeApprovalRequest({ request: approval, workspaceId: input.workspaceId })
      process.stderr.write(`Approval required: ${first}\n${rest.map(line => `  ${line}\n`).join('')}`)
    }
    return { exitCode: 3 }
  }

  process.stderr.write(`${response.error.code}: ${response.error.message}\n`)
  return { exitCode: 1 }
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
  if (command === 'list') return print((await runtime.history.list()).map(printableCheckpoint))
  if (command === 'prune') return print(await runtime.history.prune())
  if (command === 'restore-stage' && id && argv[2]) return print(await runtime.history.restoreStage(id, argv[2]))
  if (command === 'restore' && id) return print(await runtime.history.restore(id))
  if (command === 'recover' && id) return print(await runtime.history.recover(id))
  return fail('Usage: buckle history list | restore <id> | restore-stage <stage> <session> | recover <id> | prune')
}

/**
 * A checkpoint as a person reads it: the session, stage and paths an agent chose, escaped as every
 * other rendering of agent text is (review L8 of B15-B17).
 */
function printableCheckpoint(checkpoint: CheckpointSummary): CheckpointSummary {
  return {
    ...checkpoint,
    sessionId: printable(checkpoint.sessionId),
    stageId: printable(checkpoint.stageId),
    tool: printable(checkpoint.tool),
    paths: checkpoint.paths.map(printable),
    changes: checkpoint.changes.map(change => ({ ...change, path: printable(change.path) })),
  }
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
