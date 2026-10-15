import { isAbsolute, resolve } from 'pathe'
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
  kind: 'boolean' | 'host-list' | 'directory-list' | 'name'
  /** What the node does when the key is unset, as `buckle settings show` prints it. */
  fallback: string
}

/** The node's own settings (Q3 of the workspace-model brief); every workspace's are in its workspace.json. */
export const NODE_SETTINGS: readonly NodeSetting[] = [
  { key: 'BUCKLE_SERVER_NAME', alias: 'name', kind: 'name', fallback: 'Local Buckle' },
  { key: 'BUCKLE_SCRATCH_ROOTS', alias: 'scratch-roots', kind: 'directory-list', fallback: '(none)' },
  { key: 'BUCKLE_MOUNT_READ_ONLY', alias: 'read-only-paths', kind: 'directory-list', fallback: '(none)' },
  { key: 'BUCKLE_ALLOWED_HOSTS', alias: 'allowed-hosts', kind: 'host-list', fallback: '(none)' },
  // Owner decision D8: the admin HTTP layer is experimental, off until this is on (and an admin credential is set).
  { key: 'BUCKLE_EXPERIMENTAL_ADMIN_HTTP', alias: 'experimental-admin-http', kind: 'boolean', fallback: 'false' },
]

/**
 * What a node set up before the workspace model kept in buckle.env and each workspace now holds in its own settings
 * (Q14), with the command that changes it there. `buckle settings set` refuses them, naming that command; `unset`
 * still removes a line migration already copied.
 */
export const MOVED_SETTINGS: ReadonlyArray<{ key: string; alias: string; replacement: string }> = [
  { key: 'BUCKLE_APPROVAL_TIMEOUT_MS', alias: 'approval-wait', replacement: 'buckle workspace set approvalWaitMs <milliseconds>' },
  { key: 'BUCKLE_WORKSPACE_ROOT', alias: 'root', replacement: 'buckle workspace init --dir <folder>' },
  { key: 'BUCKLE_WORKSPACE_MOUNT', alias: 'mount', replacement: 'buckle policy mount <path>' },
  { key: 'BUCKLE_PACKS', alias: 'packs', replacement: 'buckle workspace set packs.enabled <packs>' },
  { key: 'BUCKLE_ALLOW_SHELL', alias: 'shell', replacement: 'buckle workspace set packs.shell on|off' },
  { key: 'BUCKLE_ALLOW_CODE', alias: 'code', replacement: 'buckle workspace set packs.code on|off' },
  { key: 'BUCKLE_ALLOW_HOST_GIT', alias: 'host-git', replacement: 'buckle workspace set packs.hostGit on|off' },
  { key: 'BUCKLE_NETWORK_ALLOW', alias: 'network-allow', replacement: 'buckle policy allow-url <host>' },
  { key: 'BUCKLE_ALLOWED_INTERPRETERS', alias: 'allowed-interpreters', replacement: 'buckle policy allow-interpreter <name>' },
]

export function findMovedSetting(name: string): (typeof MOVED_SETTINGS)[number] | undefined {
  return MOVED_SETTINGS.find(setting => setting.key === name || setting.alias === name)
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
export function normaliseSetting(input: { setting: NodeSetting; raw: string; cwd: string; isDirectory: (path: string) => boolean }): SettingValue {
  const raw = input.raw.trim()
  if (/[\r\n\0"]/.test(raw)) return refuse(`${input.setting.key} cannot hold a newline or a double quote`)
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
