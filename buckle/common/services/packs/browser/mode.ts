import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { ARGS_UNTRUSTED, browserArguments, chromiumSwitch } from '../../../domain/browser-arguments.js'
import { placesOnTheWay, type StoredPath, type UntrustedRoots } from '../../../domain/executable.js'
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
  profile: 'Run one agent-browser command in the one browser on the owner\'s profile folder, which every session shares; logins and cookies outlive close. Buckle still judges the page each command names, every file path, and every flag; only where a page goes after it loads is no longer held to the list.',
  attached: 'Run one agent-browser command in the owner\'s own Chrome over its DevTools port; every session shares that browser and its logins, and close only disconnects. Buckle still judges the page each command names, every file path, and every flag; only where a page goes after it loads is no longer held to the list.',
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

/**
 * Each form a setting's value takes in agent-browser's output, and the text shown in its place. agent-browser names the
 * endpoint it could not reach by its host and port, a bare port as 127.0.0.1 and that port, and folds Chrome's own
 * launch errors, which name the profile folder, into its failure text; Chrome on Windows writes that folder with
 * backslashes. A host alone, or a bare port, is left to the failure rule (settingScrubber): either can be page text.
 */
function settingForms(mode: BrowserMode, setting: string, platform: NodeJS.Platform): Array<[string, string]> {
  if (mode.kind === 'fresh') return []
  if (mode.kind === 'profile') {
    const spellings = platform === 'win32' ? [mode.directory, mode.directory.replaceAll('/', '\\')] : [mode.directory]
    return spellings.map(spelling => [spelling, setting])
  }
  const endpoint = mode.endpoint
  if (/^\d+$/.test(endpoint)) return [...['127.0.0.1', 'localhost', '[::1]'].map((host): [string, string] => [`${host}:${endpoint}`, setting]), [`port ${endpoint}`, `port ${setting}`]]
  const url = new URL(endpoint)
  // agent-browser probes port 9222 for an http value that names a path and no port; one with no path it reaches over ws.
  const port = url.port || (url.protocol.startsWith('http') && url.pathname !== '/' ? '9222' : '')
  const host = port ? `${url.hostname}:${port}` : ''
  const userinfo = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : ''
  const rest = `${url.pathname === '/' ? '' : url.pathname}${url.search}`
  return [endpoint, url.href, host, userinfo, rest, url.search].filter(form => form.length > 1).map(form => [form, setting])
}

/**
 * Shows agent-browser's output with the setting's value replaced, as written and as JSON writes it, so a failure to
 * reach the owner's Chrome or to open the profile folder never prints the value into a tool result. A bare port is
 * replaced in failure text alone, and never inside a longer number: a successful result carries page text, which can
 * hold the same digits.
 */
