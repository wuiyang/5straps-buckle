import { isAbsolute, resolve } from 'pathe'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { INTERPRETER_NAMES, isInterpreter } from '../common/domain/command-forms.js'
import { compilePolicy, PolicyError, refusedNetworkEntries } from '../common/domain/policy.js'
import { compileHostPattern, UrlPatternError } from '../common/domain/url-pattern.js'
import { parseSandboxMounts } from '../common/domain/sandbox-mounts.js'
import { browserBlockRefusal, parseApprovalTimeout, parseBrowserArgs, parseBrowserCdp, parseBrowserProfile } from '../common/runtime/config.js'
import { BUILTIN_PACKS, unmetPackPrerequisite } from '../common/services/packs/index.js'
import { JUDGE_MODEL_NAME, JUDGE_MODES, JUDGE_PROVIDERS } from '../common/types/ports/judge.js'
import { QUICK_JUDGE_SCOPES } from '../common/types/ports/quick-judge.js'
import { MAX_MASS_DELETE_LIMIT, parseDeleteInWorkspace, parseMassDeleteLimit } from '../common/domain/delete-policy.js'

/**
 * The node settings `BUCKLE-D19` names: what the owner changes with `buckle settings` or answers in
 * `buckle init`, written to the environment file and read when the node starts. Every other
 * variable, credentials above all, is left to a hand edit and never printed.
 */
export interface NodeSetting {
  key: string
  /** The short name `buckle settings set` also accepts. */
  alias: string
  kind: 'boolean' | 'host-list' | 'directory-list' | 'name' | 'approval-wait' | 'packs' | 'mount' | 'url-list' | 'interpreter-list' | 'command-list' | 'script-list' | 'mounts' | 'browser-cdp' | 'browser-profile' | 'browser-args' | 'judge-mode' | 'judge-provider' | 'judge-model' | 'quick-scope' | 'delete-mode' | 'entry-limit'
  /** What the node does when the key is unset, as `buckle settings show` prints it. */
  fallback: string
  /** False when the audit log and the confirmation keep the value out (a DevTools URL can carry a token, arguments a proxy password): the key alone is recorded. */
  logsValue?: false
  /**
   * For a workspace default (D85, Q3): the setting in each workspace's own settings that wins over it, and how that one
   * changes. Absent for a node-only setting, which no workspace sets.
   */
  workspace?: { key: string; change: string }
}

/**
 * The node's settings (D85, Q3): first those of the node alone, then the defaults every workspace takes where its own
 * settings hold no value. Of those, the deny lists apply to every workspace whatever its own say (Q14).
 */
