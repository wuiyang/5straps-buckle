import { stopsForRecord, type OwnerChoice } from './ignore-warning.js'
import type { CliResult } from './result.js'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'pathe'
import { parseEnv } from 'node:util'
import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { actionsPath, environmentFilePath, stateDirectoryOf } from '../common/runtime/config.js'
import { realPathOf } from '../common/runtime/real-path.js'
import { scratchOverFolderNote } from '../common/domain/sandbox-mounts.js'
import { registryPath, RegistrySchema } from '../common/services/workspaces/registry.js'
import { ownerMounts, settingsPath, WorkspaceSettingsSchema } from '../common/services/workspaces/workspace-settings.js'
import { auditOperation } from '../common/services/audit/audit-operation.js'
import { NODE_SCOPE } from '../common/types/ports/client-keys.js'
import { editEnvironmentVariable, type EnvironmentEdit, updateEnvironmentFile } from '../common/adapters/environment-file.js'
import { movedOntoWorkspaces } from '../common/services/workspaces/migration.js'
import { restartRoute, restartSteps, restartSubject, type RestartRoute } from '../common/services/node-service/installed.js'
import { homeDirectory, isInside } from '../common/domain/paths.js'
import { asksForHelp } from './help-request.js'
import { findNodeSetting, NODE_SETTINGS, normaliseSetting, ROOT_SETTING, type NodeSetting } from './node-settings.js'


const usageText = (restart: RestartRoute) => `Usage:
  buckle settings show                 Node settings, their values and where each came from
  buckle settings set <key> <value>    Write one setting to the environment file
  buckle settings unset <key>          Remove it from the file, so the default applies

Keys (either name): ${NODE_SETTINGS.map(setting => `${setting.alias} (${setting.key})`).join(', ')}.
Lists are comma separated, command globs separated by ;;. ${takesEffect(restart)}
From approval-wait on, each is a default every workspace takes where its own settings hold no value,
which buckle workspace set and buckle policy change; the command deny and destructive lists apply to
every workspace whatever its own say.
`

/**
 * When a node setting applies (Phase 3, item 7, and fix brief 6, item 1): when the node restarts, as what runs it
 * restarts it: `buckle service restart`, Ctrl-C at the terminal of a `buckle serve` and that again, or a stop and
 * `buckle serve --background`; with nothing running or installed, when buckle serve restarts.
 */
function takesEffect(restart: RestartRoute): string {
  const steps = restartSteps(restart)
  return `A change takes effect when ${restartSubject(restart)} restarts${steps === null ? '' : `: ${steps}`}.`
}

function restartLine(restart: RestartRoute): string {
  const steps = restartSteps(restart)
  return `Restart ${restartSubject(restart)} for the change to take effect${steps === null ? '' : `: ${steps}`}.`
}

/**
 * `BUCKLE-D19`: node settings are the owner's CLI writing the environment file, never a face. The
 * file is the one `buckle serve` reads: `BUCKLE_ENV_FILE`, or buckle.env in the state directory.
 * Only the allow-listed keys in `NODE_SETTINGS` are printed or written; every other line,
 * credentials included, is kept byte for byte and shown by name at most. Before the file exists,
 * `show` still reports the process environment for the node's own settings and the defaults, and a
 * workspace default this shell sets as not read, as the node reads none without the file; only a
 * write needs it. Each run
 * is audited in the node's action log, a write with the key and value it set.
 */
