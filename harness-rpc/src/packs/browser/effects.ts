import type { ToolEffect } from '../../domain/effect.js'

/** Two or more characters before the colon, so a Windows drive letter like `C:` is not a scheme. */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]+:/i

/** Commands whose first positional names a file the browser writes. */
const WRITES_FIRST_POSITIONAL = new Set(['screenshot', 'pdf'])

/**
 * Flags that would hand the browser a capability Buckle cannot see. `--allow-file-access` lets an
 * open page read local files, and `--executable-path` launches an arbitrary binary under cover of
 * running agent-browser. Neither is reachable through the permission rules, so both are refused.
 */
const REFUSED_FLAGS = ['--allow-file-access', '--executable-path']

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

export function refusedFlag(args: string[]): string | null {
  const lowered = args.map(argument => argument.toLowerCase())
  return REFUSED_FLAGS.find(flag => lowered.some(argument => argument === flag || argument.startsWith(`${flag}=`))) ?? null
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