export const NODE_SETTINGS: readonly NodeSetting[] = [
  { key: 'BUCKLE_SERVER_NAME', alias: 'name', kind: 'name', fallback: 'Local Buckle' },
  { key: 'BUCKLE_MOUNT_READ_ONLY', alias: 'read-only-paths', kind: 'directory-list', fallback: '(none)' },
  // Owner decision D8: the admin HTTP layer is experimental, off until this is on (and an admin credential is set).
  { key: 'BUCKLE_EXPERIMENTAL_ADMIN_HTTP', alias: 'experimental-admin-http', kind: 'boolean', fallback: 'false' },
  { key: 'BUCKLE_APPROVAL_TIMEOUT_MS', alias: 'approval-wait', kind: 'approval-wait', fallback: '15000', workspace: { key: 'approvalWaitMs', change: 'buckle workspace set approvalWaitMs <milliseconds>' } },
  // MCP form approvals: every workspace's default where its own settings hold none.
  { key: 'BUCKLE_APPROVAL_FORMS', alias: 'approval-forms', kind: 'boolean', fallback: 'false', workspace: { key: 'approval.forms', change: 'buckle workspace set approval.forms on|off' } },
  // The decision AI (D91): every workspace's defaults where its own settings hold none. Its key and base URL are the node's
  // alone, left to a hand edit, and never listed here.
  { key: 'BUCKLE_APPROVAL_JUDGE', alias: 'approval-judge', kind: 'judge-mode', fallback: 'off', workspace: { key: 'approval.judge', change: 'buckle workspace set approval.judge off|on-request|automated' } },
  { key: 'BUCKLE_APPROVAL_JUDGE_PROVIDER', alias: 'approval-judge-provider', kind: 'judge-provider', fallback: 'openai-compatible', workspace: { key: 'approval.judgeProvider', change: 'buckle workspace set approval.judgeProvider openai-compatible' } },
  { key: 'BUCKLE_APPROVAL_JUDGE_MODEL', alias: 'approval-judge-model', kind: 'judge-model', fallback: 'gpt-6-luna', workspace: { key: 'approval.judgeModel', change: 'buckle workspace set approval.judgeModel <model>' } },
  { key: 'BUCKLE_APPROVAL_QUICK_JUDGE', alias: 'approval-quick-judge', kind: 'quick-scope', fallback: 'off', workspace: { key: 'approval.quickJudge', change: 'buckle workspace set approval.quickJudge off|interpreters|asks|all' } },
  { key: 'BUCKLE_APPROVAL_QUICK_JUDGE_MODEL', alias: 'approval-quick-judge-model', kind: 'judge-model', fallback: 'jev-latest', workspace: { key: 'approval.quickJudgeModel', change: 'buckle workspace set approval.quickJudgeModel <model>' } },
  { key: 'BUCKLE_APPROVAL_JUDGE_STANDARD_SCRIPTS', alias: 'approval-judge-standard-scripts', kind: 'script-list', fallback: '(the built-in list: npm run *, pnpm dev, npx vitest *, and the rest)', workspace: { key: 'approval.judgeStandardScripts', change: 'buckle workspace set approval.judgeStandardScripts <globs separated by ;;>' } },
  // The delete policy (the delete policy brief): every workspace's defaults where its own settings hold none.
  { key: 'BUCKLE_DELETE_IN_WORKSPACE', alias: 'delete-in-workspace', kind: 'delete-mode', fallback: 'allow', workspace: { key: 'files.deleteInWorkspace', change: 'buckle workspace set files.deleteInWorkspace allow|ask' } },
  { key: 'BUCKLE_MASS_DELETE_LIMIT', alias: 'mass-delete-limit', kind: 'entry-limit', fallback: '100', workspace: { key: 'files.massDeleteLimit', change: 'buckle workspace set files.massDeleteLimit <entries>' } },
  // Every workspace's mounts where its own table holds none (Phase 2 item 1): writable without asking, at their own path.
  { key: 'BUCKLE_SCRATCH_ROOTS', alias: 'scratch-roots', kind: 'directory-list', fallback: '(none)', workspace: { key: 'mounts', change: 'buckle workspace mount add <folder>:<sandbox-path>' } },
  { key: 'BUCKLE_WORKSPACE_MOUNT', alias: 'mount', kind: 'mount', fallback: '(none: the real path shows through)', workspace: { key: 'mount', change: 'buckle workspace set mount <path>' } },
  { key: 'BUCKLE_PACKS', alias: 'packs', kind: 'packs', fallback: '(every built-in pack, and plugins)', workspace: { key: 'packs.enabled', change: 'buckle workspace set packs.enabled <packs>' } },
  { key: 'BUCKLE_ALLOW_SHELL', alias: 'shell', kind: 'boolean', fallback: 'true', workspace: { key: 'packs.shell', change: 'buckle workspace set packs.shell on|off' } },
  // Code mode (owner decision D82): false withholds code_run and code_api.
  { key: 'BUCKLE_ALLOW_CODE', alias: 'code', kind: 'boolean', fallback: 'true', workspace: { key: 'packs.code', change: 'buckle workspace set packs.code on|off' } },
  // The change history tools (slice D, rollback): false withholds history_list and history_restore.
  { key: 'BUCKLE_ALLOW_HISTORY', alias: 'history', kind: 'boolean', fallback: 'true', workspace: { key: 'packs.history', change: 'buckle workspace set packs.history on|off' } },
  { key: 'BUCKLE_ALLOW_HOST_GIT', alias: 'host-git', kind: 'boolean', fallback: 'false', workspace: { key: 'packs.hostGit', change: 'buckle workspace set packs.hostGit on|off' } },
  // The shell's network and isolation (Phase 2 item 4): every workspace's defaults where its own settings hold none.
  { key: 'BUCKLE_SHELL_NETWORK', alias: 'shell-network', kind: 'boolean', fallback: 'false', workspace: { key: 'shell.network', change: 'buckle workspace set shell.network on|off' } },
  { key: 'BUCKLE_SHELL_ISOLATION', alias: 'shell-isolation', kind: 'boolean', fallback: 'true', workspace: { key: 'shell.isolation', change: 'buckle workspace set shell.isolation on|off' } },
  // The node's mounts, read-only (Phase 2 item 1): a JSON list the page on mounts shows, kept as the file holds it.
  { key: 'BUCKLE_MOUNTS', alias: 'mounts', kind: 'mounts', fallback: '(none)', workspace: { key: 'mounts', change: 'buckle workspace mount add <local>:<sandbox>[:ro]' } },
  // The browser (Phase 2 item 6): the owner's Chrome to attach to, or the profile, arguments, and window of the one Buckle launches.
  { key: 'BUCKLE_BROWSER_CDP', alias: 'browser-cdp', kind: 'browser-cdp', fallback: '(none)', logsValue: false, workspace: { key: 'browser.cdp', change: 'buckle workspace set browser.cdp <port or URL>' } },
  { key: 'BUCKLE_BROWSER_PROFILE', alias: 'browser-profile', kind: 'browser-profile', fallback: '(none: a fresh browser)', logsValue: false, workspace: { key: 'browser.profile', change: 'buckle workspace set browser.profile <absolute folder>' } },
  { key: 'BUCKLE_BROWSER_ARGS', alias: 'browser-args', kind: 'browser-args', fallback: '(none)', logsValue: false, workspace: { key: 'browser.args', change: 'buckle workspace set browser.args <arguments>' } },
  { key: 'BUCKLE_BROWSER_HEADED', alias: 'browser-headed', kind: 'boolean', fallback: 'false', workspace: { key: 'browser.headed', change: 'buckle workspace set browser.headed on|off' } },
  { key: 'BUCKLE_ALLOW_HOST_LSP', alias: 'host-lsp', kind: 'boolean', fallback: 'false', workspace: { key: 'packs.hostLsp', change: 'buckle workspace set packs.hostLsp on|off' } },
  { key: 'BUCKLE_COMMAND_ALLOW', alias: 'command-allow', kind: 'command-list', fallback: '(none: no allow list)', workspace: { key: 'policy.commands.allow', change: 'buckle policy allow-command <glob>' } },
  { key: 'BUCKLE_COMMAND_DENY', alias: 'command-deny', kind: 'command-list', fallback: '(none)', workspace: { key: 'policy.commands.deny', change: 'buckle policy deny-command <glob>, which adds to the node\'s' } },
  { key: 'BUCKLE_COMMAND_DESTRUCTIVE', alias: 'command-destructive', kind: 'command-list', fallback: '(none: the built-in floor alone)', workspace: { key: 'policy.commands.destructive', change: 'buckle policy destructive-command <glob>, which adds to the node\'s' } },
  // Folded into the node's URL list (Phase 2 item 5): an exact host of it clears a private address, as any exact entry does.
  { key: 'BUCKLE_ALLOWED_HOSTS', alias: 'allowed-hosts', kind: 'host-list', fallback: '(none)', workspace: { key: 'policy.network.allow', change: 'buckle policy allow-url <host>' } },
  { key: 'BUCKLE_NETWORK_ALLOW', alias: 'network-allow', kind: 'url-list', fallback: '(none: the default egress rules)', workspace: { key: 'policy.network.allow', change: 'buckle policy allow-url <host>' } },
  { key: 'BUCKLE_ALLOWED_INTERPRETERS', alias: 'allowed-interpreters', kind: 'interpreter-list', fallback: '(none: every interpreter runs unknown code)', workspace: { key: 'policy.commands.allowedInterpreters', change: 'buckle policy allow-interpreter <name>' } },
]

