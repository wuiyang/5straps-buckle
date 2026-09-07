/** Interpreters whose positional is a script body rather than an argument list. */
export const SHELL_COMMANDS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])

export interface ParsedArgv {
  command: string
  shortFlags: Set<string>
  longFlags: Map<string, string | null>
  positionals: string[]
  subcommand: string | null
}

/**
 * Splits a command line the way getopt-style tools read it: clustered short flags expand,
 * `--name=value` splits, and a bare `--` ends flag parsing.
 */
export function parseArgv(command: string, args: string[]): ParsedArgv {
  const shortFlags = new Set<string>()
  const longFlags = new Map<string, string | null>()
  const positionals: string[] = []
  let flagsEnded = false

  for (const argument of args) {
    if (flagsEnded || argument === '-' || !argument.startsWith('-')) {
      positionals.push(argument)
      continue
    }
    if (argument === '--') {
      flagsEnded = true
      continue
    }
    if (argument.startsWith('--')) {
      const separator = argument.indexOf('=')
      if (separator === -1) longFlags.set(argument.slice(2).toLowerCase(), null)
      else longFlags.set(argument.slice(2, separator).toLowerCase(), argument.slice(separator + 1))
      continue
    }
    for (const character of argument.slice(1)) shortFlags.add(character)
  }

  return {
    command: baseCommand(command),
    shortFlags,
    longFlags,
    positionals,
    subcommand: positionals[0]?.toLowerCase() ?? null,
  }
}

export function hasFlag(argv: ParsedArgv, short: string | null, ...long: string[]): boolean {
  if (short && argv.shortFlags.has(short)) return true
  return long.some(name => argv.longFlags.has(name))
}

const MAX_SIGNATURE_LENGTH = 300

/**
 * The literal command line, used both as the grant subject and as the text a person reads
 * before approving. Matching the exact line is deliberate: approving `rm -rf build` must not
 * also approve `rm -rf /`.
 */
export function argvSignature(argv: ParsedArgv, args: string[]): string {
  const signature = [argv.command, ...args].join(' ')
  return signature.length > MAX_SIGNATURE_LENGTH ? `${signature.slice(0, MAX_SIGNATURE_LENGTH)}…` : signature
}

/**
 * The statements of a shell script body, split where a shell would start a new command, so a
 * pattern written for a command line also meets `curl` inside `bash -c "... | curl ..."`.
 */
export function shellStatements(argv: ParsedArgv): string[] {
  if (!SHELL_COMMANDS.has(argv.command)) return []
  return argv.positionals
    .join('\n')
    .split(/\n|;|&&|\|\||\|/)
    .map(statement => statement.trim())
    .filter(Boolean)
}

function baseCommand(command: string): string {
  const withoutDirectory = command.split(/[\\/]/).pop() ?? command
  return withoutDirectory.toLowerCase()
}
