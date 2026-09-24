import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { destructivePatterns, emptyWorkspacePolicy, isWorkspaceToolAllowed, ToolNameSchema, WorkspacePolicySchema, type WorkspacePolicy } from '@5straps/protocol'
import { createFilePolicyStore } from '../../adapters/policy-store/file-policy-store.js'
import { policyPath, type BuckleConfig } from '../../config.js'
import { PolicyError, refusedNetworkEntries, type SkippedEntry } from '../../domain/policy.js'
import { migrateCommandPattern, type PatternMigration } from '../../domain/policy-migration.js'
import type { BuckleRuntime } from '../../runtime.js'

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
  buckle policy migrate [--write]             Turn stored regular expressions into globs, and
                                              drop approved-list entries the host grammar refuses

A command glob is matched one shell word at a time. 'pnpm {build,test} *' allows 'pnpm build'
with any arguments after it: * stands for one word, and a trailing * for the rest of the line.
An allow glob must cover the whole line; a deny glob covers every line starting with it.
`

/**
 * Edits the stored policy for this workspace. Each change is validated as the union with the
 * environment's share before it is written, so a bad pattern never lands.
 */
export async function policyCommand(runtime: BuckleRuntime, argv: string[]): Promise<CliResult> {
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
        if (result.exitCode === 0 && opensNetwork(before, next, runtime.policy.base())) {
          process.stdout.write('The approved list is now empty, which is no list: the default network rules reach public hosts. Add an entry with `buckle policy allow-url <host>` to restrict it again.\n')
        }
        return result
      }
      case 'import':
        return await save(runtime, WorkspacePolicySchema.parse(JSON.parse(readFileSync(required(rest[0], action), 'utf8'))))
      case 'export':
        return print(runtime.policy.stored() ?? emptyWorkspacePolicy())
      case 'clear':
        await runtime.policy.clear()
        process.stdout.write('Stored policy cleared\n')
        return { exitCode: 0 }
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

/** The lists a command pattern can sit in, in the order `buckle policy show` prints them. */
const COMMAND_LISTS = ['allow', 'deny', 'destructive'] as const

type CommandList = typeof COMMAND_LISTS[number]

interface ListedMigration extends PatternMigration {
  list: CommandList
}

/**
 * Reads the stored and environment patterns straight from disk, because a stored regular
 * expression is exactly what stops the runtime from being built. Writes nothing without
 * `--write`, and never writes a pattern it could not read. Approved-list entries the host grammar
 * refuses (`BUCKLE-D18`) are skipped at load; `--write` drops the stored ones too.
 */
export function policyMigrateCommand(input: { config: BuckleConfig; argv: string[] }): CliResult {
  const { values } = parseArgs({ args: input.argv, options: { write: { type: 'boolean' } }, allowPositionals: false })
  const store = createFilePolicyStore({ filePath: policyPath(input.config), workspace: input.config.cwd })
  const stored = store.read()
  const storedMigrations = migrationsOf(stored)
  const environmentMigrations = migrationsOf(input.config.policy)
  const storedRefused = refusedNetworkEntries(stored?.network.allow ?? [])
  const environmentRefused = refusedNetworkEntries(input.config.policy.network.allow)

  if (storedMigrations.length + environmentMigrations.length + storedRefused.length + environmentRefused.length === 0) {
    process.stdout.write('No command patterns or refused approved-list entries are stored or configured; there is nothing to migrate.\n')
    return { exitCode: 0 }
  }

  printMigrations(`Stored policy (${policyPath(input.config)})`, storedMigrations)
  printMigrations('Environment (BUCKLE_COMMAND_ALLOW and friends)', environmentMigrations)
  printRefused(`Stored approved list (${policyPath(input.config)}), entries skipped at load`, storedRefused)
  printRefused('Environment (BUCKLE_NETWORK_ALLOW), entries skipped at load', environmentRefused)

  const unreadable = [...storedMigrations, ...environmentMigrations].filter(migration => migration.glob === null)
  if (unreadable.length > 0) {
    const subject = unreadable.length === 1 ? '1 pattern needs' : `${unreadable.length} patterns need`
    process.stderr.write(`\n${subject} a person. Rewrite each as a glob, then run this again.\n`)
    return { exitCode: 1 }
  }
  if (environmentMigrations.length > 0) {
    process.stdout.write('\nEnvironment patterns live in the environment file; paste the globs above over them.\n')
  }
  if (environmentRefused.length > 0) {
    process.stdout.write('\nRemove the refused BUCKLE_NETWORK_ALLOW entries from the environment file.\n')
  }
  const migrated = stored ? applyMigrations(stored, storedMigrations, storedRefused) : null
  const emptied = stored !== null && migrated !== null && opensNetwork(stored, migrated, input.config.policy)
  if (!values.write) {
    if (emptied) process.stdout.write(`\n${EMPTIED_LIST} --write will refuse until the list keeps an entry.\n`)
    process.stdout.write('\nNothing written. Run `buckle policy migrate --write` to store the conversions and removals above.\n')
    return { exitCode: 0 }
  }
  if (!stored || !migrated || storedMigrations.length + storedRefused.length === 0) {
    process.stdout.write('\nNo stored policy to write.\n')
    return { exitCode: 0 }
  }

  if (emptied) {
    process.stderr.write(`\n${EMPTIED_LIST} Nothing written: add an entry with \`buckle policy allow-url <host>\` and run this again, or run \`buckle policy clear\` if you mean to lift the list.\n`)
    return { exitCode: 1 }
  }
  store.write(migrated)
  process.stdout.write('\nStored policy rewritten: command patterns as globs, refused approved-list entries dropped.\n')
  return { exitCode: 0 }
}