/**
 * BUCKLE_WORKSPACE_ROOT, which a node set up before workspaces kept here: read once, when it moves onto them, as the
 * folder of the workspace it makes, and never after (fix brief 1, B). `buckle settings unset root` removes the line, as
 * the move's notice asks; `set` is refused, naming the command that serves a folder now.
 */
export const ROOT_SETTING = Object.freeze({ key: 'BUCKLE_WORKSPACE_ROOT', alias: 'root', replacement: 'buckle workspace init --dir <folder>' })

/** Node settings by a name an owner may type for them that is not a key or an alias (Q3): the node's alone, and no workspace's. */
const NODE_ONLY_WORDS: ReadonlyMap<string, string> = new Map([
  ['host', 'BUCKLE_HOST'], ['port', 'BUCKLE_PORT'], ['admin-token', 'BUCKLE_ADMIN_TOKEN'], ['adminToken', 'BUCKLE_ADMIN_TOKEN'],
  ['state-dir', 'BUCKLE_STATE_DIR'], ['stateDir', 'BUCKLE_STATE_DIR'], ['server-id', 'BUCKLE_SERVER_ID'], ['serverId', 'BUCKLE_SERVER_ID'],
  ['server-name', 'BUCKLE_SERVER_NAME'], ['serverName', 'BUCKLE_SERVER_NAME'], ['sandbox', 'BUCKLE_SANDBOX'], ['log-level', 'BUCKLE_LOG_LEVEL'],
  ['judge-api-key', 'BUCKLE_JUDGE_API_KEY'], ['judgeApiKey', 'BUCKLE_JUDGE_API_KEY'], ['judge-base-url', 'BUCKLE_JUDGE_BASE_URL'], ['judgeBaseUrl', 'BUCKLE_JUDGE_BASE_URL'],
  ['quick-judge-api-key', 'BUCKLE_QUICK_JUDGE_API_KEY'], ['quickJudgeApiKey', 'BUCKLE_QUICK_JUDGE_API_KEY'], ['quick-judge-base-url', 'BUCKLE_QUICK_JUDGE_BASE_URL'], ['quickJudgeBaseUrl', 'BUCKLE_QUICK_JUDGE_BASE_URL'],
  ['socket-api-key', 'BUCKLE_SOCKET_API_KEY'], ['socketApiKey', 'BUCKLE_SOCKET_API_KEY'], ['socket-base-url', 'BUCKLE_SOCKET_BASE_URL'], ['socketBaseUrl', 'BUCKLE_SOCKET_BASE_URL'],
])

