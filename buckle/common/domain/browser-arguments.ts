/**
 * BUCKLE_BROWSER_ARGS as agent-browser reads its `--args`: split at commas and new lines, each piece trimmed, and the
 * empty ones dropped, so one argument can never hold a comma.
 */
export function browserArguments(value: string): string[] {
  return value.split(/[,\n]/).map(argument => argument.trim()).filter(Boolean)
}

/**
 * One argument read as agent-browser reads a Chromium switch: after `--`, `/`, or `-`, a name that runs to `=` or a
 * space and holds no slash, in lower case, with the value after `=` when there is one. Null for anything else, which
 * agent-browser takes for a page or a path.
 */
export function chromiumSwitch(argument: string): { name: string; value: string | null } | null {
  const body = argument.replace(/^(?:--|\/|-)/, '')
  if (body === argument) return null
  const [name = ''] = body.split(/[= ]/)
  if (!name || /[/\\]/.test(name)) return null
  const equals = body.indexOf('=')
  return { name: name.toLowerCase(), value: equals === name.length ? body.slice(equals + 1) : null }
}