const EMPTIED_LIST = 'Dropping these leaves the approved list empty, and an empty list is no list: the default network rules would then reach every public host, where the list reached none.'

/**
 * A stored approved list and an absent one read the same when empty: no list, so the network rule
 * falls back to its defaults. Emptying a list that reached nothing would therefore open the node,
 * unless the environment still names entries of its own.
 */
function opensNetwork(before: WorkspacePolicy, after: WorkspacePolicy, environment: WorkspacePolicy): boolean {
  return before.network.allow.length > 0 && after.network.allow.length === 0 && environment.network.allow.length === 0
}

function migrationsOf(policy: WorkspacePolicy | null): ListedMigration[] {
  if (!policy) return []
  return COMMAND_LISTS.flatMap(list => patternsOf(policy, list).map(source => ({ list, ...migrateCommandPattern(source) })))
}

function patternsOf(policy: WorkspacePolicy, list: CommandList): string[] {
  return list === 'destructive' ? destructivePatterns(policy) : policy.commands[list]
}

function printMigrations(title: string, migrations: ListedMigration[]): void {
  if (migrations.length === 0) return
  process.stdout.write(`${title}\n`)
  for (const migration of migrations) {
    const target = migration.glob === null ? 'cannot convert' : migration.glob
    process.stdout.write(`  ${migration.list.padEnd(11)} ${migration.source.padEnd(40)} -> ${target}\n`)
    if (migration.note) process.stdout.write(`  ${' '.repeat(11)} ${' '.repeat(40)}    (${migration.note})\n`)
  }
}

function printRefused(title: string, refused: SkippedEntry[]): void {
  if (refused.length === 0) return
  process.stdout.write(`${title}\n`)
  for (const { entry, reason } of refused) process.stdout.write(`  ${entry.padEnd(40)} -> remove (${reason})\n`)
}

function applyMigrations(policy: WorkspacePolicy, migrations: ListedMigration[], refused: SkippedEntry[]): WorkspacePolicy {
  return edit(policy, next => {
    for (const list of COMMAND_LISTS) {
      next.commands[list] = migrations.flatMap(migration => (migration.list === list && migration.glob ? [migration.glob] : []))
    }
    next.network.allow = next.network.allow.filter(entry => !refused.some(item => item.entry === entry))
    next.updatedAt = new Date().toISOString()
  })
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
  const skipped = runtime.policy.skipped()
  if (values.json) return print({ effective, base, stored, skipped })

  const origin = (list: (policy: WorkspacePolicy) => string[], item: string): string => {
    const fromBase = list(base).includes(item)
    const fromStored = stored ? list(stored).includes(item) : false
    return fromBase && fromStored ? 'env+stored' : fromBase ? 'env' : 'stored'
  }
  const note = (item: string): string => {
    const refused = skipped.find(entry => entry.entry === item)
    return refused ? `  SKIPPED, covers nothing: ${refused.reason}` : ''
  }
  const section = (title: string, items: string[], list: (policy: WorkspacePolicy) => string[]): void => {
    process.stdout.write(`${title}\n`)
    if (items.length === 0) process.stdout.write('  (none)\n')
    for (const item of items) process.stdout.write(`  ${item.padEnd(48)} ${origin(list, item)}${note(item)}\n`)
  }

  process.stdout.write(`Workspace ${runtime.paths().root}\n`)
  process.stdout.write(`Mount     ${effective.mount ?? '(none: the real path shows through)'}\n\n`)
  section('Command allow list (only these may run)', effective.commands.allow, policy => policy.commands.allow)
  section('Command deny list (refused outright)', effective.commands.deny, policy => policy.commands.deny)
  section('Destructive additions (these ask, on top of the built-in floor)', destructivePatterns(effective), destructivePatterns)
  section('Approved hosts and URLs (only these may be reached)', effective.network.allow, policy => policy.network.allow)
  section('Denied tools (refused outright, whatever the pack allows)', effective.tools?.deny ?? [], policy => policy.tools?.deny ?? [])
  if (effective.tools?.allow !== undefined) section('Tool allow list (only these tools may run)', effective.tools.allow, policy => policy.tools?.allow ?? [])
  if (skipped.length > 0) process.stdout.write('\nA SKIPPED entry fails the host grammar and covers nothing. Drop it with `buckle policy migrate --write`.\n')
  process.stdout.write(`\nStored ${stored?.updatedAt ? `at ${stored.updatedAt}` : 'nothing'}; environment and stored parts are unioned.\n`)
  return { exitCode: 0 }
}

function print(value: unknown): CliResult {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  return { exitCode: 0 }
}
