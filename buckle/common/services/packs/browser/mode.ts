import { statSync } from 'node:fs'
import { placesOnTheWay, type UntrustedRoots } from '../../../domain/executable.js'
import { ignoresCase, isInsideComparable } from '../../../domain/paths.js'

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
  profile: 'Run one agent-browser command in a browser on the owner\'s profile folder; logins and cookies outlive close, and Buckle judges only the page each command names.',
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

/** The mode the node's settings choose, as `/setup/status` reports it: a word, and the setting, never its value. */
export function browserModeStatus(settings: { browserCdp?: string; browserProfile?: string }): { mode: BrowserModeName; setting: string | null } {
  const mode: BrowserModeName = settings.browserCdp ? 'attached' : settings.browserProfile ? 'profile' : 'fresh'
  return { mode, setting: MODE_SETTINGS[mode] }
}

/** The warning a mode without in-browser containment logs at pack start, or null for a fresh browser. */
export function containmentWarning(mode: BrowserMode): { message: string; setting: string } | null {
  return mode.kind === 'fresh' ? null : { message: CONTAINMENT_OFF[mode.kind], setting: MODE_SETTINGS[mode.kind]! }
}

/**
 * The browser the settings choose. A profile folder is judged as the agent-browser command is (resolveProgram): it is
 * refused where the path named, a link on its way, or where it lands lies inside a root an agent can write or Buckle's
 * state, or holds one, as Chrome reads every folder beneath its profile. It is handed on as the folder it really is.
 */
export function chooseBrowser(input: {
  cdp?: string
  profile?: string
  untrusted: UntrustedRoots
  protectedRoots: readonly string[]
  platform?: NodeJS.Platform
}): BrowserChoice {
  if (input.cdp) return { mode: { kind: 'attached', endpoint: input.cdp } }
  if (!input.profile) return { mode: FRESH_BROWSER }
  if (input.untrusted.rootsUnknown) return { refusal: `BUCKLE_BROWSER_PROFILE is not loaded while ${input.untrusted.rootsUnknown}` }
  const platform = input.platform ?? process.platform
  const profile = input.profile
  let places: string[]
  try { places = placesOnTheWay(profile, platform) } catch { return { refusal: PROFILE_UNTRUSTED } }
  const roots = [...input.untrusted.untrustedRoots.map(root => root.path), ...input.protectedRoots]
  const directory = places.at(-1)!
  const caseless = ignoresCase(platform)
  const inside = (outer: string, inner: string) => isInsideComparable(outer, inner, caseless, platform)
  // Every place on the way lies outside every root, and the folder, as named and where it lands, holds none.
  if (roots.some(root => places.some(place => inside(root, place)) || [profile, directory].some(folder => inside(folder, root)))) return { refusal: PROFILE_UNTRUSTED }
  try { if (!statSync(directory).isDirectory()) return { refusal: PROFILE_MISSING } } catch { return { refusal: PROFILE_MISSING } }
  return { mode: { kind: 'profile', directory } }
}
