import { MountPathSchema } from '@5straps/protocol'
import { parseApprovalTimeout } from '../common/runtime/config.js'
import { BUILTIN_PACKS } from '../common/services/packs/index.js'
import { isAbsolute } from 'node:path'
import { typedPath } from '../common/domain/paths.js'
import { BROWSER_IDLE_BOUNDS, BUILT_IN_SETTINGS, withMount, type WorkspaceSettings } from '../common/services/workspaces/workspace-settings.js'

/**
 * A setting `buckle workspace set` and `unset` change, by its path in workspace.json. `set` gives the workspace a value
 * of its own; `unset` takes it out, so the node's value in buckle.env stands for it again, else Buckle's (D85, Q3).
 */
export interface SettingKey {
  key: string
  /** What `buckle workspace show` says it takes. */
  takes: string
  /**
   * False when the value is kept out of the node's audit log, as a variable's is (a DevTools URL can carry a token, an
   * argument a proxy password, a profile path the owner's folders): the log then records the key alone.
   */
  logsValue?: false
  set(settings: WorkspaceSettings, raw: string): WorkspaceSettings
  unset(settings: WorkspaceSettings): WorkspaceSettings
}

/** A value the key does not take, refused before anything is written. */
export class SettingValueError extends Error {}

const TRUE_WORDS = new Set(['true', 'on', 'yes', '1'])
const FALSE_WORDS = new Set(['false', 'off', 'no', '0'])

function onOff(key: string, raw: string): boolean {
  const word = raw.trim().toLowerCase()
  if (TRUE_WORDS.has(word)) return true
  if (FALSE_WORDS.has(word)) return false
  throw new SettingValueError(`${key} is on or off: true, false, on, off, yes or no`)
}

type PackKey = 'enabled' | 'shell' | 'code' | 'hostGit' | 'hostLsp'

/** The packs block with `name` taken out: unset, so the node's value stands for it. */
function withoutPack(settings: WorkspaceSettings, name: PackKey): WorkspaceSettings {
  const { [name]: _dropped, ...packs } = settings.packs
  return { ...settings, packs }
}

const pack = (name: 'shell' | 'code' | 'hostGit' | 'hostLsp'): SettingKey => ({
  key: `packs.${name}`,
  takes: `on or off (the node's, else ${BUILT_IN_SETTINGS.packs[name] ? 'on' : 'off'})`,
  set: (settings, raw) => ({ ...settings, packs: { ...settings.packs, [name]: onOff(`packs.${name}`, raw) } }),
  unset: settings => withoutPack(settings, name),
})

/** The shell block with `name` taken out: unset, so the node's value stands for it. */
function withoutShell(settings: WorkspaceSettings, name: 'network' | 'isolation'): WorkspaceSettings {
  const { [name]: _dropped, ...shell } = settings.shell
  return { ...settings, shell }
}

type BrowserKey = 'idleTimeoutMs' | 'cdp' | 'profile' | 'args' | 'headed'

/** The browser block with `name` taken out: unset, so the node's value stands for it. */
function withoutBrowser(settings: WorkspaceSettings, name: BrowserKey): WorkspaceSettings {
  const { [name]: _dropped, ...browser } = settings.browser
  return { ...settings, browser }
}

/**
 * A browser setting (Phase 2 item 6, Q10), over the node's own (BUCKLE_BROWSER_CDP and its kin): each value is checked
 * with the rest before anything is written (browserSettingsRefusal), naming the key and never the value, and a profile
 * folder or an attached Chrome another workspace names as its own is refused, naming that workspace.
 */
const browser = (name: BrowserKey, takes: string, read: (raw: string) => WorkspaceSettings['browser'][BrowserKey], logsValue?: false): SettingKey => ({
  key: `browser.${name}`,
  takes,
  ...(logsValue === false ? { logsValue } : {}),
  set: (settings, raw) => ({ ...settings, browser: { ...settings.browser, [name]: read(raw) } }),
  unset: settings => withoutBrowser(settings, name),
})

