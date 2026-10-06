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

const SECRET_NAME_PATTERN = /(token|secret|password|passwd|credential|api_?key|private_?key)/i

export function buildChildEnvironment(input: {
  parent: NodeJS.ProcessEnv
  extra: Record<string, string>
}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const name of INHERITED) {
    const value = input.parent[name]
    if (value !== undefined) environment[name] = value
  }
  return { ...environment, ...input.extra }
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
    const environment = buildChildEnvironment({ parent: process.env, extra: {} })
    const searchPath = trustedSearchPath(environment.PATH, untrusted(), platform)
    if (searchPath) environment.PATH = searchPath
    else delete environment.PATH
    return { ...environment, ...extra }
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