/**
 * Why `buckle workspace set` or `unset` refuses a key that names a node setting, or null: a node-only setting is the
 * same for every workspace and changes with `buckle settings set`; a workspace default names the workspace's own key.
 */
export function nodeSettingRefusal(key: string, restart = 'restart buckle serve'): string | null {
  const named = key.toUpperCase().startsWith('BUCKLE_') ? key.toUpperCase() : NODE_ONLY_WORDS.get(key)
  const setting = NODE_SETTINGS.find(item => item.key === named || item.alias === key)
  if (setting?.workspace) return `${key} is the node's default for every workspace (${setting.key}); buckle settings set ${setting.alias} <value> changes it there. This workspace's own is ${setting.workspace.key}: ${setting.workspace.change}.`
  if (setting) return `${key} is a node setting (${setting.key}), the same for every workspace, so no workspace sets it: buckle settings set ${setting.alias} <value> changes it.`
  if (named === undefined) return null
  return `${key} is a node setting (${named}), the same for every workspace, so no workspace sets it. buckle settings set does not write it: change it in the node's buckle.env, and ${restart}.`
}

const TRUE_WORDS = new Set(['true', 'on', 'yes', '1'])
const FALSE_WORDS = new Set(['false', 'off', 'no', '0'])
const MAX_NAME_LENGTH = 200

