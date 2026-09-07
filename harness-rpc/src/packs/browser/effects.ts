import type { ToolEffect } from '../../domain/effect.js'

/** Two or more characters before the colon, so a Windows drive letter like `C:` is not a scheme. */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]+:/i

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
 * rules never judge. Name an output path as a positional instead, where they do.
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
  '--password-stdin', '--port', '--proxy', '--proxy-bypass', '--quick', '--quiet', '--raw',
  '--require-md', '--resource-type', '--restore', '--restore-save', '--screenshot-format',
  '--screenshot-quality', '--selector', '--session', '--state', '--status', '--submit-selector',
  '--tags', '--text', '--timeout', '--tools', '--type', '--url', '--user-agent', '--username',
  '--username-selector', '--verbose', '--webgpu',
  '-i', '-q', '-v',
])

/**
 * What a browser command touches beyond running the binary.
 *
 * Declaring these is what puts browser navigation under the same rules as every other tool. A
 * `file://` URL is refused by the egress rule, a private address asks, and a local path is judged
 * by the path rules instead of being invisible because the call happened to go through a browser.
 */
export function browserEffects(command: string, args: string[]): ToolEffect[] {
  return [...navigationEffects(args), ...fileEffects(command, args)]
}

/** The first flag Buckle does not know, or null when every flag is one it does. */
export function refusedFlag(args: string[]): string | null {
  return args.map(flagName).find(flag => flag !== null && !KNOWN_FLAGS.has(flag)) ?? null
}

function flagName(argument: string): string | null {
  if (!FLAG_PATTERN.test(argument)) return null
  const [name = ''] = argument.toLowerCase().split('=')
  return name
}

function navigationEffects(args: string[]): ToolEffect[] {
  return args
    .filter(argument => SCHEME_PATTERN.test(argument))
    .map(url => ({ kind: 'network', url }) as const)
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
