import { isManagedWorkspaceConfig, moveWorkspaceConfig } from '../common/runtime/workspace-config.js'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { actionsPath, stateDirectoryOf } from '../common/runtime/config.js'
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
 * file is the one `buckle serve` reads: `BUCKLE_ENV_FILE`, or the file `buckle init` registered for
 * this directory. Only the allow-listed keys in `NODE_SETTINGS` are printed or written; every other
 * line, credentials included, is kept byte for byte and shown by name at most. Without a file,
 * `show` still reports the process environment and the defaults; only a write needs one. Each run
 * is audited in the node's action log, a write with the key and value it set.
 */
export async function settingsCommand(input: { argv: string[]; environment: NodeJS.ProcessEnv; environmentFile: string | null; cwd: string; home?: string }): Promise<CliResult> {
  const file = input.environmentFile === null ? null : resolve(input.cwd, input.environmentFile)
  const fileText = file !== null && existsSync(file) ? readFileSync(file, 'utf8') : null
  const merged = { ...buckleVariables(fileText), ...input.environment }
  return auditOperation({
    actions: createFileActionLog(actionsPath({ stateDirectory: stateDirectoryOf(merged) })),
    workspaceId: 'default', tool: 'cli_settings', sessionId: 'local-owner',
    isSuccessful: result => result.exitCode === 0, describe: result => result.detail,
    operation: () => dispatch({ ...input, file, fileText, merged }),
  })
}

const NO_ENVIRONMENT_FILE = 'No Buckle environment file for this directory. Run `buckle init` here to create and register one, or set BUCKLE_ENV_FILE to the file to use.'

interface SettingsContext {
  argv: string[]
  environment: NodeJS.ProcessEnv
  /** Null when no environment file applies here: nothing to write to, the process environment still shows. */
  file: string | null
  fileText: string | null
  merged: NodeJS.ProcessEnv
  cwd: string
  home?: string
}

function dispatch(context: SettingsContext): CliResult | Promise<CliResult> {
  const [action, ...rest] = context.argv
  if (action === undefined || action === 'show') return rest.length ? usage() : show(context)
  if (action === 'set' && rest.length === 2) return writeTo(context, rest[0]!, rest[1]!)
  if (action === 'unset' && rest.length === 1) return writeTo(context, rest[0]!, null)
  return usage()
}

function writeTo(context: SettingsContext, name: string, raw: string | null): CliResult | Promise<CliResult> {
  const { file } = context
  return file === null ? fail(NO_ENVIRONMENT_FILE) : write({ ...context, file }, name, raw)
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
  if (context.file === null) return 'the process environment (no environment file for this directory; buckle init creates one)'
  return context.fileText === null ? `${context.file} (not written yet)` : context.file
}

async function write(context: SettingsContext & { file: string }, name: string, raw: string | null): Promise<CliResult> {
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
  if (setting.key === 'BUCKLE_WORKSPACE_ROOT' && next === null && isManagedWorkspaceConfig(context.file, context.home)) {
    return fail('A registered workspace must have a root; set a new root instead of unsetting it')
  }
  let edit: EnvironmentEdit = { ok: false, reason: 'Settings update did not run' }
  try {
    const writeValue = async () => {
      edit = await updateEnvironmentFile(context.file, text => editEnvironmentVariable({ text, name: setting.key, value: next }), { ...(context.home ? { home: context.home } : {}) })
      return edit.ok
    }
    if (setting.key === 'BUCKLE_WORKSPACE_ROOT' && next !== null) await moveWorkspaceConfig({ file: context.file, root: next, home: context.home, write: writeValue })
    else await writeValue()
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
