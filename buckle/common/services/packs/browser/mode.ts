import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute } from 'pathe'
import { browserArguments, chromiumSwitch } from '../../../domain/browser-arguments.js'
import { placesOnTheWay, type UntrustedRoots } from '../../../domain/executable.js'
import { ignoresCase, isInsideComparable, typedPath } from '../../../domain/paths.js'

/**
 * Which browser `browser_command` drives, chosen by the owner's settings alone: a fresh one for each session (the
 * default), one on the owner's profile folder (BUCKLE_BROWSER_PROFILE), or the owner's own Chrome, attached over its
 * DevTools port (BUCKLE_BROWSER_CDP). No argument an agent sends selects one.
 */
export type BrowserMode =
  | { kind: 'fresh' }
  | { kind: 'profile'; directory: string }
  | { kind: 'attached'; endpoint: string }

/** The mode the settings choose, or why the pack is withheld: a profile folder Buckle does not load from. */
export type BrowserChoice = { mode: BrowserMode } | { refusal: string }

/** The word `/setup/status` names a mode by. */
export type BrowserModeName = BrowserMode['kind']

export const FRESH_BROWSER: BrowserMode = { kind: 'fresh' }

/** The setting that chose each mode, which a status or a warning names in place of its value. */
const MODE_SETTINGS: Record<BrowserModeName, string | null> = { fresh: null, profile: 'BUCKLE_BROWSER_PROFILE', attached: 'BUCKLE_BROWSER_CDP' }

/** Fixed text per mode, so the agent reads what close keeps and what the browser holds to before it calls. */
export const MODE_DESCRIPTIONS: Record<BrowserModeName, string> = {
  fresh: 'Run one agent-browser command against an isolated browser session; close discards browser state.',
  profile: 'Run one agent-browser command in the one browser on the owner\'s profile folder, which every session shares; logins and cookies outlive close, and Buckle judges only the page each command names.',
  attached: 'Run one agent-browser command in the owner\'s own Chrome over its DevTools port; every session shares that browser and its logins, close only disconnects, and Buckle judges only the page each command names.',
}

/**
 * agent-browser refuses `--allowed-domains` with `--profile` and with `--cdp`, as Chrome can open pages before its
 * containment is installed, so in these modes no list is passed and this is said once at pack start.
 */
const CONTAINMENT_OFF: Record<Exclude<BrowserModeName, 'fresh'>, string> = {
  profile: 'BUCKLE_BROWSER_PROFILE is set: the browser is not held to the approved list inside its pages, and every login kept in that folder is within the agent\'s reach; Buckle still judges the page each command names',
  attached: 'BUCKLE_BROWSER_CDP is set: the browser is not held to the approved list inside its pages, and every login in that browser is within the agent\'s reach; Buckle still judges the page each command names',
}

const PROFILE_UNTRUSTED = 'BUCKLE_BROWSER_PROFILE names a folder inside or around a workspace, a scratch root, or the node\'s state directory, where an agent can write or Buckle keeps its state, so Buckle does not load it'
const PROFILE_MISSING = 'BUCKLE_BROWSER_PROFILE does not name an existing folder; create it first'
const ARGS_UNTRUSTED = 'BUCKLE_BROWSER_ARGS names a path inside or around a workspace, a scratch root, or the node\'s state directory, where an agent can write or Buckle keeps its state, so Buckle does not pass it'

/**
 * Each form a setting's value takes in agent-browser's output, longest first, and the text shown in its place: the
 * setting's name. agent-browser names the endpoint it could not reach by its host and port, a bare port as
 * 127.0.0.1 and that port, and folds Chrome's own launch errors, which name the profile folder, into its failure text.
 */
function settingForms(mode: BrowserMode): string[] {
  if (mode.kind === 'profile') return [mode.directory]
  if (mode.kind === 'fresh') return []
  const endpoint = mode.endpoint
  if (/^\d+$/.test(endpoint)) return [endpoint, ...['127.0.0.1', 'localhost', '[::1]'].map(host => `${host}:${endpoint}`), `port ${endpoint}`]
  const url = new URL(endpoint)
  // agent-browser probes port 9222 when an http:// value names none.
  // A host alone is left as written: without its port it names pages the agent opens too.
  const port = url.port || (url.protocol.startsWith('http') ? '9222' : '')
  const host = port ? `${url.hostname}:${port}` : ''
  const userinfo = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : ''
  const rest = `${url.pathname === '/' ? '' : url.pathname}${url.search}`
  return [endpoint, url.href, host, userinfo, rest, url.search].filter(form => form.length > 1)
}

/**
 * Shows agent-browser's output with the setting's value replaced by its name, as written and as JSON writes it, so a
 * failure to reach the owner's Chrome or to open the profile folder never prints the value into a tool result.
 */
export function settingScrubber(mode: BrowserMode): (text: string) => string {
  const setting = MODE_SETTINGS[mode.kind]
  const forms = settingForms(mode).flatMap(form => [form, JSON.stringify(form).slice(1, -1)])
  const longestFirst = [...new Set(forms)].sort((a, b) => b.length - a.length)
  return text => setting === null ? text : longestFirst.reduce((shown, form) => shown.replaceAll(form, setting), text)
}

