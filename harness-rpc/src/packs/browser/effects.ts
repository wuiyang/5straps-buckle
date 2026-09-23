import type { ToolEffect } from '../../domain/effect.js'
import { normaliseUrl, UrlNormaliseError } from '../../domain/url-normalise.js'
import { ToolInputError } from '../../domain/tool.js'

/** agent-browser's names for loading a page. */
const NAVIGATION_COMMANDS = new Set(['open', 'goto', 'navigate'])

/** Commands whose first positional names a file the browser writes. */
const WRITES_FIRST_POSITIONAL = new Set(['screenshot', 'pdf'])

/** Two dashes or one, then a letter, so a negative number stays a positional. */
const FLAG_PATTERN = /^-{1,2}[a-z]/i

/**
 * Flags that take a value, `--flag value` or `--flag=value`. A separate value is the flag's, never
 * a page or a path. Only flags whose name says a value follows are listed; a flag Buckle is unsure
 * of is boolean, because a value misread as a page is judged and fails closed, while a page misread
 * as a value would not be judged at all.
 */
const VALUE_FLAGS = new Set([
  '--action-policy', '--allowed-domains', '--allowed-origins', '--body', '--color-scheme',
  '--confirm-actions', '--credential-provider', '--device', '--engine', '--filter', '--fn', '--fps',
  '--headers', '--idle-timeout', '--label', '--load', '--max-output', '--method', '--model',
  '--name', '--namespace', '--older-than', '--password', '--password-selector', '--port',
  '--resource-type', '--restore-save', '--screenshot-format', '--screenshot-quality', '--selector',
  '--session', '--state', '--submit-selector', '--tags', '--text', '--timeout', '--type', '--url',
  '--user-agent', '--username', '--username-selector',
])

/** Flags that stand alone. agent-browser also reads an optional `true` or `false` after one. */
const BOOLEAN_FLAGS = new Set([
  '--all', '--annotate', '--abort', '--bail', '--clear', '--confirm-interactive', '--content',
  '--content-boundaries', '--debug', '--download', '--exact', '--fix', '--full', '--headed',
  '--hide-scrollbars', '--ignore-https-errors', '--item', '--json', '--llms', '--new-tab',
  '--no-auto-dialog', '--no-ca-cert', '--no-webmcp', '--offline', '--only-dynamic', '--outline',
  '--password-stdin', '--quick', '--quiet', '--raw', '--require-md', '--restore', '--status',
  '--tools', '--verbose', '--webgpu', '-i', '-q', '-v',
])

/**
 * The agent-browser flags Buckle passes through, every one either a value flag or a boolean one so
 * the arguments always parse one way. Anything else is refused by name, which is what
 * keeps an unknown or a future flag from handing the browser a capability the rules never see.
 *
 * Absent on purpose: `--profile` (Buckle owns it), `--executable-path`, `--args`, `--extension`,
 * `--init-script`, `--config`, `--enable`, `--cdp` and `--auto-connect` run or load something
 * outside Buckle's view; `--allow-file-access` reads local files around the path rules;
 * `--provider` moves the browser off this node; `--ca-cert` trusts a certificate; and
 * `--screenshot-dir`, `--download-path`, `--params` and `--payload` read or write a path the
 * rules never judge. Name an output path as a positional instead, where they do. `--proxy` and
 * `--proxy-bypass` are in `REFUSAL_REASONS`.
 */
const KNOWN_FLAGS = new Set([...VALUE_FLAGS, ...BOOLEAN_FLAGS])

/**
 * Flags refused with a reason of their own. Buckle owns the network policy: a proxy the agent
 * chose would carry every request to a host the rules never judge, while the page it names is
 * judged and approved.
 */
const REFUSAL_REASONS = new Map([
  ['--proxy', 'Buckle owns the network policy, so the agent cannot route the browser through a proxy the rules never judge'],
  ['--proxy-bypass', 'Buckle owns the network policy, so the agent cannot choose which hosts skip a proxy'],
])

const GENERIC_REFUSAL = 'Buckle passes only the agent-browser flags it can judge, and never one that changes the profile, the binary, or where output lands'

/**
 * What a browser command touches beyond running the binary.
 *
 * Declaring these is what puts browser navigation under the same rules as every other tool. A
 * `file://` URL is refused by the egress rule, a private address asks, and a local path is judged
 * by the path rules instead of being invisible because the call happened to go through a browser.
 */
export function browserEffects(command: string, args: string[]): ToolEffect[] {
  assertFlagsKnown(args)
  return [...navigationEffects(command, args), ...fileEffects(command, args)]
}

