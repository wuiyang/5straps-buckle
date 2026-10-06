import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'pathe'
import { parseEnv } from 'node:util'
import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { actionsPath, stateDirectoryOf } from '../common/runtime/config.js'
import { defaultEnvironmentFile } from '../common/runtime/environment.js'
import { isInside } from '../common/domain/paths.js'
import { auditOperation } from '../common/services/audit/audit-operation.js'
import { editEnvironmentVariable, type EnvironmentEdit, updateEnvironmentFile } from './environment-file.js'
import { findNodeSetting, NODE_SETTINGS, normaliseSetting, type NodeSetting } from './node-settings.js'

export interface CliResult {
  exitCode: number
  /** For the command's audit entry: the key written and the value it now holds. */
  detail?: string
}

const USAGE = `Usage:
  buckle settings show                 Node settings, their values and where each came from
  buckle settings set <key> <value>    Write one setting to the environment file
  buckle settings unset <key>          Remove it from the file, so the default applies

Keys (either name): ${NODE_SETTINGS.map(setting => `${setting.alias} (${setting.key})`).join(', ')}.
Lists are comma separated. A change takes effect when buckle serve restarts.
`

/**
 * `BUCKLE-D19`: node settings are the owner's CLI writing the environment file, never a face. The
 * file is the one `buckle serve` reads: `BUCKLE_ENV_FILE`, or buckle.env in the state directory.
 * Only the allow-listed keys in `NODE_SETTINGS` are printed or written; every other line,
 * credentials included, is kept byte for byte and shown by name at most. Before the file exists,
 * `show` still reports the process environment and the defaults; only a write needs it. Each run
 * is audited in the node's action log, a write with the key and value it set.
 */
export async function settingsCommand(input: { argv: string[]; environment: NodeJS.ProcessEnv; environmentFile: string; cwd: string; home?: string }): Promise<CliResult> {
  const file = resolve(input.cwd, input.environmentFile)
  const fileText = existsSync(file) ? readFileSync(file, 'utf8') : null
  const merged = { ...buckleVariables(fileText), ...input.environment }
  return auditOperation({
    actions: createFileActionLog(actionsPath({ stateDirectory: stateDirectoryOf(merged) })),
    workspaceId: 'default', tool: 'cli_settings', sessionId: 'local-owner',
    isSuccessful: result => result.exitCode === 0, describe: result => result.detail,
    operation: () => dispatch({ ...input, file, fileText, merged }),
  })
}

interface SettingsContext {
  argv: string[]
  environment: NodeJS.ProcessEnv
  /** The file buckle serve reads; its text is null until buckle init writes it. */
  file: string
  fileText: string | null
  merged: NodeJS.ProcessEnv
  cwd: string
  home?: string
}

function dispatch(context: SettingsContext): CliResult | Promise<CliResult> {
  const [action, ...rest] = context.argv
  if (action === undefined || action === 'show') return rest.length ? usage() : show(context)
  if (action === 'set' && rest.length === 2) return write(context, rest[0]!, rest[1]!)
  if (action === 'unset' && rest.length === 1) return write(context, rest[0]!, null)
  return usage()
}

function show(context: SettingsContext): CliResult {
  const fileValues = context.fileText === null ? {} : parseEnv(context.fileText)
  process.stdout.write(`Node settings, from ${describeSource(context)}\n\n`)
  for (const setting of NODE_SETTINGS) {
    const [value, source] = context.environment[setting.key] !== undefined
      ? [context.environment[setting.key]!, fileValues[setting.key] !== undefined ? 'process environment, over the file' : 'process environment']
      : fileValues[setting.key] !== undefined ? [fileValues[setting.key]!, 'environment file'] : [setting.fallback, 'default']
    process.stdout.write(`  ${setting.alias.padEnd(16)} ${setting.key.padEnd(24)} ${(value || '(empty)').padEnd(40)} ${source}\n`)
  }
  const hidden = Object.keys(fileValues).filter(name => !findNodeSetting(name) || !name.startsWith('BUCKLE_'))
  if (hidden.length) {
    process.stdout.write(`\nAlso in the file, not shown here:\n`)
    for (const name of hidden) process.stdout.write(`  ${name} (set, hidden)\n`)
  }
  process.stdout.write(`\nChange one with: buckle settings set <key> <value>. A change takes effect when buckle serve restarts.\n`)
  return { exitCode: 0 }
}