export function findNodeSetting(name: string): NodeSetting | undefined {
  return NODE_SETTINGS.find(setting => setting.key === name || setting.alias === name)
}

export type SettingValue = { ok: true; value: string } | { ok: false; reason: string }

/**
 * The value as the environment file will hold it, or why it is refused. Lists are written comma
 * separated with no spaces, booleans as `true` or `false`, directories as absolute paths.
 */
export function normaliseSetting(input: { setting: NodeSetting; raw: string; cwd: string; isDirectory: (path: string) => boolean; environment?: NodeJS.ProcessEnv; fileValues?: Readonly<Record<string, string | undefined>> }): SettingValue {
  const value = normaliseValue(input)
  if (!value.ok || !(input.setting.key in BROWSER_SETTING_FIELDS)) return value
  // The file is read as one browser block at start, so a value that cannot stand beside the others stops the node there: refused here, before it is written.
  const refusal = browserBlockRefusal(browserBlockWith(input.fileValues ?? {}, input.setting.key, value.value), process.platform)
  return refusal === null ? value : refuse(refusal)
}

/** The browser variables and the field of a browser block each sets. */
const BROWSER_SETTING_FIELDS: Readonly<Record<string, 'cdp' | 'profile' | 'args' | 'headed'>> = { BUCKLE_BROWSER_CDP: 'cdp', BUCKLE_BROWSER_PROFILE: 'profile', BUCKLE_BROWSER_ARGS: 'args', BUCKLE_BROWSER_HEADED: 'headed' }

/** The browser block the file would hold with `key` set to `value`. */
function browserBlockWith(file: Readonly<Record<string, string | undefined>>, key: string, value: string): { cdp?: string; profile?: string; args?: string; headed?: boolean } {
  const held = { ...file, [key]: value }
  return {
    ...(held.BUCKLE_BROWSER_CDP ? { cdp: held.BUCKLE_BROWSER_CDP } : {}),
    ...(held.BUCKLE_BROWSER_PROFILE ? { profile: held.BUCKLE_BROWSER_PROFILE } : {}),
    ...(held.BUCKLE_BROWSER_ARGS ? { args: held.BUCKLE_BROWSER_ARGS } : {}),
    headed: held.BUCKLE_BROWSER_HEADED === 'true',
  }
}