/**
 * What a browser daemon was started with that a later call cannot change: the mode, its endpoint or folder, the
 * owner's arguments, and the window. agent-browser fixes these in a daemon when it spawns and reuses a running daemon
 * by its session name, so a session started under other settings, left by a stop that skipped the close step, is
 * never reused. Hashed, so the sessions store holds no endpoint or path.
 */
export function modeFingerprint(mode: BrowserMode, settings: { launchArgs?: string; headed: boolean }): string {
  const target = mode.kind === 'attached' ? mode.endpoint : mode.kind === 'profile' ? mode.directory : ''
  return createHash('sha256').update(JSON.stringify([mode.kind, target, settings.launchArgs ?? '', settings.headed])).digest('hex').slice(0, 16)
}

/**
 * The one agent-browser session for a profile folder. Chrome opens a folder in one browser at a time, so every caller
 * in every workspace on the node shares this session, named from the folder so each process reaches the same daemon.
 */
export function profileSession(directory: string): string {
  return `buckle-profile-${createHash('sha256').update(directory).digest('hex').slice(0, 16)}`
}

/**
 * The mode the node's settings choose, as `/setup/status` reports it: a word, the setting, never its value, and why
 * the browser pack is withheld, or null while it runs, so a refused profile folder never reads as a running mode.
 * `pack` is the browser pack as the manifest lists it, absent when BUCKLE_PACKS leaves it out.
 */
export function browserModeStatus(settings: { browserCdp?: string; browserProfile?: string }, pack: { unavailableReason: string | null } | undefined): { mode: BrowserModeName; setting: string | null; withheld: string | null } {
  const mode: BrowserModeName = settings.browserCdp ? 'attached' : settings.browserProfile ? 'profile' : 'fresh'
  return { mode, setting: MODE_SETTINGS[mode], withheld: pack ? pack.unavailableReason : 'BUCKLE_PACKS leaves the browser pack out' }
}

/** The warning a mode without in-browser containment logs at pack start, or null for a fresh browser. */
export function containmentWarning(mode: BrowserMode): { message: string; setting: string } | null {
  return mode.kind === 'fresh' ? null : { message: CONTAINMENT_OFF[mode.kind], setting: MODE_SETTINGS[mode.kind]! }
}

/**
 * The browser the settings choose. A profile folder is judged as the agent-browser command is (resolveProgram): it is
 * refused where the path named, a link on its way, or where it lands lies inside a root an agent can write or Buckle's
 * state, or holds one, as Chrome reads every folder beneath its profile. It is handed on as the folder it really is.
 * A path the owner's arguments name (`--load-extension=<folder>`, `--disk-cache-dir=<folder>`) is judged the same way,
 * as Chrome loads code from it or writes to it.
 */
export function chooseBrowser(input: {
  cdp?: string
  profile?: string
  args?: string
  untrusted: UntrustedRoots
  protectedRoots: readonly string[]
  platform?: NodeJS.Platform
}): BrowserChoice {
  if (input.cdp) return { mode: { kind: 'attached', endpoint: input.cdp } }
  const platform = input.platform ?? process.platform
  const roots = [...input.untrusted.untrustedRoots.map(root => root.path), ...input.protectedRoots]
  const named = argumentPaths(input.args ?? '')
  if (named.length > 0 && input.untrusted.rootsUnknown) return { refusal: `BUCKLE_BROWSER_ARGS is not passed while ${input.untrusted.rootsUnknown}` }
  if (named.some(path => judgedFolder(path, roots, platform) === null)) return { refusal: ARGS_UNTRUSTED }
  if (!input.profile) return { mode: FRESH_BROWSER }
  if (input.untrusted.rootsUnknown) return { refusal: `BUCKLE_BROWSER_PROFILE is not loaded while ${input.untrusted.rootsUnknown}` }
  const directory = judgedFolder(input.profile, roots, platform)
  if (directory === null) return { refusal: PROFILE_UNTRUSTED }
  try { if (!statSync(directory).isDirectory()) return { refusal: PROFILE_MISSING } } catch { return { refusal: PROFILE_MISSING } }
  return { mode: { kind: 'profile', directory } }
}

/** Each absolute path a switch in the owner's arguments takes as its value, as the disk's platform spells it. */
function argumentPaths(args: string): string[] {
  return browserArguments(args).flatMap((argument) => {
    const value = chromiumSwitch(argument)?.value
    return value && isAbsolute(value) ? [value] : []
  })
}

/**
 * Where a folder really is, or null where it lies where Buckle does not load from: every place on its way lies outside
 * every root, and the folder, as named and where it lands, holds none. A path Buckle cannot read or follow is null too.
 */
function judgedFolder(path: string, roots: readonly string[], platform: NodeJS.Platform): string | null {
  let named: string
  let places: string[]
  try {
    named = typedPath(path, platform)
    places = placesOnTheWay(named, platform)
  } catch { return null }
  const directory = places.at(-1)!
  const caseless = ignoresCase(platform)
  const inside = (outer: string, inner: string) => isInsideComparable(outer, inner, caseless, platform)
  return roots.some(root => places.some(place => inside(root, place)) || [named, directory].some(folder => inside(folder, root))) ? null : directory
}
