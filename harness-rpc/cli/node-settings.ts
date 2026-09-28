import { parseApprovalTimeout } from '../common/runtime/config.js'
import { isAbsolute, resolve } from 'node:path'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { BUILTIN_PACKS, unmetPackPrerequisite } from '../common/services/packs/index.js'
import { compilePolicy, PolicyError, refusedNetworkEntries } from '../common/domain/policy.js'
import { compileHostPattern, UrlPatternError } from '../common/domain/url-pattern.js'

/**
 * The node settings `BUCKLE-D19` names: what the owner changes with `buckle settings` or answers in
 * `buckle init`, written to the environment file and read when the node starts. Every other
 * variable, credentials above all, is left to a hand edit and never printed.
 */
export interface NodeSetting {
  key: string
  /** The short name `buckle settings set` also accepts. */
  alias: string
  kind: 'approval-wait' | 'boolean' | 'packs' | 'host-list' | 'url-list' | 'directory' | 'directory-list' | 'mount' | 'name'
  /** What the node does when the key is unset, as `buckle settings show` prints it. */
  fallback: string
}

export const NODE_SETTINGS: readonly NodeSetting[] = [
  { key: 'BUCKLE_APPROVAL_TIMEOUT_MS', alias: 'approval-wait', kind: 'approval-wait', fallback: '15000' },
  { key: 'BUCKLE_SERVER_NAME', alias: 'name', kind: 'name', fallback: 'Local Buckle' },
  { key: 'BUCKLE_WORKSPACE_ROOT', alias: 'root', kind: 'directory', fallback: '(the directory buckle serve starts in)' },
  { key: 'BUCKLE_WORKSPACE_MOUNT', alias: 'mount', kind: 'mount', fallback: '(none: the real path shows through)' },
  { key: 'BUCKLE_SCRATCH_ROOTS', alias: 'scratch-roots', kind: 'directory-list', fallback: '(none)' },
  { key: 'BUCKLE_MOUNT_READ_ONLY', alias: 'read-only-paths', kind: 'directory-list', fallback: '(none)' },
  { key: 'BUCKLE_PACKS', alias: 'packs', kind: 'packs', fallback: '(every built-in pack, and plugins)' },
  { key: 'BUCKLE_ALLOW_SHELL', alias: 'shell', kind: 'boolean', fallback: 'true' },
  { key: 'BUCKLE_ALLOW_HOST_GIT', alias: 'host-git', kind: 'boolean', fallback: 'false' },
  { key: 'BUCKLE_NETWORK_ALLOW', alias: 'network-allow', kind: 'url-list', fallback: '(none: the default egress rules)' },
  { key: 'BUCKLE_ALLOWED_HOSTS', alias: 'allowed-hosts', kind: 'host-list', fallback: '(none)' },
  // Owner decision D8: the admin HTTP layer is experimental, off until this is on (and an admin credential is set).
  { key: 'BUCKLE_EXPERIMENTAL_ADMIN_HTTP', alias: 'experimental-admin-http', kind: 'boolean', fallback: 'false' },
]

const TRUE_WORDS = new Set(['true', 'on', 'yes', '1'])
const FALSE_WORDS = new Set(['false', 'off', 'no', '0'])
const MAX_NAME_LENGTH = 200

export function findNodeSetting(name: string): NodeSetting | undefined {
  return NODE_SETTINGS.find(setting => setting.key === name || setting.alias === name)
}

export type SettingValue = { ok: true; value: string } | { ok: false; reason: string }

/**
 * The value as the environment file will hold it, or why it is refused. Lists are written comma
 * separated with no spaces, booleans as `true` or `false`, directories as absolute paths. A pack
 * whose prerequisite `environment` (the file and process environment the node will start with)
 * does not meet is refused, naming it.
 */
export function normaliseSetting(input: { setting: NodeSetting; raw: string; cwd: string; isDirectory: (path: string) => boolean; environment: NodeJS.ProcessEnv }): SettingValue {
  const raw = input.raw.trim()
  if (/[\r\n\0"]/.test(raw)) return refuse(`${input.setting.key} cannot hold a newline or a double quote`)
  switch (input.setting.kind) {
    case 'boolean': {
      const word = raw.toLowerCase()
      if (TRUE_WORDS.has(word)) return { ok: true, value: 'true' }
      if (FALSE_WORDS.has(word)) return { ok: true, value: 'false' }
      return refuse(`${input.setting.key} is on or off: true, false, on, off, yes or no`)
    }
    case 'approval-wait': {
      try {
        const parsed = parseApprovalTimeout(raw, 15_000)
        return { ok: true, value: String(parsed ?? 0) }
      } catch { return refuse('Approval wait must be milliseconds, 1 to 2147483647, or 0 to wait until someone answers') }
    }
    case 'packs': {
      const ids = list(raw)
      if (ids.length === 0) return refuse(`${input.setting.key} needs at least one pack; unset it to enable every pack`)
      const unknown = ids.filter(id => !BUILTIN_PACKS.some(pack => pack.id === id))
      if (unknown.length) return refuse(`Unknown pack ${unknown.join(', ')}. Packs: ${BUILTIN_PACKS.map(pack => pack.id).join(', ')}`)
      const packOptions = { environmentValidator: input.environment.BUCKLE_ENV_VALIDATOR_COMMAND || undefined }
      const unmet = ids.flatMap(id => { const reason = unmetPackPrerequisite(id, packOptions); return reason ? [`${id} (${reason})`] : [] })
      if (unmet.length) return refuse(`The node would not start with pack ${unmet.join(', ')}. Set the prerequisite first, or leave the pack out`)
      return { ok: true, value: ids.join(',') }
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
    case 'url-list': {
      const entries = list(raw)
      const refused = refusedNetworkEntries(entries)
      if (refused.length) return refuse(`Invalid ${input.setting.key} entry ${refused[0]!.entry}: ${refused[0]!.reason}`)
      return listValue(input.setting, entries)
    }
    case 'directory':
      return directories(input, [raw], paths => paths[0]!)
    case 'directory-list':
      return directories(input, list(raw), paths => paths.join(','))
    case 'mount':
      try {
        compilePolicy({ ...emptyWorkspacePolicy(), mount: raw })
        return { ok: true, value: raw }
      } catch (error) {
        if (error instanceof PolicyError) return refuse(error.message)
        throw error
      }
    case 'name':
      if (!raw) return refuse(`${input.setting.key} cannot be empty; unset it for the default`)
      if (raw.length > MAX_NAME_LENGTH) return refuse(`${input.setting.key} is at most ${MAX_NAME_LENGTH} characters`)
      return { ok: true, value: raw }
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

function refuse(reason: string): SettingValue {
  return { ok: false, reason }
}
