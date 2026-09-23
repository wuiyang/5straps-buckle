import type { ToolEffect } from '../../domain/effect.js'
import { normaliseUrl, UrlNormaliseError } from '../../domain/url-normalise.js'
import { ToolInputError } from '../../domain/tool.js'

/** agent-browser's names for loading a page. */
const NAVIGATION_COMMANDS = new Set(['open', 'goto', 'navigate'])

/** Flags whose value is a separate argument, so it is not mistaken for the page to open. */
const VALUE_FLAGS = new Set(['--headers', '--user-agent', '--device', '--color-scheme', '--timeout'])

/** Commands whose first positional names a file the browser writes. */
const WRITES_FIRST_POSITIONAL = new Set(['screenshot', 'pdf'])

/** Two dashes or one, then a letter, so a negative number stays a positional. */
const FLAG_PATTERN = /^-{1,2}[a-z]/i

/**
 * The agent-browser flags Buckle passes through. Anything else is refused by name, which is what
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
const KNOWN_FLAGS = new Set([
  '--action-policy', '--all', '--allowed-domains', '--allowed-origins', '--annotate', '--abort',
  '--bail', '--body', '--clear', '--color-scheme', '--confirm-actions', '--confirm-interactive',
  '--content', '--content-boundaries', '--credential-provider', '--debug', '--device',
  '--download', '--engine', '--exact', '--filter', '--fix', '--fn', '--fps', '--full',
  '--headed', '--headers', '--hide-scrollbars', '--idle-timeout', '--ignore-https-errors',
  '--item', '--json', '--label', '--llms', '--load', '--max-output', '--method', '--model',
  '--name', '--namespace', '--new-tab', '--no-auto-dialog', '--no-ca-cert', '--no-webmcp',
  '--offline', '--older-than', '--only-dynamic', '--outline', '--password', '--password-selector',
  '--password-stdin', '--port', '--quick', '--quiet', '--raw',
  '--require-md', '--resource-type', '--restore', '--restore-save', '--screenshot-format',
  '--screenshot-quality', '--selector', '--session', '--state', '--status', '--submit-selector',
  '--tags', '--text', '--timeout', '--tools', '--type', '--url', '--user-agent', '--username',
  '--username-selector', '--verbose', '--webgpu',
  '-i', '-q', '-v',
])

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
 * command is taken as a page, so a flag value misread as the URL cannot leave the real one
 * unjudged. The pack passes these on in place of what was written, so what the rules judged is
 * what agent-browser opens.
 */
export function navigationTargets(command: string, args: string[]): Map<number, string> {
  const positionals = args.flatMap((argument, index) => isPositional(args, index) ? [index] : [])
  const pages = NAVIGATION_COMMANDS.has(command) ? positionals
    : command === 'tab' && positionals[0] !== undefined && args[positionals[0]] === 'new' ? positionals.slice(1)
      : []
  return new Map(pages.map(index => [index, normalised(args[index]!)]))
}

/** Not a flag, and not the value of the flag before it (`--headers {...}`, `--headed false`). */
function isPositional(args: string[], index: number): boolean {
  const argument = args[index]!
  if (FLAG_PATTERN.test(argument)) return false
  const previous = args[index - 1]?.toLowerCase()
  if (!previous || !FLAG_PATTERN.test(previous) || previous.includes('=')) return true
  return !VALUE_FLAGS.has(previous) && argument !== 'true' && argument !== 'false'
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
  const positionals = args.filter(argument => !argument.startsWith('-'))

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
