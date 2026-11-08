import { MountPathSchema } from '@5straps/protocol'
import { parseApprovalTimeout, parseBrowserCdp, parseBrowserProfile } from '../common/runtime/config.js'
import { BUILTIN_PACKS } from '../common/services/packs/index.js'
import { compileCommandGlob, CommandGlobError } from '../common/domain/command-glob.js'
import { BROWSER_IDLE_BOUNDS, BUILT_IN_SETTINGS, MAX_LISTED_SECRET_FILES, MAX_PRIVATE_RANGES, withMount, type WorkspaceSettings } from '../common/services/workspaces/workspace-settings.js'
import { cidrRefusal } from '../common/domain/ip.js'
import { referencePathRefusal } from '../common/domain/secret-reference.js'
import { JUDGE_MODEL_NAME, JUDGE_MODES, JUDGE_PROVIDERS } from '../common/types/ports/judge.js'
import { QUICK_JUDGE_PROVIDERS, QUICK_JUDGE_SCOPES } from '../common/types/ports/quick-judge.js'
import { MAX_MASS_DELETE_LIMIT, parseDeleteInWorkspace, parseMassDeleteLimit } from '../common/domain/delete-policy.js'
import { parseSessionIdle, SESSION_IDLE_BOUNDS } from '../common/domain/approval/session-idle.js'

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

type PackKey = 'enabled' | 'shell' | 'code' | 'history' | 'hostGit' | 'hostLsp'

/** The packs block with `name` taken out: unset, so the node's value stands for it. */
function withoutPack(settings: WorkspaceSettings, name: PackKey): WorkspaceSettings {
  const { [name]: _dropped, ...packs } = settings.packs
  return { ...settings, packs }
}

