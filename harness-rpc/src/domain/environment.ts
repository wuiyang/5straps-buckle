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

/** Used to redact values before they reach logs or tool output. */
export function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name)
}
