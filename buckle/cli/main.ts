import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { actionsPath, loadConfig, type NodeConfig } from '../common/runtime/config.js'
import { NODE_SCOPE } from '../common/types/ports/client-keys.js'
import { environmentFilePath } from '../common/runtime/environment.js'
import { auditOperation } from '../common/services/audit/audit-operation.js'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import type { InvokeResponse } from '@5straps/protocol'
import { GrantScopeSchema } from '@5straps/protocol'
import { describeExpiry } from '../common/domain/approval-deadline.js'
import { approveCommand, denyCommand, describeAction, describeApprovalRequest, describeAsk, printable, RECORDED_BEFORE_NOTE, sameCallNote, workspaceLabel } from '../common/domain/approval-instruction.js'
import { shownCall, type PendingAsk } from '../common/services/approvals/approval-registry.js'
import { SCRIPT_CALL_NOTE } from '../common/domain/describe-call.js'
import { WorkspaceError, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { CheckpointSummary } from '../common/services/history/journal.js'
import { initializeCommon, type BuckleCommon } from '../common/runtime/initialize.js'
import { withOperationScope } from '@5straps/runtime'
import { logger } from '../common/runtime/log.js'
import { setupCli } from './setup.js'
import { buildToolArgs, commandToToolName, parseArgsOptions, toolNameToCommand } from './arguments.js'
import { policyCommand, repairStoredPolicy } from './policy.js'
import { takeTarget, TargetError, type CommandTarget } from './target.js'
import { keysCommand } from './keys.js'
import { StoredPolicyError } from '../common/domain/policy.js'
import { isStateBusy } from '../common/services/state-busy.js'
import { watchApprovals } from './approvals-watch.js'
import { CHECK_URL_BAD_INPUT, checkUrlCommand, checkUrlUnreadable } from './check-url.js'
import { workspaceRegistryCommand } from './workspace.js'
import { runInit } from './init.js'
import { settingsCommand } from './settings.js'
import { BUCKLE_VERSION } from '../common/runtime/version.js'
import { terminalConfirm, type Confirm } from './terminal-consumer.js'

export interface CliResult {
  exitCode: number
  /** For the command's audit entry: what a widened approval covers. */
  detail?: string
}

/** Needs no node config beyond where the audit log lives: init is what writes the configuration. */
export function runInitCommand(argv: string[]): Promise<CliResult> {
  return auditOperation({ actions: createFileActionLog(actionsPath(loadConfig())), workspaceId: NODE_SCOPE, tool: 'cli_init', sessionId: 'local-owner', isSuccessful: result => result.exitCode === 0, operation: () => runInit(argv) })
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

export type { Confirm } from './terminal-consumer.js'

/** `cwd`: the directory the command means where it names no workspace (D83 (4)); the process's own by default. */
export async function runCli(input: { argv: string[]; config: NodeConfig; confirm?: Confirm | null; cwd?: string }): Promise<CliResult> {
  const answered = answerWithoutConfiguration(input.argv)
  if (answered) return answered
  const [command = '', ...rest] = input.argv
  const confirm = input.confirm !== undefined ? input.confirm : terminalConfirm({ input: process.stdin, output: process.stdout })

  // One command is one process owner: its common runtime closes when the command ends.
  const common = initializeCommon({ config: input.config, role: 'cli' })
  // A terminal answers a gated call in place; without one the call reports back at once (exit 3). The question is
  // shown on stderr, so both ends must be a terminal: with stderr redirected a key would answer an unseen action
  // (review L2 of the continuation review).
  const cli = setupCli({ terminal: process.stdin.isTTY && process.stderr.isTTY ? { input: process.stdin, output: process.stderr } : null })
  common.bindRequester(cli.requestCli)
  common.owner.onClose('waiters', 'terminal questions', () => cli.close())
  try {
    return await runCliCommand({ common, config: input.config, command, rest, confirm, cwd: input.cwd ?? process.cwd() })
  } catch (error) {
    if (isStateBusy(error)) return fail(error.message)
    throw error
  } finally {
    await common.owner.close().catch((error: unknown) => {
      logger.error('Buckle closed with errors', { error })
    })
  }
}

async function runCliCommand(input: { common: BuckleCommon; config: NodeConfig; command: string; rest: string[]; confirm: Confirm | null; cwd: string }): Promise<CliResult> {
  const { common, command } = input
  try {
    await common.start()
  } catch (error) {
    // check-url's exit 1 means denied, so a node it cannot read must not look like one.
    if (command === 'check-url') return checkUrlUnreadable(error)
    throw error
  }
  const workspaces = await common.services.getWorkspaces()
  const scope = common.owner.registry.createScope({ context: { actor: 'local-owner' } })
  return withOperationScope(scope, async () => {
    (await common.services.getInteraction(scope)).bind('prompt')
    if (NODE_COMMANDS.includes(command)) return runNodeCommand({ ...input, workspaces })
    let taken: ReturnType<typeof takeTarget>
    try { taken = takeTarget(input.rest) } catch (error) {
      if (error instanceof TargetError) return fail(error.message)
      throw error
    }
    // Q9: an approver's command that names no workspace answers in every online one, as buckle serve asks in all of them.
    if (APPROVER_COMMANDS.includes(command) && taken.target.workspace === undefined && taken.target.dir === undefined) return runApproverCommand({ ...input, workspaces, rest: taken.argv })
    return runWorkspaceCommand({ ...input, workspaces, target: taken.target, rest: taken.argv })
  })
}

/** The commands that answer asks: with no --workspace or --dir, over every online workspace (Q9). */
const APPROVER_COMMANDS: readonly string[] = Object.freeze(['approve', 'approvals'])
/** The commands that act on the node rather than on one workspace: its registry and its trusted keys. */
const NODE_COMMANDS: readonly string[] = Object.freeze(['workspace', 'keys'])
/** The owner's commands on one workspace that are audited; reads such as `tools` are not. */
const AUDITED_COMMANDS: readonly string[] = Object.freeze(['approve', 'approvals', 'check-url', 'grants', 'workspaces', 'history', 'plugin', 'policy'])
/** The commands that run no tool. Any other command resolves to one: `call`, and every `<group> <verb>`. */
const OWNER_COMMANDS: readonly string[] = Object.freeze(['tools', 'manifest', 'skills', 'log', ...AUDITED_COMMANDS])

/** A command on the node, audited in the node's own log. */
async function runNodeCommand(input: { workspaces: WorkspaceManager; config: NodeConfig; command: string; rest: string[]; cwd: string }): Promise<CliResult> {
  const { workspaces, command, rest } = input
  return auditOperation({ actions: workspaces.nodeActions, workspaceId: NODE_SCOPE, tool: `cli_${command}`, sessionId: 'local-owner', isSuccessful: result => result.exitCode === 0, describe: result => result.detail,
    operation: () => (command === 'keys' ? keysCommand({ config: input.config, argv: rest }) : workspaceRegistryCommand({ config: input.config, workspaces, argv: rest, cwd: input.cwd })),
  })
}

/**
 * A command on the workspace it targets (D83 (4)): `--workspace <id>`, else `--dir <path>`, else the directory it runs
 * in. `buckle policy` opens an offline workspace too, so its owner can set it up before it serves.
 */
async function runWorkspaceCommand(input: { workspaces: WorkspaceManager; config: NodeConfig; command: string; rest: string[]; target: CommandTarget; confirm: Confirm | null; cwd: string }): Promise<CliResult> {
  const { workspaces, command } = input
  let runtime: BuckleRuntime
  try {
    const id = workspaces.target({ ...input.target, cwd: input.cwd })
    runtime = (await workspaces.resolve(id, { setup: command === 'policy' })).runtime
  } catch (error) {
    if (command === 'check-url') return checkUrlUnreadable(error)
    if (command === 'policy' && error instanceof StoredPolicyError) return repairStoredPolicy({ workspaces, target: input.target, cwd: input.cwd, argv: input.rest, failure: error })
    // An owner's command the log keeps is refused before any workspace's log is known: the node's records it (finding 31).
    if (error instanceof WorkspaceError) return AUDITED_COMMANDS.includes(command) ? nodeAudited(input, () => fail(error.message)) : fail(error.message)
    throw error
  }
  return runOnWorkspace({ ...input, runtime })
}

/**
 * `buckle approvals` and `buckle approve` naming no workspace (Q9): over every online one. A token is answered in the
 * workspace whose queue holds it, and audited in its log, as with --workspace; a node with one online workspace reads
 * as before; the list and the watch over several are audited in the node's log.
 */
async function runApproverCommand(input: { workspaces: WorkspaceManager; config: NodeConfig; command: string; rest: string[]; confirm: Confirm | null }): Promise<CliResult> {
  const runtimes = await onlineRuntimes(input.workspaces)
  if (runtimes.length === 0) return fail('No workspace is online, so none has asks waiting. Name one with --workspace <id>, or serve one again with buckle workspace enable <id>.')
  // A watch follows the online workspaces as they change, however many there are at its start (finding 10).
  const watching = input.command === 'approvals' && input.rest.includes('--watch')
  if (runtimes.length === 1 && !watching) return runOnWorkspace({ ...input, runtime: runtimes[0]! })
  const token = input.command === 'approve' ? approveArguments(input.rest).positionals[0] : approvalsArguments(input.rest).positionals[1]
  if (token !== undefined) {
    const holder = holderOfAsk(runtimes, token)
    if (typeof holder !== 'string') return runOnWorkspace({ ...input, runtime: holder })
    // Refused before any workspace is chosen: recorded in the node's log, as the list across them is (finding 31).
    return nodeAudited(input, () => fail(holder))
  }
  if (input.command === 'approve') return nodeAudited(input, () => fail(APPROVE_USAGE))
  return nodeAudited(input, () => approvalsAcross({ runtimes, workspaces: input.workspaces, config: input.config, argv: input.rest }))
}

/** An owner's command that no one workspace answers, audited in the node's log: an attempt, and its result. */
function nodeAudited(input: { workspaces: WorkspaceManager; command: string }, operation: () => CliResult | Promise<CliResult>): Promise<CliResult> {
  return auditOperation({ actions: input.workspaces.nodeActions, workspaceId: NODE_SCOPE, tool: `cli_${input.command}`, sessionId: 'local-owner', isSuccessful: result => result.exitCode === 0, operation })
}

/**
 * Every online workspace's runtime; one that will not open is named with its reason, once for each `told`, and the
 * rest are answered.
 */
async function onlineRuntimes(workspaces: WorkspaceManager, told = new Set<string>()): Promise<BuckleRuntime[]> {
  const runtimes: BuckleRuntime[] = []
  for (const workspace of workspaces.list().filter(item => item.online)) {
    try { runtimes.push((await workspaces.resolve(workspace.id)).runtime) } catch (error) {
      if (!told.has(workspace.id)) process.stderr.write(`Workspace ${workspace.id} could not open, so its asks are left out: ${error instanceof Error ? error.message : String(error)}\n`)
      told.add(workspace.id)
    }
  }
  return runtimes
}

/** The workspace whose queue holds `token` waiting, or why none is chosen: none or several hold it. */
function holderOfAsk(runtimes: BuckleRuntime[], token: string): BuckleRuntime | string {
  const holding = runtimes.filter(runtime => runtime.approvalService.waitingAsk(token) !== undefined)
  if (holding.length === 1) return holding[0]!
  const ids = (list: BuckleRuntime[]) => list.map(runtime => runtime.workspaceId).join(', ')
  if (holding.length > 1) return `${printable(token)} is waiting in workspaces ${ids(holding)}; name one with --workspace <id>`
  return `Nothing named ${printable(token)} is waiting in any online workspace (${ids(runtimes)}); to repeat a decision already recorded, name its workspace with --workspace <id>`
}

/** A command on one workspace's runtime, audited in its log where the command is one the owner's log keeps. */
async function runOnWorkspace(input: { runtime: BuckleRuntime; workspaces: WorkspaceManager; config: NodeConfig; command: string; rest: string[]; confirm: Confirm | null }): Promise<CliResult> {
  const { runtime, workspaces, command } = input
  const context: CommandContext = { runtime, workspaces, config: input.config, command, rest: input.rest, confirm: input.confirm }
  try {
    if (!AUDITED_COMMANDS.includes(command)) return await dispatchRuntimeCommand(context)
    // A check that answers denied or asks has still succeeded; only bad input failed.
    const isSuccessful = command === 'check-url' ? (result: CliResult) => result.exitCode !== CHECK_URL_BAD_INPUT : (result: CliResult) => result.exitCode === 0
    return await auditOperation({ actions: runtime.actions, workspaceId: runtime.workspaceId, tool: `cli_${command}`, sessionId: 'local-owner', isSuccessful, describe: result => result.detail,
      operation: () => dispatchRuntimeCommand(context),
    })
  } finally {
    // One command is one process, and the batch timer is unreferenced so it never holds the
    // process open: without this the entry a CLI call recorded reached Rings for no call at all.
    await runtime.reporter.flush()
  }
}

interface CommandContext { runtime: BuckleRuntime; workspaces: WorkspaceManager; config: NodeConfig; command: string; rest: string[]; confirm: Confirm | null }

function dispatchRuntimeCommand(input: CommandContext): CliResult | Promise<CliResult> {
  const { runtime, command, rest } = input
  if (!OWNER_COMMANDS.includes(command)) return command === 'call' ? callByName(runtime, rest) : callByCommand(runtime, command, rest)
  if (command === 'tools') return printTools(runtime)
  if (command === 'manifest') return print(runtime.manifest())
  if (command === 'skills') return printSkills(runtime, rest)
  if (command === 'approve') return reportWorkspaceErrors(() => approve({ config: input.config, runtime, argv: rest, confirm: input.confirm }))
  if (command === 'approvals') return reportWorkspaceErrors(() => approvals({ config: input.config, runtime, argv: rest }))
  if (command === 'check-url') return checkUrlCommand({ argv: rest, allowedHosts: input.config.allowedHosts, runtime: async () => runtime })
  if (command === 'grants') return grants(runtime, rest)
  if (command === 'workspaces') return shellWorkspacesCommand(runtime, rest)
  if (command === 'history') return historyCommand(runtime, rest)
  if (command === 'log') return printLog(runtime, rest)
  if (command === 'plugin') return plugin(runtime, rest)
  if (command === 'policy') return policyCommand(runtime, rest)
  throw new Error(`No handler for the owner command ${command}`)
}

function printVersion(): CliResult {
  process.stdout.write(`${BUCKLE_VERSION}\n`)
  return { exitCode: 0 }
}

function printUsage(): CliResult {
  process.stdout.write(`buckle ${BUCKLE_VERSION}, the 5straps execution node

  buckle init                        Set this machine's node up once, and serve the current folder as a
                                     workspace; prints its agent token once
  buckle init --pair <code> --rings <url>   Redeem a Rings pairing code and register this node
  buckle serve                       Serve every online workspace over HTTP: native RPC and MCP
  buckle mcp [--workspace <id> | --dir <path>]   Serve one workspace's MCP over stdio

  A command acts on the workspace --workspace <id> or --dir <path> names, else on the one whose
  folder holds the current directory.

  buckle tools                       List available tools
  buckle manifest                    Print the full manifest
  buckle skills [name]               List skills, or print one

  buckle <group> <verb> [args]       Run a tool, e.g. buckle fs read src/app.ts
  buckle call <tool> --json '{...}'  Run a tool with raw JSON arguments

  buckle approvals [--json] [--workspace <id>]   Requests waiting for a decision
  buckle approvals --watch [--workspace <id>]    Ask about each request as it arrives
  buckle approvals show <token> [--json] [--workspace <id>]
                                   One request whole, and the code_run script that made it
  buckle approve <token> [--scope once|session|always] [--host '*.example.com'] [--deny] [--workspace <id>]
                                   Shows the whole action, then approves only once you confirm at a terminal
  buckle check-url <url|host> [--session <id>] [--workspace <id>]   Exits 0 approved, 1 denied, 3 asks, 4 not listed
  buckle grants list | revoke <id>
  buckle workspace init [--dir <path>] [--name <name>] | list | show [--json]
  buckle workspace enable <id> | disable <id> | remove <id> [--purge] | set <key> <value> | unset <key>
  buckle workspace token create [--label <text>] | list | revoke <token-id>
  buckle workspaces list | inspect <id> | publish <id> | discard <id> | prune
  buckle history list | restore <id> | restore-stage <stage> <session> | recover <id> | prune
  buckle log [--limit N] [--json]    Show what this node actually did
  buckle plugin list | add <id> <specifier> | remove <id>
  buckle policy show | allow-command | deny-command | allow-url | mount | ...
  buckle policy deny-tool <tool> | allow-tool <tool>   Refuse a tool outright, or lift that
  buckle policy dangerously-allow on|off
                                   DANGEROUS: allow every ask in the workspace without a person,
                                   sensitive files and file writes included; each use is audited,
                                   and deny rules still refuse. See buckle policy --help
  buckle settings show | set <key> <value> | unset <key>   Node settings in the environment file
  buckle keys enroll <public-key> --purpose <p> --workspace <w> | list | revoke <key-id>
                                   Client keys trusted for signed setup and approvals, by scope
  buckle client keygen | key | request <METHOD> <url> | approve <node-url> <token>
                                   This device's signing key, a signed request with it, and a signed approval

  buckle --version                   Print the version
  buckle <command> --skip-owner-only-check   Warn about, rather than refuse, a state directory or key file other users can reach
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
    // A script's call names the code_run call whose script made it (final review of 0.1.4, finding invoker 701).
    if (entry.parentRequestId) process.stdout.write(`    parent request: ${printable(entry.parentRequestId)}\n`)
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
  config: NodeConfig
  runtime: BuckleRuntime
  argv: string[]
}

/**
 * The queue a person answers from. `buckle approve` needs a token, and a request only reaches a
 * terminal when a prompt was on screen there, so without this the tokens waiting on a node were
 * readable through the admin API alone.
 */
const APPROVALS_USAGE = 'Usage: buckle approvals [--json] [--watch] [--workspace <id>], or buckle approvals show <token> [--json] [--workspace <id>]'

function approvalsArguments(argv: string[]) {
  return parseArgs({ args: argv, options: { json: { type: 'boolean' }, watch: { type: 'boolean' } }, allowPositionals: true })
}

/** Why the arguments name no listing, no watch and no single ask, or null. */
function approvalsRefusal({ values, positionals }: ReturnType<typeof approvalsArguments>): string | null {
  const [action, token, ...extra] = positionals
  if (action !== undefined && (action !== 'show' || token === undefined || extra.length > 0 || values.watch)) return APPROVALS_USAGE
  if (values.watch && values.json) return '--watch asks in the terminal, so it takes no --json'
  return null
}

async function approvals(input: CommandInput): Promise<CliResult> {
  const parsed = approvalsArguments(input.argv)
  const refusal = approvalsRefusal(parsed)
  if (refusal) return fail(refusal)
  const { values, positionals: [, token] } = parsed
  const { runtime } = input
  if (token !== undefined) return showAsk({ runtime, token, json: values.json === true, node: input.config.serverId })
  if (values.watch) return watch({ runtimes: async () => [runtime], pinned: runtime.workspaceId })
  if (values.json) return print(listingOf(runtime))
  const waiting = runtime.approvalService.waiting()
  if (waiting.length === 0) process.stdout.write(`Nothing is waiting for a decision in workspace ${runtime.workspaceId}.\n`)
  else printWaiting({ runtime, waiting, node: input.config.serverId })
  return { exitCode: 0 }
}

/** `buckle approvals` over several workspaces (Q9): each one's asks under its name, or one line where none waits. */
async function approvalsAcross(input: { runtimes: BuckleRuntime[]; workspaces: WorkspaceManager; config: NodeConfig; argv: string[] }): Promise<CliResult> {
  const parsed = approvalsArguments(input.argv)
  const refusal = approvalsRefusal(parsed)
  if (refusal) return fail(refusal)
  if (parsed.values.watch) {
    const told = new Set<string>()
    return watch({ runtimes: () => onlineRuntimes(input.workspaces, told) })
  }
  if (parsed.values.json) return print(input.runtimes.flatMap(listingOf))
  let any = false
  for (const runtime of input.runtimes) {
    const waiting = runtime.approvalService.waiting()
    if (waiting.length === 0) continue
    any = true
    process.stdout.write(`Workspace ${workspaceLabel(runtime.workspaceId, runtime.workspaceName())}:\n`)
    printWaiting({ runtime, waiting, node: input.config.serverId })
  }
  if (!any) process.stdout.write(`Nothing is waiting for a decision in any online workspace (${input.runtimes.map(runtime => runtime.workspaceId).join(', ')}).\n`)
  return { exitCode: 0 }
}

/**
 * One workspace's asks as `buckle approvals --json` lists them: the whole call each came from (owner decision D17),
 * redacted and never cut, once per request group: each ask names it by callRef and the group's first carries it
 * (review M1 of the slice 5 re-review). An ask recorded before this build has none, and is listed with the command
 * that denies it (review L6 of the slice 5 re-review).
 */
function listingOf(runtime: BuckleRuntime) {
  return runtime.approvalService.listing().map((entry) => {
    const { callRef, call, ...request } = entry
    // An ask whose whole call is listed, inline or by its group's callRef, is approvable (review L5 of the continuation review).
    const shown = callRef !== undefined || call !== undefined
    const command = shown ? { approveCommand: approveCommand({ request, workspaceId: runtime.workspaceId }) } : { denyCommand: denyCommand({ request, workspaceId: runtime.workspaceId }) }
    return { ...request, workspaceId: runtime.workspaceId, workspaceName: runtime.workspaceName(), ...command, ...(callRef === undefined ? {} : { callRef }), ...(call === undefined ? {} : { call }) }
  })
}

/** One workspace's waiting asks as `buckle approvals` prints them, each group's whole action once, with its first ask. */
function printWaiting(input: { runtime: BuckleRuntime; waiting: PendingAsk[]; node: string }): void {
  const { runtime } = input
  const shownWith = new Map<string, string>()
  for (const { request, call, callRef } of input.waiting) {
    process.stdout.write(`${request.token}  ${printable(request.tool)}\n`)
    process.stdout.write(`    ${request.rule}: ${printable(request.subject)}\n`)
    process.stdout.write(`    ${printable(request.reason)}\n`)
    process.stdout.write(`    scopes: ${request.offeredScopes.join(' | ')}\n`)
    process.stdout.write(`    ${describeExpiry(request.expiresAt)}\n`)
    const shown = shownCall(call)
    // An ask recorded before this build is denied or re-sent, never approved (owner decision D17).
    process.stdout.write(`    ${shown ? approveCommand({ request, workspaceId: runtime.workspaceId }) : denyCommand({ request, workspaceId: runtime.workspaceId })}\n`)
    const earlier = callRef === undefined ? undefined : shownWith.get(callRef)
    const action = !shown
      ? [`  ${RECORDED_BEFORE_NOTE}`]
      : earlier !== undefined
        ? [`  ${sameCallNote(earlier)}`]
        : describeAction({ node: input.node, workspace: workspaceLabel(runtime.workspaceId, runtime.workspaceName()), rule: request.rule, subject: request.subject, reason: request.reason, ...shown })
    if (shown && callRef !== undefined && earlier === undefined) shownWith.set(callRef, request.token)
    process.stdout.write(`${action.map(line => `  ${line}`).join('\n')}\n`)
  }
}

/**
 * One ask whole, as `buckle approve` shows it, deciding nothing; for a call a code_run script made, the script's text
 * too, which the audit log keeps only the size of, from the record kept at the ask. The call shown whole is what is
 * approved (owner decision D17); the script is its context (review of the code-mode slice, coordinator decision 4).
 */
function showAsk(input: { runtime: BuckleRuntime; token: string; json: boolean; node: string }): CliResult {
  const { runtime, token } = input
  const ask = runtime.approvalService.waitingAsk(token)
  if (!ask) return fail(`Nothing named ${printable(token)} is waiting for a decision in workspace ${runtime.workspaceId}`)
  const script = runtime.scriptOfAsk(token)
  if (input.json) return print({ ...ask.request, workspaceId: runtime.workspaceId, ...(ask.call ? { call: ask.call } : {}), ...(script === null ? {} : { script }) })
  process.stdout.write(`${token}\n${describeWaitingAsk({ ask, node: input.node, runtime }).join('\n')}\n`)
  if (script !== null) process.stdout.write(`\nThe code_run script that made this call:\n${script.split('\n').map(printable).join('\n')}\n`)
  else if (ask.call?.description?.startsWith(SCRIPT_CALL_NOTE)) process.stdout.write('\nA code_run script made this call. Its text is kept for ten minutes once the script stops at this ask; while the call still waits inside the script, it is not kept yet.\n')
  return { exitCode: 0 }
}

/**
 * Asks about each request as it arrives, in a terminal of its own beside `buckle serve`. A Ctrl-C
 * that reaches the process as a signal, where readline is not reading keys, stops it the same way.
 * Each answer is audited in the node's log, where `buckle approve` records its own.
 */
async function watch(input: { runtimes: () => Promise<BuckleRuntime[]>; pinned?: string }): Promise<CliResult> {
  // The action and the prompt go to stdout, so both ends must be a terminal, as terminalConfirm requires for buckle
  // approve: with stdout redirected a key would grant an action never seen (review L2 of the continuation review).
  if (!process.stdin.isTTY || !process.stdout.isTTY) return fail(`buckle approvals --watch needs a terminal to ask in, on both its input and its output. ${noTerminal(input.pinned)}`)
  const interrupted = new AbortController()
  const interrupt = () => interrupted.abort()
  process.once('SIGINT', interrupt)
  try {
    const sources = async () => (await input.runtimes()).map(runtime => ({ approvals: runtime.approvalService, actions: runtime.actions, workspaceId: runtime.workspaceId, workspaceName: runtime.workspaceName() }))
    return await watchApprovals({ sources, input: process.stdin, output: process.stdout, errors: process.stderr, signal: interrupted.signal })
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
const APPROVE_USAGE = "Usage: buckle approve <token> [--scope once|session|always] [--host '*.example.com'] [--deny] [--workspace <id>]"

function approveArguments(argv: string[]) {
  return parseArgs({ args: argv, options: { scope: { type: 'string' }, deny: { type: 'boolean' }, host: { type: 'string' } }, allowPositionals: true })
}

async function approve(input: CommandInput & { confirm: Confirm | null }): Promise<CliResult> {
  const { positionals, values } = approveArguments(input.argv)
  const token = positionals[0]
  if (!token) return fail(APPROVE_USAGE)

  const scope = GrantScopeSchema.safeParse(values.scope ?? 'once')
  if (!scope.success) return fail(`Invalid scope: ${values.scope}`)

  const { runtime } = input
  // The named ask alone, and its call file alone, however many asks its call made (review M1 of the slice 5 re-review).
  const ask = runtime.approvalService.waitingAsk(token)
  if (ask) process.stdout.write(`${token}\n${describeWaitingAsk({ ask, node: input.config.serverId, runtime }).join('\n')}\n`)
  // A token no longer waiting reaches the queue as it is: it can repeat the decision already recorded, and decide nothing new.
  if (values.deny !== true && ask) {
    if (!ask.call?.complete) return fail(`Not approved: ${printable(token)} was ${RECORDED_BEFORE_NOTE}. Deny it with ${denyCommand({ request: ask.request, workspaceId: runtime.workspaceId })}`)
    if (!input.confirm) return fail(`Not approved: buckle approve records an approval only after a person at a terminal confirms the action above, and this process's input and output are not both a terminal. ${noTerminal(runtime.workspaceId)}`)
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
  return reportResponse({ response, workspaceId: runtime.workspaceId, workspaceName: runtime.workspaceName() })
}

/**
 * Where a decision goes when this process has no terminal (review L12 of the slice 5 re-review): approving takes a
 * person at a terminal, or a person's device where the node serves its admin face; denying works anywhere.
 */
function noTerminal(workspaceId?: string): string {
  const named = workspaceId === undefined ? '' : ` --workspace ${workspaceId}`
  return `At a terminal, answer asks in buckle approvals --watch${named}, or approve one with buckle approve <token>${named}, which shows the action and asks to confirm. Without one, list them with buckle approvals${named} and deny one with buckle approve <token> --deny${named}. Where the node sets BUCKLE_EXPERIMENTAL_ADMIN_HTTP=true, a person's enrolled device approves with buckle client approve <node-url> <token>${named}.`
}

/** One waiting ask, followed by its whole action before a decision. */
function describeWaitingAsk(input: { ask: PendingAsk; node: string; runtime: BuckleRuntime }): string[] {
  const { request, call } = input.ask
  return describeAsk({ ...request, workspaceId: input.runtime.workspaceId, workspaceName: input.runtime.workspaceName(), node: input.node, ...(call?.complete ? { call } : {}) })
}

function reportResponse(input: { response: InvokeResponse; workspaceId: string; workspaceName: string }): CliResult {
  const { response } = input
  if (response.outcome === 'ok') return print(response.output)

  if (response.outcome === 'approval_required') {
    // Leads with buckle approvals, which shows the whole action, and names buckle approve after it (owner decision D17).
    for (const approval of response.approvals) {
      const [first, ...rest] = describeApprovalRequest({ request: approval, workspaceId: input.workspaceId, workspaceName: input.workspaceName })
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
    notRestorable: checkpoint.notRestorable.map(printable),
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