function normaliseValue(input: { setting: NodeSetting; raw: string; cwd: string; isDirectory: (path: string) => boolean; environment?: NodeJS.ProcessEnv }): SettingValue {
  const raw = input.raw.trim()
  // A list of mounts is JSON, which holds double quotes.
  if (/[\r\n\0]/.test(raw) || (input.setting.kind !== 'mounts' && raw.includes('"'))) return refuse(`${input.setting.key} cannot hold a newline${input.setting.kind === 'mounts' ? '' : ' or a double quote'}`)
  switch (input.setting.kind) {
    case 'boolean': {
      const word = raw.toLowerCase()
      if (TRUE_WORDS.has(word)) return { ok: true, value: 'true' }
      if (FALSE_WORDS.has(word)) return { ok: true, value: 'false' }
      return refuse(`${input.setting.key} is on or off: true, false, on, off, yes or no`)
    }
    case 'host-list': {
      const entries = list(raw)
      for (const entry of entries) {
        try {
          compileHostPattern(entry)
        } catch (error) {
          if (error instanceof UrlPatternError) return refuse(`Invalid ${input.setting.key} entry: ${error.message}`)
          throw error
        }
      }
      return listValue(input.setting, entries)
    }
    case 'directory-list':
      return directories(input, list(raw), paths => paths.join(','))
    case 'approval-wait':
      try {
        return { ok: true, value: String(parseApprovalTimeout(raw, 15_000) ?? 0) }
      } catch { return refuse('Approval wait must be milliseconds, 1 to 2147483647, or 0 to wait until someone answers') }
    case 'packs': {
      const ids = list(raw)
      if (ids.length === 0) return refuse(`${input.setting.key} needs at least one pack; unset it to offer every pack`)
      const unknown = ids.filter(id => !BUILTIN_PACKS.some(pack => pack.id === id))
      if (unknown.length) return refuse(`Unknown pack ${unknown.join(', ')}. Packs: ${BUILTIN_PACKS.map(pack => pack.id).join(', ')}`)
      const packOptions = { environmentValidator: input.environment?.BUCKLE_ENV_VALIDATOR_COMMAND || undefined }
      const unmet = ids.flatMap(id => { const reason = unmetPackPrerequisite(id, packOptions); return reason ? [`${id} (${reason})`] : [] })
      if (unmet.length) return refuse(`The node would not build pack ${unmet.join(', ')}. Set the prerequisite first, or leave the pack out`)
      return { ok: true, value: ids.join(',') }
    }
    case 'mount':
      return compiled(() => compilePolicy({ ...emptyWorkspacePolicy(), mount: raw }), raw)
    case 'url-list': {
      const entries = list(raw)
      const refused = refusedNetworkEntries(entries)
      if (refused.length) return refuse(`Invalid ${input.setting.key} entry ${refused[0]!.entry}: ${refused[0]!.reason}`)
      return listValue(input.setting, entries)
    }
    case 'interpreter-list': {
      const names = list(raw)
      const unknown = names.find(name => !isInterpreter(name))
      if (unknown !== undefined) return refuse(`Invalid ${input.setting.key} entry ${unknown}: not an interpreter Buckle reads as unknown: ${INTERPRETER_NAMES}`)
      return listValue(input.setting, names)
    }
    case 'command-list': {
      // Globs hold commas and spaces, so they are separated by ;; as the node reads them (policyFromEnvironment).
      const globs = [...new Set(raw.split(';;').map(item => item.trim()).filter(Boolean))]
      if (globs.length === 0) return refuse(`${input.setting.key} needs at least one glob, separated by ;;; unset it to clear the list`)
      return compiled(() => compilePolicy({ ...emptyWorkspacePolicy(), commands: { allow: globs, deny: [] } }), globs.join(';;'))
    }
    case 'script-list': {
      // The standard scripts (fix brief 1, item 19): unset is Buckle's built-in list, so an empty value is kept as none.
      const globs = [...new Set(raw.split(';;').map(item => item.trim()).filter(Boolean))]
      if (globs.length === 0) return { ok: true, value: '' }
      const value = compiled(() => compilePolicy({ ...emptyWorkspacePolicy(), commands: { allow: globs, deny: [] } }), globs.join(';;'))
      return value.ok ? value : refuse(`${value.reason}; set it empty for none; unset it for the built-in list`)
    }
    case 'mounts': {
      let mounts: ReturnType<typeof parseSandboxMounts>
      try { mounts = parseSandboxMounts(raw) } catch (error) { return refuse(error instanceof Error ? error.message : String(error)) }
      if (mounts.length === 0) return refuse(`${input.setting.key} needs at least one mount; unset it to clear the list`)
      // As the file holds it, `~/` unexpanded: the node expands it where it reads the list.
      return { ok: true, value: JSON.stringify(JSON.parse(raw)) }
    }
    case 'judge-mode':
      return (JUDGE_MODES as readonly string[]).includes(raw.toLowerCase()) ? { ok: true, value: raw.toLowerCase() } : refuse(`${input.setting.key} is ${JUDGE_MODES.join(', ')}`)
    case 'judge-provider':
      return (JUDGE_PROVIDERS as readonly string[]).includes(raw.toLowerCase()) ? { ok: true, value: raw.toLowerCase() } : refuse(`${input.setting.key} is ${JUDGE_PROVIDERS.join(' or ')}`)
    case 'quick-scope':
      return (QUICK_JUDGE_SCOPES as readonly string[]).includes(raw.toLowerCase()) ? { ok: true, value: raw.toLowerCase() } : refuse(`${input.setting.key} is ${QUICK_JUDGE_SCOPES.join(', ')}`)
    case 'judge-model':
      return JUDGE_MODEL_NAME.test(raw) ? { ok: true, value: raw } : refuse(`${input.setting.key} is a model name, with no blank, such as gpt-6-luna`)
    case 'delete-mode': {
      const mode = parseDeleteInWorkspace(raw)
      return mode === null ? refuse(`${input.setting.key} is allow or ask`) : { ok: true, value: mode }
    }
    case 'entry-limit': {
      const limit = parseMassDeleteLimit(raw)
      return limit === null ? refuse(`${input.setting.key} is entries, 0 to ${MAX_MASS_DELETE_LIMIT}, 0 for no limit`) : { ok: true, value: String(limit) }
    }
    case 'browser-cdp': return parsed(input.setting, raw, () => parseBrowserCdp(raw))
    case 'browser-profile': return parsed(input.setting, raw, () => parseBrowserProfile(raw, process.platform))
    case 'browser-args': return parsed(input.setting, raw, () => parseBrowserArgs(raw, process.platform))
    case 'name':
      if (!raw) return refuse(`${input.setting.key} cannot be empty; unset it for the default`)
      if (raw.length > MAX_NAME_LENGTH) return refuse(`${input.setting.key} is at most ${MAX_NAME_LENGTH} characters`)
      return { ok: true, value: raw }
  }
}

