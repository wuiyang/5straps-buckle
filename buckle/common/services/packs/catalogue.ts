/**
 * The built-in packs by id, in manifest order, for `buckle init` and `buckle settings`, which
 * name them without building any. Factories follow this order.
 */
export const BUILTIN_PACKS = [
  { id: 'fs', summary: 'read, write and search files' },
  { id: 'history', summary: 'list the change history and restore the files to before a checkpoint, a person approving each restore' },
  { id: 'web', summary: 'fetch URLs and search the web' },
  { id: 'git', summary: 'read the repository: status, diff, log, blame, branches (needs host Git on)' },
  { id: 'forge', summary: 'commit, revert a commit, push and open pull requests (needs host Git on and a forge token)' },
  { id: 'dev', summary: 'language-server navigation and diagnostics' },
  { id: 'browser', summary: 'drive a browser through agent-browser, fresh for each session by default' },
  { id: 'shell', summary: 'run commands in the sandbox (needs the shell on)' },
  { id: 'code', summary: 'run a script that calls the other tools, each call judged as a direct one' },
  { id: 'environment', summary: 'validate environment configuration (needs BUCKLE_ENV_VALIDATOR_COMMAND)' },
] as const

export type BuiltinPackId = typeof BUILTIN_PACKS[number]['id']

interface PackPrerequisites { environmentValidator?: string }

const PREREQUISITES: Partial<Record<BuiltinPackId, { key: keyof PackPrerequisites; reason: string }>> = {
  environment: { key: 'environmentValidator', reason: 'BUCKLE_ENV_VALIDATOR_COMMAND is not set' },
}

/**
 * Why a built-in pack cannot be built from this configuration, or null when it can. `createBuiltinPacks`
 * builds by this check and `buckle settings` and `buckle init` refuse by it, so a pack the node would
 * call unknown at start is never written to `BUCKLE_PACKS`.
 */
export function unmetPackPrerequisite(id: string, options: PackPrerequisites): string | null {
  const pack = BUILTIN_PACKS.find(pack => pack.id === id)
  const prerequisite = pack === undefined ? undefined : PREREQUISITES[pack.id]
  if (prerequisite && !options[prerequisite.key]) return prerequisite.reason
  // The code pack is always built: packs.code off withholds it with a reason, as packs.shell off does the shell.
  return null
}
