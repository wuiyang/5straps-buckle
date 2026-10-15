import { parseApprovalTimeout } from '../common/runtime/config.js'
import { BUILTIN_PACKS } from '../common/services/packs/index.js'
import { defaultSettings, type WorkspaceSettings } from '../common/services/workspaces/workspace-settings.js'

/** A setting `buckle workspace set` and `unset` change, by its path in workspace.json. */
export interface SettingKey {
  key: string
  /** What `buckle workspace show` says it takes. */
  takes: string
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

const defaults = defaultSettings()
const pack = (name: 'shell' | 'code' | 'hostGit' | 'hostLsp'): SettingKey => ({
  key: `packs.${name}`,
  takes: `on or off (${defaults.packs[name] ? 'on' : 'off'} by default)`,
  set: (settings, raw) => ({ ...settings, packs: { ...settings.packs, [name]: onOff(`packs.${name}`, raw) } }),
  unset: settings => ({ ...settings, packs: { ...settings.packs, [name]: defaults.packs[name] } }),
})

export const SETTING_KEYS: readonly SettingKey[] = [
  {
    key: 'approvalWaitMs',
    takes: 'milliseconds a gated call waits for an answer, 0 until someone answers (15000 by default)',
    set: (settings, raw) => {
      let wait: number | null
      try { wait = parseApprovalTimeout(raw.trim(), 15_000) } catch { throw new SettingValueError('approvalWaitMs is milliseconds, 1 to 2147483647, or 0 to wait until someone answers') }
      return { ...settings, approvalWaitMs: wait ?? 0 }
    },
    unset: settings => ({ ...settings, approvalWaitMs: defaults.approvalWaitMs }),
  },
  {
    key: 'packs.enabled',
    takes: `the packs offered, comma separated, which turns plugins off: ${BUILTIN_PACKS.map(item => item.id).join(', ')} (every one, and plugins, by default)`,
    set: (settings, raw) => ({ ...settings, packs: { ...settings.packs, enabled: [...new Set(raw.split(',').map(item => item.trim()).filter(Boolean))] } }),
    unset: settings => ({ ...settings, packs: { ...settings.packs, enabled: null } }),
  },
  pack('shell'), pack('code'), pack('hostGit'), pack('hostLsp'),
]
