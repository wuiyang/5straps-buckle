import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { allowedInterpreters, destructivePatterns, emptyWorkspacePolicy, ToolNameSchema, WorkspacePolicySchema, type WorkspacePolicy } from '@5straps/protocol'
import { INTERPRETER_NAMES, isInterpreter } from '../common/domain/command-forms.js'
import { isRestrictive, PolicyError, refuseSwitchIn, type StoredPolicyError } from '../common/domain/policy.js'
import { scratchOverFolderNote, scratchRootOverFolder } from '../common/domain/sandbox-mounts.js'
import { DANGEROUSLY_ALLOW_SCOPE } from '../common/domain/permission/rules/dangerously-allow.js'
import { auditOperation } from '../common/services/audit/audit-operation.js'
import { WorkspaceError, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { ownMount, withPolicy, WorkspaceSettingsInvalidError, type FloorEntries, type SettingSource } from '../common/services/workspaces/workspace-settings.js'
import type { CommandTarget } from './target.js'

export interface CliResult {
  exitCode: number
  /** For the audit entry: the tool a switch names. Other policy arguments stay out of the log. */
  detail?: string
}

const USAGE = `Usage: buckle policy <action> [--workspace <name> | --dir <path>]
Acts on the workspace named, or else on the one whose folder holds the current directory.

  buckle policy show [--json]                 The workspace's policy
  buckle policy allow-command <glob>          Only matching command lines may run
  buckle policy deny-command <glob>           Matching command lines are refused; deny wins
  buckle policy destructive-command <glob>    Matching command lines ask first, once or per session
  buckle policy allow-interpreter <name>      Read calls of this interpreter (python3, node) as ordinary
                                              commands; any other runs code Buckle cannot read
  buckle policy remove-interpreter <name>     Read that interpreter as unknown again
  buckle policy allow-url <host|url-prefix>   Only listed hosts and URLs may be reached
  buckle policy mount <path> | unmount        Show the workspace to the agent as this path
  buckle policy deny-tool <tool>              Refuse this tool outright, whatever its pack allows
  buckle policy allow-tool <tool>             Lift that refusal; a tool in a withheld pack stays withheld
  buckle policy remove <pattern>              Drop a pattern from every list
  buckle policy import <file.json>            Replace the workspace's policy from a file
  buckle policy export                        Print the workspace's policy as JSON
  buckle policy clear                         Empty every list
  buckle policy dangerously-allow on|off      DANGEROUS: allow every ask in the workspace without a
                                              person, sensitive files and file writes included, bound
                                              to the workspace root, or its mount when one is set;
                                              each use is audited, and deny rules still refuse

Exits 0 when done, 1 when the node refuses the change or the input, and 2 when the change conflicts
with the node's state (the refusals the setup face answers 409): active work, or a policy file that
names the dangerously-allow switch.

A command glob is matched one shell word at a time. 'pnpm {build,test} *' allows 'pnpm build'
with any arguments after it: * stands for one word, and a trailing * for the rest of the line.
An allow glob must cover the whole line; a deny glob covers every line starting with it.
`

/**
 * Edits the policy of the workspace the command targets (D83 addendum (7)), in its workspace.json. Each change is
 * compiled whole before it is written, so a bad pattern never lands.
 */
export async function policyCommand(runtime: BuckleRuntime, argv: string[]): Promise<CliResult> {
  const [action, ...rest] = argv
  const current = (): WorkspacePolicy => runtime.policy.stored()

  try {
    refuseUnknownFlags(action, rest)
    refuseExtraArguments(action, rest)
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
      case 'allow-interpreter': {
        const name = interpreterName(rest[0], action)
        return await save(runtime, edit(current(), policy => { policy.commands.allowedInterpreters = [...new Set([...allowedInterpreters(policy), name])] }))
      }
      case 'remove-interpreter': {
        const name = interpreterName(rest[0], action)
        return await save(runtime, edit(current(), policy => { policy.commands.allowedInterpreters = allowedInterpreters(policy).filter(item => item !== name) }))
      }
      case 'allow-url':
        return await save(runtime, edit(current(), policy => policy.network.allow.push(required(rest[0], action))))
      case 'mount': {
        await runtime.policy.setMount(required(rest[0], action))
        // Fix brief 6, item 3: a node scratch root holding the folder now shows it a second time, which the shell refuses.
        const holding = scratchRootOverFolder(runtime.paths())
        if (holding !== null) process.stdout.write(`${scratchOverFolderNote({ scratchRoot: holding, workspace: runtime.workspaceName() })}\n`)
        return show(runtime, [])
      }
      case 'unmount':
        await runtime.policy.setMount(null)
        return show(runtime, [])
      case 'deny-tool':
        return await saveTool(runtime, action, toolName(rest[0], action), edit(current(), policy => denyTool(policy, toolName(rest[0], action))))
      case 'allow-tool':
        return await saveTool(runtime, action, toolName(rest[0], action), edit(current(), policy => allowTool(policy, toolName(rest[0], action))))
      case 'remove': {
        const before = current()
        const next = remove(before, required(rest[0], action))
        const result = await save(runtime, next)
        // An emptied list of its own is the node's again; only a workspace that ends with no list at all is open.
        if (result.exitCode === 0 && opensNetwork(before, next)) process.stdout.write(runtime.policy.effective().network.allow.length > 0 ? NODE_LIST_NOTE : EMPTY_LIST_WARNING)
        return result
      }
      case 'import': {
        const document: unknown = JSON.parse(readFileSync(required(rest[0], action), 'utf8'))
        refuseSwitchIn(document)
        return await save(runtime, WorkspacePolicySchema.parse(document))
      }
      case 'export':
        return print(runtime.policy.stored())
      case 'clear':
        await runtime.policy.clear()
        process.stdout.write(`Every list of workspace ${runtime.workspaceName()} is empty\n`)
        if (isRestrictive({ ...runtime.policy.effective(), mount: null })) process.stdout.write('The node\'s lists in buckle.env apply in their place, and its deny lists apply to every workspace: buckle policy show lists them.\n')
        if (runtime.policy.dangerouslyAllow().on) process.stdout.write('The dangerously-allow switch is apart from the policy and stays on: only `buckle policy dangerously-allow off` turns it off.\n')
        return { exitCode: 0 }
      case 'dangerously-allow':
        return await dangerouslyAllow({ runtime, argv: rest })
      case 'help':
      case '--help':
      case '-h':
        // Asking for the usage is not an error, so it prints to stdout and exits 0.
        process.stdout.write(USAGE)
        return { exitCode: 0 }
      default:
        process.stderr.write(USAGE)
        return { exitCode: 1 }
    }
  } catch (error) {
    if (error instanceof PolicyError || error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`)
      return { exitCode: exitCodeOf(error) }
    }
    // Moving or taking away where the folder shows while its mounts need it (withMount).
    if (error instanceof WorkspaceSettingsInvalidError) {
      process.stderr.write(`${error.message}\n`)
      return { exitCode: 1 }
    }
    throw error
  }
}

/** A conflict with the node's state exits 2, the CLI's form of the setup face's 409; any other refusal exits 1. */
function exitCodeOf(error: PolicyError | UsageError): number {
  return error instanceof PolicyError && error.status === 409 ? 2 : 1
}

/**
 * The one switch for a workspace's dangerously-allow flag (rulings 11 and H1 of 2026-09-28), local only (H1e), for
 * the workspace the command targets alone: no node switch stands beside it (Q14). It needs no restart: a running node
 * reads it at every call.
 */
async function dangerouslyAllow(input: { runtime: BuckleRuntime; argv: string[] }): Promise<CliResult> {
  const [state, ...extra] = input.argv
  if ((state !== 'on' && state !== 'off') || extra.length > 0) throw new UsageError(`buckle policy dangerously-allow takes on or off\n${USAGE}`)
  const target = input.runtime
  await target.policy.setDangerouslyAllow(state === 'on')
  const now = target.policy.dangerouslyAllow()
  if (!now.on) process.stdout.write(`Dangerously allow is off for workspace ${target.workspaceName()}: asks wait for a person again.\n`)
  else process.stdout.write(`WARNING: dangerously allow is on for workspace ${target.workspaceName()}, ${DANGEROUSLY_ALLOW_SCOPE} (${now.boundTo}). ${DANGEROUSLY_ALLOW_COVERS} Each use is audited as policy_dangerously_allowed; deny rules still refuse.\n`)
  return { exitCode: 0, detail: `dangerously-allow ${state} ${target.workspaceName()}` }
}

/**
 * For a workspace whose stored policy will not load: `show`, `export`, `remove` and `clear` work on its workspace.json
 * alone, so the owner can repair it with `buckle policy`. Every other action refuses. Audited in the node's log.
 */
export function repairStoredPolicy(input: { workspaces: WorkspaceManager; target: CommandTarget; cwd: string; argv: string[]; failure: StoredPolicyError }): Promise<CliResult> {
  let id: string
  try { id = input.workspaces.target({ ...input.target, cwd: input.cwd }) } catch (error) {
    if (error instanceof WorkspaceError) return Promise.resolve(failed(error.message))
    throw error
  }
  return auditOperation({
    actions: input.workspaces.nodeActions, workspaceId: id, tool: 'cli_policy', sessionId: 'local-owner',
    isSuccessful: result => result.exitCode === 0, operation: () => repairStoredPolicyAction({ ...input, id }),
  })
}

async function repairStoredPolicyAction(input: { workspaces: WorkspaceManager; id: string; argv: string[]; failure: StoredPolicyError }): Promise<CliResult> {
  const { workspaces, id, failure } = input
  const settings = workspaces.settings(id)
  const stored: WorkspacePolicy = { ...settings.policy, mount: ownMount(settings) ?? null }
  const [action, ...rest] = input.argv
  try {
    refuseUnknownFlags(action, rest)
    refuseExtraArguments(action, rest)
    switch (action) {
      case 'remove': {
        const next = remove(stored, required(rest[0], action))
        await workspaces.updateSettings(id, current => withPolicy(current, { ...next, updatedAt: new Date().toISOString() }))
        process.stdout.write('Stored policy repaired; the workspace loads it again.\n')
        if (opensNetwork(stored, next)) process.stdout.write(EMPTY_LIST_WARNING)
        return { exitCode: 0 }
      }
      case 'clear':
        await workspaces.updateSettings(id, current => withPolicy(current, { ...emptyWorkspacePolicy(), updatedAt: new Date().toISOString() }))
        process.stdout.write(`Every list of workspace ${workspaces.lookup(id)?.name ?? id} is empty\n`)
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
      return { exitCode: exitCodeOf(error) }
    }
    throw error
  }
}

const EMPTY_LIST_WARNING = 'The approved list is now empty, which is no list: the default network rules reach public hosts. Add an entry with `buckle policy allow-url <host>` to restrict it again.\n'
const NODE_LIST_NOTE = 'The workspace\'s own approved list is now empty, which is no list of its own: the node\'s approved list in buckle.env applies.\n'

/**
 * A stored approved list and an absent one read the same when empty: no list, so the network rule
 * falls back to its defaults. Emptying a list that reached nothing therefore opens the workspace.
 */
function opensNetwork(before: WorkspacePolicy, after: WorkspacePolicy): boolean {
  return before.network.allow.length > 0 && after.network.allow.length === 0
}

class UsageError extends Error {}

/** The actions that take no flag. */
const FLAGLESS_ACTIONS = new Set([
  'allow-command', 'deny-command', 'destructive-command', 'allow-interpreter', 'remove-interpreter', 'allow-url', 'mount', 'unmount',
  'deny-tool', 'allow-tool', 'remove', 'import', 'export', 'clear',
])

/** The actions that parse flags of their own, with the flags each one knows. */
const OWN_FLAGS = new Map<string, readonly string[]>([['show', ['--json']]])

/** The actions that take exactly one argument. */
const ONE_ARGUMENT_ACTIONS = new Set([
  'allow-command', 'deny-command', 'destructive-command', 'allow-interpreter', 'remove-interpreter', 'allow-url', 'mount',
  'deny-tool', 'allow-tool', 'remove', 'import',
])

/**
 * Refuses a flag an action does not know rather than ignoring it: a mistyped `--workspce child` would otherwise be
 * stored as a pattern, or dropped, and the command exit 0 as if it had done what was typed.
 */
function refuseUnknownFlags(action: string | undefined, args: readonly string[]): void {
  if (action === undefined) return
  const known = OWN_FLAGS.get(action)
  if (known === undefined && !FLAGLESS_ACTIONS.has(action) && action !== 'dangerously-allow') return
  const flag = args.find(word => word.length > 1 && word.startsWith('-') && !known?.includes(word.split('=')[0] ?? word))
  if (flag === undefined) return
  throw new UsageError(`buckle policy ${action} does not know the flag ${flag}\n${USAGE}`)
}

/**
 * Refuses words past the one argument rather than dropping them: `deny-command git push*` typed without quotes
 * arrives as two words, and storing the first alone would keep a rule other than the one the owner typed.
 */
function refuseExtraArguments(action: string | undefined, args: readonly string[]): void {
  if (action === undefined || !ONE_ARGUMENT_ACTIONS.has(action) || args.length <= 1) return
  throw new UsageError(`buckle policy ${action} takes one argument, not ${args.length}; to pass a glob or path of several words, quote it as one: buckle policy ${action} ${shellQuote(args.join(' '))}\n${USAGE}`)
}

/** The text as one shell word: single-quoted, with each quote inside it closed, escaped, and reopened. */
function shellQuote(text: string): string {
  return `'${text.replaceAll('\'', '\'\\\'\'')}'`
}

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