export async function settingsCommand(input: { argv: string[]; environment: NodeJS.ProcessEnv; environmentFile: string; cwd: string; home?: string; ignoreWarning?: boolean }): Promise<CliResult> {
  const file = resolve(input.cwd, input.environmentFile)
  const fileText = existsSync(file) ? readFileSync(file, 'utf8') : null
  const merged = { ...buckleVariables(fileText), ...input.environment }
  const restart = await restartRoute(stateDirectoryOf(merged), input.environment, process.platform, input.home ?? homeDirectory())
  // Asking for the usage runs nothing, so it is no entry in the log.
  if (asksForHelp(input.argv)) {
    process.stdout.write(usageText(restart))
    return { exitCode: 0 }
  }
  return auditOperation({
    actions: createFileActionLog(actionsPath({ stateDirectory: stateDirectoryOf(merged) })),
    workspaceId: NODE_SCOPE, tool: 'cli_settings', sessionId: 'local-owner', ignoreWarning: input.ignoreWarning === true,
    isSuccessful: result => result.exitCode === 0, describe: result => result.detail,
    operation: () => dispatch({ ...input, file, fileText, merged, restart }),
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
  restart: RestartRoute
}

function dispatch(context: SettingsContext): CliResult | Promise<CliResult> {
  const [action, ...rest] = context.argv
  if (action === undefined || action === 'show') return rest.length ? usage(context.restart) : show(context)
  if (action === 'set' && rest.length === 2) return write(context, rest[0]!, rest[1]!)
  if (action === 'unset' && rest.length === 1) return write(context, rest[0]!, null)
  return usage(context.restart)
}

function show(context: SettingsContext): CliResult {
  const fileValues = context.fileText === null ? {} : parseEnv(context.fileText)
  process.stdout.write(`Node settings, from ${describeSource(context)}\n\n`)
  const line = (setting: NodeSetting) => {
    // A workspace default is read from the file alone, whatever this shell sets (D85, Q3); a node with no file reads none.
    const fromFileAlone = setting.workspace !== undefined && context.environment[setting.key] !== undefined
    const [value, source] = fromFileAlone
      ? [fileValues[setting.key] ?? setting.fallback, `${fileValues[setting.key] !== undefined ? 'environment file' : 'default'}; this shell's value is not read`]
      : context.environment[setting.key] !== undefined
        ? [context.environment[setting.key]!, fileValues[setting.key] !== undefined ? 'process environment, over the file' : 'process environment']
        : fileValues[setting.key] !== undefined ? [fileValues[setting.key]!, 'environment file'] : [setting.fallback, 'default']
    process.stdout.write(`  ${setting.alias.padEnd(20)} ${setting.key.padEnd(28)} ${(value || '(empty)').padEnd(40)} ${source}\n`)
  }
  for (const setting of NODE_SETTINGS.filter(item => !item.workspace)) line(setting)
  // D85, Q3 and Q14: these are each workspace's defaults, and the deny lists a floor over every workspace.
  process.stdout.write(`\nWorkspace defaults, which a workspace's own settings replace (buckle workspace show); the command deny and destructive lists apply to every workspace:\n`)
  const workspaceDefaults = NODE_SETTINGS.filter(item => item.workspace)
  if (context.fileText === null && workspaceDefaults.some(setting => context.environment[setting.key] !== undefined)) {
    process.stdout.write(`This node has no buckle.env, so it reads none of these from the environment: run buckle init, then buckle settings set <key> <value>.\n`)
  }
  for (const setting of workspaceDefaults) line(setting)
  if (fileValues[ROOT_SETTING.key] !== undefined || context.environment[ROOT_SETTING.key] !== undefined) {
    process.stdout.write(movedOntoWorkspaces(stateDirectoryOf(context.merged))
      ? `\n${ROOT_SETTING.key} was read once, when this node moved onto workspaces, as the folder of the workspace it made; the node no longer reads it (buckle settings unset root).\n`
      : `\n${ROOT_SETTING.key} is read once, when this node moves onto workspaces at its next start, as the folder of the workspace it makes of it.\n`)
  }
  const hidden = Object.keys(fileValues).filter(name => (!findNodeSetting(name) && name !== ROOT_SETTING.key) || !name.startsWith('BUCKLE_'))
  if (hidden.length) {
    process.stdout.write(`\nAlso in the file, not shown here:\n`)
    for (const name of hidden) process.stdout.write(`  ${name} (set, hidden)\n`)
  }
  process.stdout.write(`\nChange one with: buckle settings set <key> <value>. ${takesEffect(context.restart)}\n`)
  return { exitCode: 0 }
}

function describeSource(context: SettingsContext): string {
  return context.fileText === null ? `the process environment and the defaults (${context.file} is not written yet; buckle init writes it)` : context.file
}

async function write(context: SettingsContext, name: string, raw: string | null): Promise<CliResult> {
  const root = name === ROOT_SETTING.key || name === ROOT_SETTING.alias
  // The 0.1 folder line is read once, when the node moves onto workspaces; `unset` removes it, as the move's notice asks.
  if (root && raw !== null) return fail(`${ROOT_SETTING.key} is read only when a node set up before workspaces moves onto them. Serve a folder with ${ROOT_SETTING.replacement}.`)
  const setting: Pick<NodeSetting, 'key' | 'fallback' | 'logsValue'> | undefined = findNodeSetting(name) ?? (root ? { key: ROOT_SETTING.key, fallback: '(no folder: buckle mcp serves the workspace holding the directory it starts in)' } : undefined)
  if (!setting) return fail(`${name} is not a node setting buckle settings writes. Edit ${context.file} by hand for it.\nSettings: ${NODE_SETTINGS.map(item => item.alias).join(', ')}`)
  if (context.fileText === null) return fail(`${context.file} does not exist. Run buckle init first, or point BUCKLE_ENV_FILE at the node's environment file.`)

  const value = raw === null ? null : normalise(setting as NodeSetting, raw, context)
  if (value !== null && !value.ok) return fail(value.reason)
  const next = value === null ? null : value.value
  if (next === null && parseEnv(context.fileText)[setting.key] === undefined) {
    process.stdout.write(`${setting.key} is not set in ${context.file}; nothing to remove.\n`)
    return { exitCode: 0 }
  }
  let edit: EnvironmentEdit
  try {
    edit = await updateEnvironmentFile(context.file, text => editEnvironmentVariable({ text, name: setting.key, value: next }), { ...(context.home ? { home: context.home } : {}) })
  } catch (error) {
    return fail(`Could not write ${context.file}: ${error instanceof Error ? error.message : 'unknown error'}. Inspect the configuration before retrying.`)
  }
  if (!edit.ok) return fail(`${edit.reason} in ${context.file}`)

  // A value that can hold a credential is neither echoed nor audited, as buckle workspace set keeps one out of its own.
  const shown = setting.logsValue === false ? setting.key : `${setting.key}=${next}`
  process.stdout.write(next === null
    ? `Removed ${setting.key} from ${context.file}; the default applies: ${setting.fallback}\n`
    : `Set ${shown} in ${context.file}\n`)
  const workspace = findNodeSetting(name)?.workspace
  if (context.environment[setting.key] !== undefined) {
    process.stdout.write(workspace
      ? `${setting.key} is also set in this shell's environment, which the node does not read for a workspace default: the file's value applies.\n`
      : `${setting.key} is also set in this shell's environment, which wins over the file until it is unset there.\n`)
  }
  if (workspace) process.stdout.write(FLOOR_KEYS.has(setting.key)
    ? `It applies to every workspace, over each one's own ${workspace.key}.\n`
    : `It is the default of every workspace whose own settings leave ${workspace.key} unset.\n`)
  if (setting.key === 'BUCKLE_SCRATCH_ROOTS' && next !== null) for (const note of scratchOverFolders(stateDirectoryOf(context.merged), next.split(','))) process.stdout.write(`${note}\n`)
  process.stdout.write(`${restartLine(context.restart)}\n`)
  const note = AFTER_CHANGE.get(setting.key)
  if (note !== undefined) process.stdout.write(`${note}\n`)
  return { exitCode: 0, detail: next === null ? `${setting.key} unset` : setting.logsValue === false ? `${setting.key} set` : `${setting.key}=${next}` }
}

// Said beside the restart where it matters: a buckle mcp reads the node's defaults once, as its MCP client starts it,
// and no node restart restarts it.
const AFTER_CHANGE: ReadonlyMap<string, string> = new Map([
  ['BUCKLE_APPROVAL_FORMS', 'A buckle mcp an MCP client started takes the new default only when the client starts it again; buckle workspace set approval.forms off stops forms in a workspace at once.'],
  // Each process ends each session of its workspace at its own window, so one left running ends them early for all.
  ['BUCKLE_APPROVAL_SESSION_IDLE_MS', 'A buckle mcp an MCP client started keeps the window it started with, and ends each session of its workspace at it, until the client starts it again; buckle workspace set approval.sessionIdleMs changes a workspace\'s window from its next call.'],
])

/**
 * Fix brief 6, item 3: a scratch root that holds a registered workspace's folder, where that workspace takes the node's
 * mounts (it has none of its own), makes its shell refuse each call while the folder shows at a mount. One note each;
 * none where the registry cannot be read.
 */
function scratchOverFolders(stateDirectory: string, roots: string[]): string[] {
  let workspaces: Array<{ id: string; name: string; dir: string }>
  try { workspaces = RegistrySchema.parse(JSON.parse(readFileSync(registryPath(stateDirectory), 'utf8'))).workspaces } catch { return [] }
  const real = roots.map(root => realPathOf(root))
  return workspaces.flatMap((workspace) => {
    const holding = real.find(root => isInside(root, workspace.dir))
    return holding === undefined || hasOwnMounts(stateDirectory, workspace.id) ? [] : [scratchOverFolderNote({ scratchRoot: holding, workspace: workspace.name })]
  })
}

/** Whether a workspace's own settings hold mounts of their own, so the node's scratch roots are not in its table. */
function hasOwnMounts(stateDirectory: string, id: string): boolean {
  try {
    return ownerMounts(WorkspaceSettingsSchema.parse(JSON.parse(readFileSync(settingsPath(stateDirectory, id), 'utf8')))).length > 0
  } catch {
    return false
  }
}

/** The node's deny-type lists, a floor over every workspace's own (D85, Q14). */
const FLOOR_KEYS = new Set(['BUCKLE_COMMAND_DENY', 'BUCKLE_COMMAND_DESTRUCTIVE'])

function normalise(setting: NodeSetting, raw: string, context: SettingsContext) {
  return normaliseSetting({ setting, raw, cwd: context.cwd, isDirectory: path => existsSync(path) && statSync(path).isDirectory(), environment: context.merged, fileValues: buckleVariables(context.fileText) })
}

/** The BUCKLE_* variables the node would read from the file, as `buckle serve` loads them. */
function buckleVariables(text: string | null): NodeJS.ProcessEnv {
  if (text === null) return {}
  return Object.fromEntries(Object.entries(parseEnv(text)).filter(([name]) => name.startsWith('BUCKLE_')))
}

function usage(restart: RestartRoute): CliResult {
  process.stderr.write(usageText(restart))
  return { exitCode: 1 }
}

function fail(message: string): CliResult {
  process.stderr.write(`${message}\n`)
  return { exitCode: 1 }
}

export function runSettingsCommand(argv: string[], options: OwnerChoice = {}): Promise<CliResult> {
  return stopsForRecord(settingsCommand({ argv, environment: process.env, environmentFile: environmentFilePath(), cwd: process.cwd(), ignoreWarning: options.ignoreWarning === true }))
}