function describeSource(context: SettingsContext): string {
  return context.fileText === null ? `the process environment and the defaults (${context.file} is not written yet; buckle init writes it)` : context.file
}

async function write(context: SettingsContext, name: string, raw: string | null): Promise<CliResult> {
  const setting = findNodeSetting(name)
  if (!setting) return fail(`${name} is not a node setting buckle settings writes. Edit ${context.file} by hand for it.\nSettings: ${NODE_SETTINGS.map(item => item.alias).join(', ')}`)
  if (context.fileText === null) return fail(`${context.file} does not exist. Run buckle init first, or point BUCKLE_ENV_FILE at the node's environment file.`)

  const value = raw === null ? null : normalise(setting, raw, context)
  if (value !== null && !value.ok) return fail(value.reason)
  const next = value === null ? null : value.value
  if (next === null && parseEnv(context.fileText)[setting.key] === undefined) {
    process.stdout.write(`${setting.key} is not set in ${context.file}; nothing to remove.\n`)
    return { exitCode: 0 }
  }
  // The state directory's own file names its workspace: unset, the node would serve whatever
  // directory it happens to start in.
  if (setting.key === 'BUCKLE_WORKSPACE_ROOT' && next === null && context.file === defaultEnvironmentFile(context.environment)) {
    return fail('The node\'s environment file must name its workspace root; set a new root instead of unsetting it')
  }
  let edit: EnvironmentEdit
  try {
    edit = await updateEnvironmentFile(context.file, text => editEnvironmentVariable({ text, name: setting.key, value: next }), { ...(context.home ? { home: context.home } : {}) })
  } catch (error) {
    return fail(`Could not write ${context.file}: ${error instanceof Error ? error.message : 'unknown error'}. Inspect the configuration before retrying.`)
  }
  if (!edit.ok) return fail(`${edit.reason} in ${context.file}`)

  process.stdout.write(next === null
    ? `Removed ${setting.key} from ${context.file}; the default applies: ${setting.fallback}\n`
    : `Set ${setting.key}=${next} in ${context.file}\n`)
  if (context.environment[setting.key] !== undefined) {
    process.stdout.write(`${setting.key} is also set in this shell's environment, which wins over the file until it is unset there.\n`)
  }
  process.stdout.write('Restart buckle serve for the change to take effect.\n')
  return { exitCode: 0, detail: next === null ? `${setting.key} unset` : `${setting.key}=${next}` }
}

/** A workspace root holding the state directory is refused here, as the node would refuse it at start. */
function normalise(setting: NodeSetting, raw: string, context: SettingsContext) {
  const value = normaliseSetting({ setting, raw, cwd: context.cwd, isDirectory: path => existsSync(path) && statSync(path).isDirectory(), environment: context.merged })
  if (value.ok && setting.key === 'BUCKLE_WORKSPACE_ROOT' && isInside(value.value, stateDirectoryOf(context.merged))) {
    return { ok: false as const, reason: `${value.value} holds the state directory ${stateDirectoryOf(context.merged)}; an agent writes anywhere in the workspace, so Buckle refuses to start with it as the root` }
  }
  return value
}

/** The BUCKLE_* variables the node would read from the file, as `buckle serve` loads them. */
function buckleVariables(text: string | null): NodeJS.ProcessEnv {
  if (text === null) return {}
  return Object.fromEntries(Object.entries(parseEnv(text)).filter(([name]) => name.startsWith('BUCKLE_')))
}

function usage(): CliResult {
  process.stderr.write(USAGE)
  return { exitCode: 1 }
}

function fail(message: string): CliResult {
  process.stderr.write(`${message}\n`)
  return { exitCode: 1 }
}