/** A browser value read as the node reads it at start; a refusal names the variable, never the value. */
function parsed(setting: NodeSetting, raw: string, read: () => string | undefined): SettingValue {
  if (!raw) return refuse(`${setting.key} needs a value; unset it for the default`)
  try {
    const value = read()
    return value === undefined ? refuse(`${setting.key} needs a value; unset it for the default`) : { ok: true, value }
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error))
  }
}

function directories(input: { setting: NodeSetting; cwd: string; isDirectory: (path: string) => boolean }, entries: string[], join: (paths: string[]) => string): SettingValue {
  if (entries.length === 0 || entries.some(entry => !entry)) return refuse(`${input.setting.key} needs a directory; unset it for the default`)
  const paths = entries.map(entry => (isAbsolute(entry) ? resolve(entry) : resolve(input.cwd, entry)))
  const missing = paths.find(path => !input.isDirectory(path))
  if (missing) return refuse(`${missing} is not an existing directory`)
  return { ok: true, value: join(paths) }
}

function listValue(setting: NodeSetting, entries: string[]): SettingValue {
  if (entries.length === 0) return refuse(`${setting.key} needs at least one entry; unset it to clear the list`)
  return { ok: true, value: entries.join(',') }
}

function list(raw: string): string[] {
  return [...new Set(raw.split(',').map(item => item.trim()).filter(Boolean))]
}

/** The value where Buckle compiles it as a workspace's own would be, or the policy's refusal. */
function compiled(compile: () => unknown, value: string): SettingValue {
  try {
    compile()
    return { ok: true, value }
  } catch (error) {
    if (error instanceof PolicyError) return refuse(error.message)
    throw error
  }
}

function refuse(reason: string): SettingValue {
  return { ok: false, reason }
}
