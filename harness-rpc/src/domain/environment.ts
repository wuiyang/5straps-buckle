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