export function settingScrubber(mode: BrowserMode, platform: NodeJS.Platform = process.platform): (text: string, failed: boolean) => string {
  const setting = MODE_SETTINGS[mode.kind]
  if (setting === null) return text => text
  const forms = settingForms(mode, setting, platform).flatMap(([form, shown]): Array<[string, string]> => [[form, shown], [JSON.stringify(form).slice(1, -1), shown]])
  const longestFirst = [...new Map(forms)].sort(([a], [b]) => b.length - a.length)
  const barePort = mode.kind === 'attached' && /^\d+$/.test(mode.endpoint) ? new RegExp(`(?<!\\d)${mode.endpoint}(?!\\d)`, 'g') : null
  return (text, failed) => {
    const shown = longestFirst.reduce((written, [form, replacement]) => written.replaceAll(form, replacement), text)
    return failed && barePort ? shown.replace(barePort, setting) : shown
  }
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
 * `pack` is the browser pack as the manifest lists it, absent when the workspace's packs.enabled leaves it out.
 */
export function browserModeStatus(settings: { browserCdp?: string; browserProfile?: string }, pack: { unavailableReason: string | null } | undefined): { mode: BrowserModeName; setting: string | null; withheld: string | null } {
  const mode: BrowserModeName = settings.browserCdp ? 'attached' : settings.browserProfile ? 'profile' : 'fresh'
  return { mode, setting: MODE_SETTINGS[mode], withheld: pack ? pack.unavailableReason : 'the workspace setting packs.enabled leaves the browser pack out' }
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
  /** How a Windows path resolves; the host's unless a test imitates Windows. */
  storedPath?: StoredPath
}): BrowserChoice {
  if (input.cdp) return { mode: { kind: 'attached', endpoint: input.cdp } }
  const platform = input.platform ?? process.platform
  const roots = [...input.untrusted.untrustedRoots.map(root => root.path), ...input.protectedRoots]
  const named = argumentPaths(input.args ?? '', platform)
  if (named.length > 0 && input.untrusted.rootsUnknown) return { refusal: `BUCKLE_BROWSER_ARGS is not passed while ${input.untrusted.rootsUnknown}` }
  // A folder the arguments name is handed on as written, so only an untrusted one is refused here.
  if (named.some(path => judgedFolder(path, roots, platform, input.storedPath) === UNTRUSTED_FOLDER)) return { refusal: ARGS_UNTRUSTED }
  if (!input.profile) return { mode: FRESH_BROWSER }
  if (input.untrusted.rootsUnknown) return { refusal: `BUCKLE_BROWSER_PROFILE is not loaded while ${input.untrusted.rootsUnknown}` }
  const directory = judgedFolder(input.profile, roots, platform, input.storedPath)
  if (directory === UNTRUSTED_FOLDER) return { refusal: PROFILE_UNTRUSTED }
  if (directory === NO_FOLDER) return { refusal: PROFILE_MISSING }
  try { if (!statSync(directory).isDirectory()) return { refusal: PROFILE_MISSING } } catch { return { refusal: PROFILE_MISSING } }
  return { mode: { kind: 'profile', directory } }
}

/**
 * Each switch value the system reads as an absolute path, as node's own path module for the node's platform reads it:
 * `//./home/x` on Linux and macOS, and a device or share path such as `\\.\C:\x` on Windows, are absolute there although
 * pathe reads them otherwise. Every other spelling of a path was refused at start (browserArgumentsRefusal), or is a
 * bare name in Buckle's browser state directory.
 */
function argumentPaths(args: string, platform: NodeJS.Platform): string[] {
  const absolute = platform === 'win32' ? win32.isAbsolute : posix.isAbsolute
  return browserArguments(args).flatMap((argument) => {
    const value = chromiumSwitch(argument, platform)?.value
    return value && absolute(value) ? [value] : []
  })
}

/** Why judgedFolder hands on no folder: one where Buckle does not load from, or one whose real place has no path. */
export const UNTRUSTED_FOLDER = Symbol('untrusted folder')
export const NO_FOLDER = Symbol('no folder')

/**
 * Where a folder really lands, which is what is handed on, or why none is: UNTRUSTED_FOLDER where it lies where Buckle
 * does not load from, a place on its way inside a root, or the folder, as named and where it lands, holding one, or
 * where Buckle cannot read or follow it; NO_FOLDER on Windows where its landing place has no real path, as on a drive
 * that is not there, never a link's own place in its stead (recheck 3 of the final review of 0.1.4, finding
 * executable 485). Where it lands is its real landing place, or where the walk lands by spelling when it has none, so
 * a link to an absent drive that holds a root is still refused (recheck 4, finding mode.ts:192).
 */
export function judgedFolder(path: string, roots: readonly string[], platform: NodeJS.Platform, stored?: StoredPath): string | typeof UNTRUSTED_FOLDER | typeof NO_FOLDER {
  // On Windows a path rooted at a slash alone names whichever drive is current, so no one place (isFullPath).
  if (platform === 'win32' && /^[/\\](?![/\\])/.test(path)) return UNTRUSTED_FOLDER
  let named: string
  let walked: { places: string[]; landing: string | null; real: string }
  try {
    named = typedPath(path, platform)
    walked = placesOnTheWay(named, platform, stored)
  } catch { return UNTRUSTED_FOLDER }
  const caseless = ignoresCase(platform)
  const inside = (outer: string, inner: string) => isInsideComparable(outer, inner, caseless, platform)
  const folders = [named, walked.landing ?? walked.real]
  if (roots.some(root => walked.places.some(place => inside(root, place)) || folders.some(folder => inside(folder, root)))) return UNTRUSTED_FOLDER
  return walked.landing ?? NO_FOLDER
}
