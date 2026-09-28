import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { destructivePatterns, emptyWorkspacePolicy, isWorkspaceToolAllowed, ToolNameSchema, WorkspacePolicySchema, type WorkspacePolicy } from '@5straps/protocol'
import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { createFilePolicyStore } from '../common/adapters/policy-store/file-policy-store.js'
import { clearKeepingDangerouslyAllow, compilePolicy, mergePolicies, PolicyError, type StoredPolicyError } from '../common/domain/policy.js'
import { actionsPath, policyPath, type BuckleConfig } from '../common/runtime/config.js'
import { auditOperation } from '../common/services/audit/audit-operation.js'
import type { WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'

export interface CliResult {
  exitCode: number
  /** For the audit entry: the tool a switch names. Other policy arguments stay out of the log. */
  detail?: string
}

const USAGE = `Usage:
  buckle policy show [--json]                 The effective policy and where each part came from
  buckle policy allow-command <glob>          Only matching command lines may run
  buckle policy deny-command <glob>           Matching command lines are refused; deny wins
  buckle policy destructive-command <glob>    Matching command lines ask first, once or per session
  buckle policy allow-url <host|url-prefix>   Only listed hosts and URLs may be reached
  buckle policy mount <path> | unmount        Show the workspace to the agent as this path
  buckle policy deny-tool <tool>              Refuse this tool outright, whatever its pack allows
  buckle policy allow-tool <tool>             Lift that refusal; a tool in a withheld pack stays withheld
  buckle policy remove <pattern>              Drop a pattern from every list
  buckle policy import <file.json>            Replace the stored policy from a file
  buckle policy export                        Print the stored policy as JSON
  buckle policy clear                         Drop the stored policy, leaving the environment's
  buckle policy dangerously-allow on|off [--workspace <id>]
                                              DANGEROUS: allow every ask in the workspace without a
                                              person, sensitive files and file writes included; each
                                              use is audited, and deny rules still refuse

A command glob is matched one shell word at a time. 'pnpm {build,test} *' allows 'pnpm build'
with any arguments after it: * stands for one word, and a trailing * for the rest of the line.
An allow glob must cover the whole line; a deny glob covers every line starting with it.
`

/**
 * Edits the stored policy for this workspace. Each change is validated as the union with the
 * environment's share before it is written, so a bad pattern never lands.
 */
export async function policyCommand(runtime: BuckleRuntime, argv: string[], workspaces: WorkspaceManager): Promise<CliResult> {
  const [action, ...rest] = argv
  const current = (): WorkspacePolicy => runtime.policy.stored() ?? emptyWorkspacePolicy()

  try {
    switch (action) {
      case undefined:
      case 'show':
        return show(runtime, rest)
      case 'allow-command':
        return await save(runtime, edit(current(), policy => policy.commands.allow.push(required(rest[0], action))))
      case 'deny-command':
        return await save(runtime, edit(current(), policy => policy.commands.deny.push(required(rest[0], action))))
      case 'destructive-command':
        return await save(runtime, edit(current(), policy => { policy.commands.destructive = [...destructivePatterns(policy), required(rest[0], action)] }))
      case 'allow-url':
        return await save(runtime, edit(current(), policy => policy.network.allow.push(required(rest[0], action))))
      case 'mount':
        return await save(runtime, edit(current(), policy => { policy.mount = required(rest[0], action) }))
      case 'unmount':
        return await save(runtime, edit(current(), policy => { policy.mount = null }))
      case 'deny-tool':
        return await saveTool(runtime, action, toolName(rest[0], action), edit(current(), policy => denyTool(policy, toolName(rest[0], action))))
      case 'allow-tool':
        return await saveTool(runtime, action, toolName(rest[0], action), edit(current(), policy => allowTool(policy, toolName(rest[0], action))))
      case 'remove': {
        const before = current()
        const next = remove(before, required(rest[0], action))
        const result = await save(runtime, next)
        if (result.exitCode === 0 && opensNetwork(before, next, runtime.policy.base())) process.stdout.write(EMPTY_LIST_WARNING)
        return result
      }
      case 'import':
        return await save(runtime, WorkspacePolicySchema.parse(JSON.parse(readFileSync(required(rest[0], action), 'utf8'))))
      case 'export':
        return print(runtime.policy.stored() ?? emptyWorkspacePolicy())
      case 'clear':
        await runtime.policy.clear()
        process.stdout.write('Stored policy cleared\n')
        if (runtime.policy.dangerouslyAllow().on) process.stdout.write('The dangerously-allow switch stays on: only `buckle policy dangerously-allow off` turns it off.\n')
        return { exitCode: 0 }
      case 'dangerously-allow':
        return await dangerouslyAllow({ runtime, workspaces, argv: rest })
      default:
        process.stderr.write(USAGE)
        return { exitCode: 1 }
    }
  } catch (error) {
    if (error instanceof PolicyError || error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`)
      return { exitCode: 1 }
    }
    throw error
  }
}

/**
 * The one switch for a workspace's dangerously-allow flags (rulings 11 and H1 of 2026-09-28), local
 * only (H1e). It needs no restart: a running node reads it at every call. A registered workspace's
 * switch takes effect only while the node's own is on too.
 */
async function dangerouslyAllow(input: { runtime: BuckleRuntime; workspaces: WorkspaceManager; argv: string[] }): Promise<CliResult> {
  const { values, positionals } = parseArgs({ args: input.argv, options: { workspace: { type: 'string' } }, allowPositionals: true })
  const [state] = positionals
  if ((state !== 'on' && state !== 'off') || positionals.length !== 1) throw new UsageError(`buckle policy dangerously-allow takes on or off\n${USAGE}`)
  const target = !values.workspace || values.workspace === 'default' ? input.runtime : (await input.workspaces.resolve(values.workspace, { setup: true })).runtime
  await target.policy.setDangerouslyAllow(state === 'on')
  const now = target.policy.dangerouslyAllow()
  if (!now.on) process.stdout.write(`Dangerously allow is off for workspace ${target.workspaceId}: asks wait for a person again.\n`)
  else {
    process.stdout.write(`WARNING: dangerously allow is on for workspace ${target.workspaceId}. Every ask there is allowed without a person, sensitive files and file writes included. Each use is audited as policy_dangerously_allowed; deny rules, the node's own policy and the mount boundary still refuse.\n`)
    if (now.allowedByNode === false) process.stdout.write('It has no effect until the node\'s own switch is on too: buckle policy dangerously-allow on\n')
  }
  return { exitCode: 0, detail: `dangerously-allow ${state}${values.workspace ? ` ${values.workspace}` : ''}` }
}

/**
 * For a stored policy the node cannot load: `show`, `export`, `remove` and `clear` work on the
 * store alone, so the owner can repair it with `buckle policy`. Every other action refuses.
 */
export function repairStoredPolicy(input: { config: BuckleConfig; argv: string[]; failure: StoredPolicyError }): Promise<CliResult> {
  return auditOperation({
    actions: createFileActionLog(actionsPath(input.config)), workspaceId: 'default', tool: 'cli_policy', sessionId: 'local-owner',
    isSuccessful: result => result.exitCode === 0, operation: () => repairStoredPolicyAction(input),
  })
}

async function repairStoredPolicyAction(input: { config: BuckleConfig; argv: string[]; failure: StoredPolicyError }): Promise<CliResult> {
  const { config, failure } = input
  const store = createFilePolicyStore({ filePath: policyPath(config), workspace: config.cwd })
  const stored = store.read() ?? emptyWorkspacePolicy()
  const [action, ...rest] = input.argv
  try {
    switch (action) {
      case 'remove': {
        const next = remove(stored, required(rest[0], action))
        compilePolicy(mergePolicies(config.policy, next))
        await store.write({ ...next, updatedAt: new Date().toISOString() })
        process.stdout.write('Stored policy repaired; the node loads it again.\n')
        if (opensNetwork(stored, next, config.policy)) process.stdout.write(EMPTY_LIST_WARNING)
        return { exitCode: 0 }
      }
      case 'clear':
        await store.update(current => clearKeepingDangerouslyAllow(current, new Date().toISOString()))
        process.stdout.write('Stored policy cleared\n')
        return { exitCode: 0 }
      case 'export':
        return print(stored)
      case undefined:
      case 'show':
        process.stderr.write(`${failure.message}\n`)
        print(stored)
        return { exitCode: 1 }
      default:
        process.stderr.write(`${failure.message}\n`)
        return { exitCode: 1 }
    }
  } catch (error) {
    if (error instanceof PolicyError || error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`)
      return { exitCode: 1 }
    }
    throw error
  }
}

const EMPTY_LIST_WARNING = 'The approved list is now empty, which is no list: the default network rules reach public hosts. Add an entry with `buckle policy allow-url <host>` to restrict it again.\n'

/**
 * A stored approved list and an absent one read the same when empty: no list, so the network rule
 * falls back to its defaults. Emptying a list that reached nothing therefore opens the node,
 * unless the environment still names entries of its own.
 */
function opensNetwork(before: WorkspacePolicy, after: WorkspacePolicy, environment: WorkspacePolicy): boolean {
  return before.network.allow.length > 0 && after.network.allow.length === 0 && environment.network.allow.length === 0
}

class UsageError extends Error {}

function required(value: string | undefined, action: string): string {
  if (!value) throw new UsageError(`buckle policy ${action} needs an argument\n${USAGE}`)
  return value
}

function edit(policy: WorkspacePolicy, change: (policy: WorkspacePolicy) => void): WorkspacePolicy {
  const next = structuredClone(policy)
  change(next)
  return next
}

function remove(policy: WorkspacePolicy, pattern: string): WorkspacePolicy {
  return edit(policy, next => {
    next.commands.allow = next.commands.allow.filter(item => item !== pattern)
    next.commands.deny = next.commands.deny.filter(item => item !== pattern)
    next.commands.destructive = destructivePatterns(next).filter(item => item !== pattern)
    next.network.allow = next.network.allow.filter(item => item !== pattern)
  })
}

function toolName(value: string | undefined, action: string): string {
  const parsed = ToolNameSchema.safeParse(required(value, action))
  if (!parsed.success) throw new UsageError(`${value} is not a tool name, such as fs_write or shell_exec`)
  return parsed.data
}

function denyTool(policy: WorkspacePolicy, tool: string): void {
  const deny = policy.tools?.deny ?? []
  policy.tools = { ...(policy.tools?.allow !== undefined ? { allow: policy.tools.allow } : {}), deny: deny.includes(tool) ? deny : [...deny, tool] }
}

/** A stored allow list that leaves the tool out would still refuse it, so the tool joins that list too. */
function allowTool(policy: WorkspacePolicy, tool: string): void {
  if (!policy.tools) return
  const allow = policy.tools.allow
  policy.tools = { ...(allow !== undefined ? { allow: allow.includes(tool) ? allow : [...allow, tool] } : {}), deny: policy.tools.deny.filter(name => name !== tool) }
}

/**
 * Saves a per-tool switch, then says what still decides the tool: the pack gates run first, so
 * `allow-tool` never brings back a tool its pack withholds, and the node's own policy over a
 * registered workspace can still refuse it.
 */
async function saveTool(runtime: BuckleRuntime, action: string, tool: string, policy: WorkspacePolicy): Promise<CliResult> {
  const result = await save(runtime, policy)
  const pack = runtime.manifest().packs.find(candidate => candidate.toolNames.includes(tool))
  if (!pack) process.stdout.write(`\n${tool} is not a tool on this node now; the switch is stored and applies if a pack brings it.\n`)
  else if (pack.unavailableReason) process.stdout.write(`\n${tool} stays unavailable: its pack ${pack.id} is withheld. ${pack.unavailableReason}\n`)
  const ceiling = runtime.policy.ceiling()
  if (ceiling && !isWorkspaceToolAllowed(ceiling, tool)) process.stdout.write(`\n${tool} stays refused by the node's own tool policy over this workspace.\n`)
  return { ...result, detail: `${action} ${tool}` }
}

async function save(runtime: BuckleRuntime, policy: WorkspacePolicy): Promise<CliResult> {
  await runtime.policy.apply(policy)
  return show(runtime, [])
}

function show(runtime: BuckleRuntime, argv: string[]): CliResult {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' } }, allowPositionals: false })
  const effective = runtime.policy.effective()
  const base = runtime.policy.base()
  const stored = runtime.policy.stored()
  const dangerously = runtime.policy.dangerouslyAllow()
  if (values.json) return print({ effective, base, stored, dangerouslyAllow: dangerously })

  const origin = (list: (policy: WorkspacePolicy) => string[], item: string): string => {
    const fromBase = list(base).includes(item)
    const fromStored = stored ? list(stored).includes(item) : false
    return fromBase && fromStored ? 'env+stored' : fromBase ? 'env' : 'stored'
  }
  const section = (title: string, items: string[], list: (policy: WorkspacePolicy) => string[]): void => {
    process.stdout.write(`${title}\n`)
    if (items.length === 0) process.stdout.write('  (none)\n')
    for (const item of items) process.stdout.write(`  ${item.padEnd(48)} ${origin(list, item)}\n`)
  }

  process.stdout.write(`Workspace ${runtime.paths().root}\n`)
  process.stdout.write(`Mount     ${effective.mount ?? '(none: the real path shows through)'}\n`)
  process.stdout.write(`Dangerously allow  ${describeDangerously(dangerously)}\n\n`)
  section('Command allow list (only these may run)', effective.commands.allow, policy => policy.commands.allow)
  section('Command deny list (refused outright)', effective.commands.deny, policy => policy.commands.deny)
  section('Destructive additions (these ask, on top of the built-in floor)', destructivePatterns(effective), destructivePatterns)
  section('Approved hosts and URLs (only these may be reached)', effective.network.allow, policy => policy.network.allow)
  section('Denied tools (refused outright, whatever the pack allows)', effective.tools?.deny ?? [], policy => policy.tools?.deny ?? [])
  if (effective.tools?.allow !== undefined) section('Tool allow list (only these tools may run)', effective.tools.allow, policy => policy.tools?.allow ?? [])
  process.stdout.write(`\nStored ${stored?.updatedAt ? `at ${stored.updatedAt}` : 'nothing'}; environment and stored parts are unioned.\n`)
  return { exitCode: 0 }
}

function describeDangerously(state: { on: boolean; allowedByNode: boolean | null; effective: boolean }): string {
  if (!state.on) return 'off'
  return state.effective ? 'ON: every ask is allowed without a person, and each use is audited' : 'on, without effect: the node\'s own switch is off'
}

function print(value: unknown): CliResult {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  return { exitCode: 0 }
}