/** The first flag Buckle does not know, or null when every flag is one it does. */
export function refusedFlag(args: string[]): string | null {
  return args.map(flagName).find(flag => flag !== null && !KNOWN_FLAGS.has(flag)) ?? null
}

/** The refusal for a flag `refusedFlag` named, with its own reason when it has one. */
export function flagRefusal(flag: string): string {
  return `${flag} is not allowed: ${REFUSAL_REASONS.get(flag) ?? GENERIC_REFUSAL}`
}

/** Refused before anything is judged, so the owner is never asked about a call that cannot run. */
function assertFlagsKnown(args: string[]): void {
  const refused = refusedFlag(args)
  if (refused) throw new ToolInputError(flagRefusal(refused))
}

function flagName(argument: string): string | null {
  if (!FLAG_PATTERN.test(argument)) return null
  const [name = ''] = argument.toLowerCase().split('=')
  return name
}

/**
 * The page a command loads, normalised so `open example.com` is judged exactly like
 * `open https://example.com`. Only that page is a URL: the text given to `fill` or `type`, and
 * every flag value, are passed as written and never read as an address.
 */
function navigationEffects(command: string, args: string[]): ToolEffect[] {
  return [...navigationTargets(command, args).values()].map(url => ({ kind: 'network', url }) as const)
}

/**
 * Argument index to the normalised URL the browser will load. Every positional of a navigation
 * command is taken as a page, and a flag's value never is. The pack passes these on in place of
 * what was written, so what the rules judged is what agent-browser opens.
 */
export function navigationTargets(command: string, args: string[]): Map<number, string> {
  const positionals = positionalIndexes(args)
  if (NAVIGATION_COMMANDS.has(command) && positionals.length !== 1) {
    throw new ToolInputError(`${command} takes exactly one page to load, got ${positionals.length}`)
  }
  const pages = NAVIGATION_COMMANDS.has(command) ? positionals
    : command === 'tab' && positionals[0] !== undefined && args[positionals[0]] === 'new' ? positionals.slice(1)
      : []
  if (pages.length > 1) throw new ToolInputError(`tab new takes at most one page to load, got ${pages.length}`)
  return new Map(pages.map(index => [index, normalised(args[index]!)]))
}

/**
 * The order the arguments are handed to agent-browser in: for a navigation command the
 * positionals first, so the page that was judged is the first one agent-browser reads. A `true`
 * or `false` Buckle took as a boolean flag's value then cannot become the page instead, even if
 * agent-browser read that flag as bare.
 */
export function argumentOrder(command: string, args: string[]): number[] {
  const all = args.map((_, index) => index)
  if (navigationTargets(command, args).size === 0) return all
  const positionals = new Set(positionalIndexes(args))
  return [...all.filter(index => positionals.has(index)), ...all.filter(index => !positionals.has(index))]
}

/** Arguments that are not a flag and not the separate value of the flag before them. */
function positionalIndexes(args: string[]): number[] {
  const indexes: number[] = []
  for (let index = 0; index < args.length; index++) {
    const name = flagName(args[index]!)
    if (name === null) indexes.push(index)
    else if (takesNextArgument(name, args[index]!, args[index + 1])) index++
  }
  return indexes
}

/**
 * `--timeout 5000` and `--headed false` own the next argument; `--timeout=5000` does not. The
 * flag is recognised by its name: `true` or `false` after anything but a boolean flag is a
 * positional, and a positional of a navigation command is judged as a page.
 */
function takesNextArgument(name: string, argument: string, next: string | undefined): boolean {
  if (argument.includes('=') || next === undefined) return false
  return VALUE_FLAGS.has(name) || (BOOLEAN_FLAGS.has(name) && (next === 'true' || next === 'false'))
}

function normalised(argument: string): string {
  try {
    return normaliseUrl(argument).href
  } catch (error) {
    if (error instanceof UrlNormaliseError) throw new ToolInputError(error.message)
    throw error
  }
}

/**
 * Only positional paths are covered. A path supplied through a flag is not, which is why the
 * flags that matter are refused outright rather than judged.
 */
function fileEffects(command: string, args: string[]): ToolEffect[] {
  const positionals = positionalIndexes(args).map(index => args[index]!)

  if (WRITES_FIRST_POSITIONAL.has(command)) {
    const [path] = positionals
    return path ? [{ kind: 'write_path', path }] : []
  }
  if (command === 'download') {
    const path = positionals[1]
    return path ? [{ kind: 'write_path', path }] : []
  }
  if (command === 'upload') {
    return positionals.slice(1).map(path => ({ kind: 'read_path', path }) as const)
  }
  return []
}