/** An interpreter Buckle knows, so a typo is refused rather than stored as an allowance that matches nothing. */
function interpreterName(value: string | undefined, action: string): string {
  const name = required(value, action)
  if (!isInterpreter(name)) throw new UsageError(`${name} is not an interpreter Buckle reads as unknown: ${INTERPRETER_NAMES}`)
  return name
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
 * `allow-tool` never brings back a tool its pack withholds.
 */
async function saveTool(runtime: BuckleRuntime, action: string, tool: string, policy: WorkspacePolicy): Promise<CliResult> {
  const result = await save(runtime, policy)
  const pack = runtime.manifest().packs.find(candidate => candidate.toolNames.includes(tool))
  if (!pack) process.stdout.write(`\n${tool} is not a tool on this node now; the switch is stored and applies if a pack brings it.\n`)
  else if (pack.unavailableReason) process.stdout.write(`\n${tool} stays unavailable: its pack ${pack.id} is withheld. ${pack.unavailableReason}\n`)
  return { ...result, detail: `${action} ${tool}` }
}

async function save(runtime: BuckleRuntime, policy: WorkspacePolicy): Promise<CliResult> {
  await runtime.policy.apply(policy)
  return show(runtime, [])
}

/** Where a part of the policy in force comes from, as `buckle policy show` says it (D85, Q3). */
const SOURCE_WORDS: Readonly<Record<SettingSource, string>> = { 'workspace': 'the workspace\'s own', 'node': 'the node\'s default, from buckle.env', 'built-in': 'Buckle\'s default' }

function show(runtime: BuckleRuntime, argv: string[]): CliResult {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' } }, allowPositionals: false })
  const effective = runtime.policy.effective()
  const sources = runtime.policy.sources()
  const dangerously = runtime.policy.dangerouslyAllow()
  if (values.json) return print({ workspaceId: runtime.workspaceId, effective, sources, dangerouslyAllow: dangerously })

  // An allow-type list is one source whole; a deny-type list names each entry's, the node's being its floor (Q14).
  const section = (title: string, items: string[], source: SettingSource | FloorEntries): void => {
    process.stdout.write(typeof source === 'string' ? `${title}, ${SOURCE_WORDS[source]}\n` : `${title}\n`)
    if (items.length === 0) process.stdout.write('  (none)\n')
    const width = Math.max(0, ...items.map(item => item.length))
    for (const item of items) process.stdout.write(typeof source === 'string' ? `  ${item}\n` : `  ${item.padEnd(width)}  ${source.node.includes(item) ? 'the node\'s, for every workspace' : 'the workspace\'s own'}\n`)
  }

  process.stdout.write(`Workspace ${runtime.workspaceName()} at ${runtime.paths().root}\n`)
  process.stdout.write(`Mount     ${effective.mount ?? '(none: the real path shows through)'}, ${SOURCE_WORDS[sources.mount]}\n`)
  process.stdout.write(`Dangerously allow  ${describeDangerously(dangerously)}\n\n`)
  section('Command allow list (only these may run)', effective.commands.allow, sources['commands.allow'])
  section('Command deny list (refused outright)', effective.commands.deny, sources['commands.deny'])
  section('Destructive additions (these ask, on top of the built-in floor)', destructivePatterns(effective), sources['commands.destructive'])
  section('Allowed interpreters (read as ordinary commands; any other runs unknown code)', allowedInterpreters(effective), sources['commands.allowedInterpreters'])
  section('Approved hosts and URLs (only these may be reached)', effective.network.allow, sources['network.allow'])
  section('Denied tools (refused outright, whatever the pack allows)', effective.tools?.deny ?? [], sources['tools.deny'])
  if (effective.tools?.allow !== undefined) section('Tool allow list (only these tools may run)', effective.tools.allow, sources['tools.allow'])
  process.stdout.write(`\n${effective.updatedAt ? `The workspace's own lists were stored at ${effective.updatedAt}` : 'The workspace has stored no list of its own yet'}. A list of its own replaces the node's, and the node's deny lists apply to every workspace.\n`)
  return { exitCode: 0 }
}

/**
 * What the switch covers, said the same way wherever it is shown (review L15 of B23-B25; owner decision
 * D7): asks about paths inside the boundary, and every ask that names no path, wherever it points.
 */
const DANGEROUSLY_ALLOW_COVERS = 'Every ask about a path inside it, and every command, host, and process ask, is allowed without a person, sensitive files and file writes included. Paths outside it keep their normal outcome: they ask, or the mount refuses them.'

function describeDangerously(state: { on: boolean; boundTo: string }): string {
  return state.on ? `ON, ${DANGEROUSLY_ALLOW_SCOPE} (${state.boundTo}). ${DANGEROUSLY_ALLOW_COVERS} Each use is audited.` : 'off'
}

function failed(message: string): CliResult {
  process.stderr.write(`${message}\n`)
  return { exitCode: 1 }
}

function print(value: unknown): CliResult {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  return { exitCode: 0 }
}
