import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { destructivePatterns, emptyWorkspacePolicy, WorkspacePolicySchema, type WorkspacePolicy } from '@5straps/protocol'
import { createFilePolicyStore } from '../../adapters/policy-store/file-policy-store.js'
import { policyPath, type BuckleConfig } from '../../config.js'
import { PolicyError } from '../../domain/policy.js'
import { migrateCommandPattern, type PatternMigration } from '../../domain/policy-migration.js'
import type { BuckleRuntime } from '../../runtime.js'

export interface CliResult {
  exitCode: number
}

const USAGE = `Usage:
  buckle policy show [--json]                 The effective policy and where each part came from
  buckle policy allow-command <glob>          Only matching command lines may run
  buckle policy deny-command <glob>           Matching command lines are refused; deny wins
  buckle policy destructive-command <glob>    Matching command lines ask first, once or per session
  buckle policy allow-url <host|url-prefix>   Only listed hosts and URLs may be reached
  buckle policy mount <path> | unmount        Show the workspace to the agent as this path
  buckle policy remove <pattern>              Drop a pattern from every list
  buckle policy import <file.json>            Replace the stored policy from a file
  buckle policy export                        Print the stored policy as JSON
  buckle policy clear                         Drop the stored policy, leaving the environment's
  buckle policy migrate [--write]             Turn stored regular expressions into globs

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
      case 'remove':
        return await save(runtime, remove(current(), required(rest[0], action)))
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
 * `--write`, and never writes a pattern it could not read.
 */
export function policyMigrateCommand(input: { config: BuckleConfig; argv: string[] }): CliResult {
  const { values } = parseArgs({ args: input.argv, options: { write: { type: 'boolean' } }, allowPositionals: false })
  const store = createFilePolicyStore({ filePath: policyPath(input.config), workspace: input.config.cwd })
  const stored = store.read()
  const storedMigrations = migrationsOf(stored)
  const environmentMigrations = migrationsOf(input.config.policy)

  if (storedMigrations.length === 0 && environmentMigrations.length === 0) {
    process.stdout.write('No command patterns are stored or configured; there is nothing to migrate.\n')
    return { exitCode: 0 }
  }

  printMigrations(`Stored policy (${policyPath(input.config)})`, storedMigrations)
  printMigrations('Environment (BUCKLE_COMMAND_ALLOW and friends)', environmentMigrations)

  const unreadable = [...storedMigrations, ...environmentMigrations].filter(migration => migration.glob === null)
  if (unreadable.length > 0) {
    const subject = unreadable.length === 1 ? '1 pattern needs' : `${unreadable.length} patterns need`
    process.stderr.write(`\n${subject} a person. Rewrite each as a glob, then run this again.\n`)
    return { exitCode: 1 }
  }
  if (environmentMigrations.length > 0) {
    process.stdout.write('\nEnvironment patterns live in the environment file; paste the globs above over them.\n')
  }
  if (!values.write) {
    process.stdout.write('\nNothing written. Run `buckle policy migrate --write` to store the conversions above.\n')
    return { exitCode: 0 }
  }
  if (!stored) {
    process.stdout.write('\nNo stored policy to write.\n')
    return { exitCode: 0 }
  }

  store.write(applyMigrations(stored, storedMigrations))
  process.stdout.write('\nStored policy rewritten as globs.\n')
  return { exitCode: 0 }
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

function applyMigrations(policy: WorkspacePolicy, migrations: ListedMigration[]): WorkspacePolicy {
  return edit(policy, next => {
    for (const list of COMMAND_LISTS) {
      next.commands[list] = migrations.flatMap(migration => (migration.list === list && migration.glob ? [migration.glob] : []))
    }
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

async function save(runtime: BuckleRuntime, policy: WorkspacePolicy): Promise<CliResult> {
  await runtime.policy.apply(policy)
  return show(runtime, [])
}

function show(runtime: BuckleRuntime, argv: string[]): CliResult {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' } }, allowPositionals: false })
  const effective = runtime.policy.effective()
  const base = runtime.policy.base()
  const stored = runtime.policy.stored()
  if (values.json) return print({ effective, base, stored })

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
  process.stdout.write(`Mount     ${effective.mount ?? '(none: the real path shows through)'}\n\n`)
  section('Command allow list (only these may run)', effective.commands.allow, policy => policy.commands.allow)
  section('Command deny list (refused outright)', effective.commands.deny, policy => policy.commands.deny)
  section('Destructive additions (these ask, on top of the built-in floor)', destructivePatterns(effective), destructivePatterns)
  section('Approved hosts and URLs (only these may be reached)', effective.network.allow, policy => policy.network.allow)
  process.stdout.write(`\nStored ${stored?.updatedAt ? `at ${stored.updatedAt}` : 'nothing'}; environment and stored parts are unioned.\n`)
  return { exitCode: 0 }
}

function print(value: unknown): CliResult {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  return { exitCode: 0 }
}
