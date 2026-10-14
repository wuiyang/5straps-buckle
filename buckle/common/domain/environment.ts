import { trustedSearchPath, type UntrustedRoots } from './executable.js'

/**
 * Variables a child process inherits. Buckle's own secrets are absent from this list, so a
 * shell command cannot read the auth token or provider keys out of its environment.
 * Caller-supplied values are deliberate and pass through untouched.
 */
const INHERITED = [
  'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'PATH', 'PWD', 'SHELL', 'TERM', 'TMPDIR', 'TZ', 'USER',
  'SSL_CERT_DIR', 'SSL_CERT_FILE',
]

/**
 * Windows' own variables, which a program there needs as much as PATH: Node and Chromium misbehave without
 * SystemRoot, a screenshot needs TEMP, and git needs USERPROFILE. Without them agent-browser's screenshot hung under
 * Buckle on the owner's Windows node and worked by hand (2026-10-14). None holds a secret. Inherited on Windows alone.
 */
const WINDOWS_INHERITED = [
  'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'OS', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ALLUSERSPROFILE', 'PUBLIC',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION',
]

const SECRET_NAME_PATTERN = /(token|secret|password|passwd|credential|api_?key|private_?key)/i

/**
 * The variables a child inherits from `parent`, with `extra` set over them. On Windows the Windows list is added, and
 * a name matches without regard to case, as Windows reads names, and passes under the spelling the parent used (`Path`
 * reaches the child as `Path`); an `extra` name replaces every spelling of itself, so no two spellings reach the child.
 * `platform`: the host's unless a test imitates another.
 */
export function buildChildEnvironment(input: {
  parent: NodeJS.ProcessEnv
  extra: Record<string, string>
  platform?: NodeJS.Platform
}): NodeJS.ProcessEnv {
  const platform = input.platform ?? process.platform
  const environment: NodeJS.ProcessEnv = {}
  if (platform === 'win32') {
    const wanted = new Set([...INHERITED, ...WINDOWS_INHERITED].map(name => name.toUpperCase()))
    for (const [name, value] of Object.entries(input.parent)) {
      if (value !== undefined && wanted.has(name.toUpperCase()) && environmentKey(environment, name, platform) === undefined) environment[name] = value
    }
  } else {
    for (const name of INHERITED) {
      const value = input.parent[name]
      if (value !== undefined) environment[name] = value
    }
  }
  return withExtra(environment, input.extra, platform)
}

/** Whether two variable names are one: on Windows without regard to case, as Windows reads them; elsewhere exactly. */
function sameName(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? left.toUpperCase() === right.toUpperCase() : left === right
}

/**
 * The key `environment` holds `name` under, among its own keys alone: on Windows any spelling of it, elsewhere the name
 * itself. A name every object inherits, such as `constructor`, is never taken for one it holds.
 */
function environmentKey(environment: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  return Object.keys(environment).find(key => sameName(key, name, platform))
}

/**
 * `environment` with `extra` set over it, each extra name replacing every spelling of itself on Windows. The merge is
 * made on an object with no prototype and read by its own keys, so any name a caller sends, the agent's shell `env`
 * among them, is a variable like any other: `constructor` matched an inherited property and looped forever, and
 * `__proto__` would have been swallowed by the prototype setter (review of 2026-10-14). Nothing is refused by name.
 */
function withExtra(environment: NodeJS.ProcessEnv, extra: Record<string, string>, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = Object.assign(Object.create(null) as NodeJS.ProcessEnv, environment)
  for (const [name, value] of Object.entries(extra)) {
    for (const key of Object.keys(merged)) if (sameName(key, name, platform)) delete merged[key]
    merged[name] = value
  }
  return Object.fromEntries(Object.entries(merged))
}

/** The environment of a program Buckle runs on the host, with `extra` set over it (hostEnvironment). */
export type HostEnvironment = (extra?: Record<string, string>) => NodeJS.ProcessEnv

/**
 * buildChildEnvironment for a program Buckle itself runs on the host (git, rg, ps, a language server, agent-browser,
 * the environment validator), whose PATH keeps only the entries outside every root an agent can write
 * (trustedSearchPath), read at each spawn. The shell keeps the agent's PATH: in the sandbox it runs the agent's own
 * commands, and unsandboxed it is no isolation by design. `platform`: the host's unless a test imitates another.
 */
export function hostEnvironment(untrusted: () => UntrustedRoots, platform: NodeJS.Platform = process.platform): HostEnvironment {
  return (extra = {}) => {
    const environment = buildChildEnvironment({ parent: process.env, extra: {}, platform })
    // On Windows PATH is usually spelled `Path`: the entry judged is the one the child would read, whatever its spelling.
    const key = environmentKey(environment, 'PATH', platform) ?? 'PATH'
    const searchPath = trustedSearchPath(environment[key], untrusted(), platform)
    if (searchPath) environment[key] = searchPath
    else delete environment[key]
    return withExtra(environment, extra, platform)
  }
}

/**
 * Every variable under a prefix, for a pack that needs to configure the tool it wraps. The
 * prefix is named by the pack rather than added to INHERITED, so one tool's settings reach that
 * tool alone and the allowlist keeps meaning what it says for everything else.
 */
export function collectPrefixed(parent: NodeJS.ProcessEnv, prefix: string): Record<string, string> {
  const collected: Record<string, string> = {}
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && name.startsWith(prefix)) collected[name] = value
  }
  return collected
}

/** Used to redact values before they reach logs or tool output. */
export function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name)
}