/** Milliseconds an idle browser lives (Q10): a minute to a day, and never 0, which would keep it for good. */
function idleTimeout(raw: string): number {
  const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN
  if (!Number.isSafeInteger(value) || value < BROWSER_IDLE_BOUNDS.min || value > BROWSER_IDLE_BOUNDS.max) throw new SettingValueError(`browser.idleTimeoutMs is milliseconds, ${BROWSER_IDLE_BOUNDS.min} (a minute) to ${BROWSER_IDLE_BOUNDS.max} (a day); 0 is refused, as an idle browser always ends`)
  return value
}

/** A shell setting (Phase 2 item 4), on or off, over the node's BUCKLE_SHELL_NETWORK or BUCKLE_SHELL_ISOLATION. */
const shell = (name: 'network' | 'isolation', what: string): SettingKey => ({
  key: `shell.${name}`,
  takes: `on or off: ${what} (the node's, else ${BUILT_IN_SETTINGS.shell[name] ? 'on' : 'off'})`,
  set: (settings, raw) => ({ ...settings, shell: { ...settings.shell, [name]: onOff(`shell.${name}`, raw) } }),
  unset: settings => withoutShell(settings, name),
})

export const SETTING_KEYS: readonly SettingKey[] = [
  {
    key: 'approvalWaitMs',
    takes: `milliseconds a gated call waits for an answer, 0 until someone answers (the node's, else ${BUILT_IN_SETTINGS.approvalWaitMs})`,
    set: (settings, raw) => {
      let wait: number | null
      try { wait = parseApprovalTimeout(raw.trim(), BUILT_IN_SETTINGS.approvalWaitMs) } catch { throw new SettingValueError('approvalWaitMs is milliseconds, 1 to 2147483647, or 0 to wait until someone answers') }
      return { ...settings, approvalWaitMs: wait ?? 0 }
    },
    unset: ({ approvalWaitMs: _dropped, ...settings }) => settings,
  },
  {
    key: 'packs.enabled',
    takes: `the packs offered, comma separated, which turns plugins off: ${BUILTIN_PACKS.map(item => item.id).join(', ')} (the node's, else every one, and plugins)`,
    set: (settings, raw) => ({ ...settings, packs: { ...settings.packs, enabled: [...new Set(raw.split(',').map(item => item.trim()).filter(Boolean))] } }),
    unset: settings => withoutPack(settings, 'enabled'),
  },
  pack('shell'), pack('code'), pack('hostGit'), pack('hostLsp'),
  shell('network', 'whether shell commands may reach the network while no approved URL list is set'),
  shell('isolation', 'whether each shell command runs on a private copy of the folder, published once it ends'),
  browser('idleTimeoutMs', `milliseconds an idle browser lives, ${BROWSER_IDLE_BOUNDS.min} to ${BROWSER_IDLE_BOUNDS.max} (Buckle's ${BUILT_IN_SETTINGS.browser.idleTimeoutMs})`, idleTimeout),
  browser('cdp', 'the DevTools port or URL of the owner\'s own Chrome to attach to (the node\'s BUCKLE_BROWSER_CDP, else none)', raw => raw.trim(), false),
  browser('profile', 'an absolute path to a profile folder kept across launches (the node\'s BUCKLE_BROWSER_PROFILE, else a fresh browser)', raw => (isAbsolute(raw.trim()) ? typedPath(raw.trim()) : raw.trim()), false),
  browser('args', 'Chromium arguments for a browser Buckle launches (the node\'s BUCKLE_BROWSER_ARGS, else none)', raw => raw.trim(), false),
  browser('headed', 'on or off: a visible window (the node\'s BUCKLE_BROWSER_HEADED, else off)', raw => onOff('browser.headed', raw)),
  {
    key: 'mount',
    takes: 'where the agent sees the folder, such as /workspace (the node\'s, else its real path)',
    set: (settings, raw) => {
      const mount = MountPathSchema.safeParse(raw.trim())
      if (!mount.success) throw new SettingValueError('mount is an absolute path with plain segments, such as /workspace')
      return withMount(settings, mount.data)
    },
    unset: settings => withMount(settings, undefined),
  },
]
