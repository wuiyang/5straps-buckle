import { MountPathSchema } from '@5straps/protocol'
import { parseApprovalTimeout } from '../common/runtime/config.js'
import { BUILTIN_PACKS } from '../common/services/packs/index.js'
import { BUILT_IN_SETTINGS, withMount, type WorkspaceSettings } from '../common/services/workspaces/workspace-settings.js'

/**
 * A setting `buckle workspace set` and `unset` change, by its path in workspace.json. `set` gives the workspace a value
 * of its own; `unset` takes it out, so the node's value in buckle.env stands for it again, else Buckle's (D85, Q3).
 */
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