const pack = (name: Exclude<PackKey, 'enabled'>): SettingKey => ({
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

/**
 * A browser value stored as the node reads it from buckle.env (an endpoint's scheme in lower case, which agent-browser
 * reads in no other; a profile folder as the system types it). A value the parser refuses is stored as typed, for the
 * write check (browserSettingsRefusal) to refuse, naming the setting.
 */
function normalised(parse: (raw: string) => string | undefined): (raw: string) => string {
  return (raw) => {
    try { return parse(raw) ?? raw.trim() } catch { return raw.trim() }
  }
}

/** Milliseconds an idle browser lives (Q10): a minute to a day, and never 0, which would keep it for good. */
function idleTimeout(raw: string): number {
  const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN
  if (!Number.isSafeInteger(value) || value < BROWSER_IDLE_BOUNDS.min || value > BROWSER_IDLE_BOUNDS.max) throw new SettingValueError(`browser.idleTimeoutMs is milliseconds, ${BROWSER_IDLE_BOUNDS.min} (a minute) to ${BROWSER_IDLE_BOUNDS.max} (a day); 0 is refused, as an idle browser always ends`)
  return value
}

/** Milliseconds a session may go without activity of its own before it ends: a minute to a day, or 0, which ends none at idle. */
function sessionIdle(raw: string): number {
  const value = parseSessionIdle(raw)
  if (value === null) throw new SettingValueError(`approval.sessionIdleMs is milliseconds, ${SESSION_IDLE_BOUNDS.min} (a minute) to ${SESSION_IDLE_BOUNDS.max} (a day), or 0 to end no session at idle`)
  return value
}

/** A shell setting (Phase 2 item 4), on or off, over the node's BUCKLE_SHELL_NETWORK or BUCKLE_SHELL_ISOLATION. */
const shell = (name: 'network' | 'isolation', what: string): SettingKey => ({
  key: `shell.${name}`,
  takes: `on or off: ${what} (the node's, else ${BUILT_IN_SETTINGS.shell[name] ? 'on' : 'off'})`,
  set: (settings, raw) => ({ ...settings, shell: { ...settings.shell, [name]: onOff(`shell.${name}`, raw) } }),
  unset: settings => withoutShell(settings, name),
})

type ApprovalKey = 'forms' | 'sessionIdleMs' | 'judge' | 'judgeProvider' | 'judgeModel' | 'judgeStandardScripts' | 'quickJudge' | 'quickJudgeProvider' | 'quickJudgeModel'

/** The approval block with `name` taken out: unset, so the node's value stands for it. */
function withoutApproval(settings: WorkspaceSettings, name: ApprovalKey): WorkspaceSettings {
  const { [name]: _dropped, ...approval } = settings.approval
  return { ...settings, approval }
}

/** One word of a fixed set, refused naming the set. */
function oneOf<T extends string>(key: string, words: readonly T[], raw: string): T {
  const word = words.find(item => item === raw.trim().toLowerCase())
  if (word === undefined) throw new SettingValueError(`${key} is ${words.length === 2 ? words.join(' or ') : words.join(', ')}`)
  return word
}

/** Command globs separated by ;;, as the node's command lists are; an empty value is an empty list, no standard script. */
function standardScripts(raw: string): string[] {
  const globs = [...new Set(raw.split(';;').map(item => item.trim()).filter(Boolean))]
  for (const glob of globs) {
    try { compileCommandGlob(glob) } catch (error) {
      if (error instanceof CommandGlobError) throw new SettingValueError(`approval.judgeStandardScripts: ${error.message}`)
      throw error
    }
  }
  return globs
}

const approval = (name: ApprovalKey, takes: string, read: (raw: string) => WorkspaceSettings['approval'][ApprovalKey]): SettingKey => ({
  key: `approval.${name}`,
  takes,
  set: (settings, raw) => ({ ...settings, approval: { ...settings.approval, [name]: read(raw) } }),
  unset: settings => withoutApproval(settings, name),
})

type FilesKey = 'deleteInWorkspace' | 'massDeleteLimit'

/** The files block with `name` taken out, and the block itself once it holds nothing: unset, so the node's value stands for it. */
function withoutFiles(settings: WorkspaceSettings, name: FilesKey): WorkspaceSettings {
  const { files: block, ...rest } = settings
  const { [name]: _dropped, ...files } = block ?? {}
  return Object.keys(files).length === 0 ? rest : { ...rest, files }
}

/** A delete policy setting (the delete policy brief), over the node's BUCKLE_DELETE_IN_WORKSPACE or BUCKLE_MASS_DELETE_LIMIT. */
const files = <K extends FilesKey>(name: K, takes: string, read: (raw: string) => NonNullable<WorkspaceSettings['files']>[K]): SettingKey => ({
  key: `files.${name}`,
  takes,
  set: (settings, raw) => ({ ...settings, files: { ...settings.files, [name]: read(raw) } }),
  unset: settings => withoutFiles(settings, name),
})

function historySetting(name: 'keepTurns' | 'turnIdleMs' | 'maxFileBytes', max: number): SettingKey {
  return { key: `history.${name}`, takes: `integer, 1 to ${max} (Buckle's ${BUILT_IN_SETTINGS.history[name]})`,
    set(settings, raw) { const value = Number(raw); if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < 1 || value > max) throw new SettingValueError(`history.${name} is an integer, 1 to ${max}`); return { ...settings, history: { ...settings.history, [name]: value } } },
    unset(settings) { const { [name]: _dropped, ...history } = settings.history ?? {}; return { ...settings, history } },
  }
}

export const SETTING_KEYS: readonly SettingKey[] = [
  historySetting('keepTurns', 100), historySetting('turnIdleMs', 86_400_000), historySetting('maxFileBytes', 1_073_741_824),
  {
    key: 'approvalWaitMs',
    takes: `milliseconds a gated call waits for an answer, 0 until someone answers or its session ends (the node's, else ${BUILT_IN_SETTINGS.approvalWaitMs})`,
    set: (settings, raw) => {
      let wait: number | null
      try { wait = parseApprovalTimeout(raw.trim(), BUILT_IN_SETTINGS.approvalWaitMs) } catch { throw new SettingValueError('approvalWaitMs is milliseconds, 1 to 2147483647, or 0 to wait until someone answers or the session ends') }
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
  pack('shell'), pack('code'), pack('history'), pack('hostGit'), pack('hostLsp'),
  shell('network', 'whether shell commands may reach the network while no approved URL list is set'),
  shell('isolation', 'whether each shell command runs on a private copy of the folder, published once it ends'),
  approval('forms', `on or off: whether an MCP host's form answers decide this workspace's asks (the node's, else ${BUILT_IN_SETTINGS.approval.forms ? 'on' : 'off'})`, raw => onOff('approval.forms', raw)),
  approval('sessionIdleMs', `milliseconds without activity of its own before a session ends, or 0 for never at idle (the node's, else ${BUILT_IN_SETTINGS.approval.sessionIdleMs})`, sessionIdle),
  // The decision AI (D91): the node's BUCKLE_APPROVAL_JUDGE and its kin stand where these are unset.
  approval('judge', `off, on-request, or automated: whether the decision AI rates an interpreter call, when the owner asks or at each call (the node's, else ${BUILT_IN_SETTINGS.approval.judge})`, raw => oneOf('approval.judge', JUDGE_MODES, raw)),
  approval('judgeProvider', `openai-compatible: who rates it, with the node's key (the node's, else ${BUILT_IN_SETTINGS.approval.judgeProvider})`, raw => oneOf('approval.judgeProvider', JUDGE_PROVIDERS, raw)),
  approval('judgeModel', `the model that rates it, as the endpoint names it (the node's, else ${BUILT_IN_SETTINGS.approval.judgeModel})`, (raw) => {
    if (!JUDGE_MODEL_NAME.test(raw.trim())) throw new SettingValueError('approval.judgeModel is a model name, with no blank, such as gpt-6-luna')
    return raw.trim()
  }),
  approval('judgeStandardScripts', 'command globs separated by ;;, rated on their command line alone; empty for none (the node\'s, else the built-in list)', standardScripts),
  approval('quickJudge', `off, interpreters, asks, or all: which calls the quick stage rates first (the node's, else ${BUILT_IN_SETTINGS.approval.quickJudge})`, raw => oneOf('approval.quickJudge', QUICK_JUDGE_SCOPES, raw)),
  approval('quickJudgeProvider', `typesafe: who rates them, with the node's quick key (Buckle's ${BUILT_IN_SETTINGS.approval.quickJudgeProvider})`, raw => oneOf('approval.quickJudgeProvider', QUICK_JUDGE_PROVIDERS, raw)),
  approval('quickJudgeModel', `the quick stage's model (the node's, else ${BUILT_IN_SETTINGS.approval.quickJudgeModel})`, (raw) => {
    if (!JUDGE_MODEL_NAME.test(raw.trim())) throw new SettingValueError('approval.quickJudgeModel is a model name, with no blank, such as jev-latest')
    return raw.trim()
  }),
  browser('idleTimeoutMs', `milliseconds an idle browser lives, ${BROWSER_IDLE_BOUNDS.min} to ${BROWSER_IDLE_BOUNDS.max} (Buckle's ${BUILT_IN_SETTINGS.browser.idleTimeoutMs})`, idleTimeout),
  browser('cdp', 'the DevTools port or URL of the owner\'s own Chrome to attach to (the node\'s BUCKLE_BROWSER_CDP, else none)', normalised(parseBrowserCdp), false),
  browser('profile', 'an absolute path to a profile folder kept across launches (the node\'s BUCKLE_BROWSER_PROFILE, else a fresh browser)', normalised(raw => parseBrowserProfile(raw, process.platform)), false),
  browser('args', 'Chromium arguments for a browser Buckle launches (the node\'s BUCKLE_BROWSER_ARGS, else none)', raw => raw.trim(), false),
  browser('headed', 'on or off: a visible window (the node\'s BUCKLE_BROWSER_HEADED, else off)', raw => onOff('browser.headed', raw)),
  {
    key: 'secrets.enabled',
    takes: `on or off: whether Buckle reads the secret references {{file:<path>:NAME}} in shell words, browser fill values, and web_fetch headers (Buckle's ${BUILT_IN_SETTINGS.secrets.enabled ? 'on' : 'off'})`,
    set: (settings, raw) => ({ ...settings, secrets: { ...settings.secrets, enabled: onOff('secrets.enabled', raw) } }),
    unset: (settings) => {
      const { secrets: block, ...rest } = settings
      const { enabled: _dropped, ...secrets } = block ?? {}
      return Object.keys(secrets).length === 0 ? rest : { ...rest, secrets }
    },
  },
  {
    key: 'secrets.files',
    takes: 'files whose secret references need no ask, comma separated, by their paths in the folder as a reference writes them, such as .env.local; empty for none (Buckle\'s none)',
    set: (settings, raw) => {
      const files = [...new Set(raw.split(',').map(item => item.trim()).filter(Boolean))]
      for (const file of files) {
        const refusal = referencePathRefusal(file)
        if (refusal) throw new SettingValueError(`secrets.files: ${file}: ${refusal}`)
      }
      if (files.length > MAX_LISTED_SECRET_FILES) throw new SettingValueError(`secrets.files lists at most ${MAX_LISTED_SECRET_FILES} files`)
      return { ...settings, secrets: { ...settings.secrets, files } }
    },
    unset: (settings) => {
      const { secrets: block, ...rest } = settings
      const { files: _dropped, ...secrets } = block ?? {}
      return Object.keys(secrets).length === 0 ? rest : { ...rest, secrets }
    },
  },
  {
    key: 'network.privateRanges',
    takes: 'CIDR ranges, comma separated, whose private, loopback, or reserved addresses network tools reach without asking, such as 10.0.0.0/8 or fd00::/8; never a hostname or a wildcard; empty for none (the node\'s, else none)',
    set: (settings, raw) => {
      const ranges = [...new Set(raw.split(',').map(item => item.trim()).filter(Boolean))]
      for (const range of ranges) {
        const refusal = cidrRefusal(range)
        if (refusal) throw new SettingValueError(`network.privateRanges: ${range}: ${refusal}`)
      }
      if (ranges.length > MAX_PRIVATE_RANGES) throw new SettingValueError(`network.privateRanges lists at most ${MAX_PRIVATE_RANGES} ranges`)
      return { ...settings, network: { ...settings.network, privateRanges: ranges } }
    },
    unset: (settings) => {
      const { network: block, ...rest } = settings
      const { privateRanges: _dropped, ...network } = block ?? {}
      return Object.keys(network).length === 0 ? rest : { ...rest, network }
    },
  },
  files('deleteInWorkspace', `allow or ask: whether a delete inside the workspace's own folder runs where its writes are granted, or always asks a person (the node's, else ${BUILT_IN_SETTINGS.files.deleteInWorkspace})`, (raw) => {
    const mode = parseDeleteInWorkspace(raw)
    if (mode === null) throw new SettingValueError('files.deleteInWorkspace is allow or ask')
    return mode
  }),
  files('massDeleteLimit', `entries one call may delete in the folder before a person is asked anyway, 0 to ${MAX_MASS_DELETE_LIMIT}, 0 for no limit (the node's, else ${BUILT_IN_SETTINGS.files.massDeleteLimit})`, (raw) => {
    const limit = parseMassDeleteLimit(raw)
    if (limit === null) throw new SettingValueError(`files.massDeleteLimit is entries, 0 to ${MAX_MASS_DELETE_LIMIT}, 0 for no limit`)
    return limit
  }),
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
