import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'

/** Anything else would make an unwieldy directory name, on Windows as much as on Linux. */
const UNSAFE_KEY_CHARACTERS = /[^a-z0-9_-]+/gi

/** The owner's own choice of profile directory, overriding the one Buckle would own. */
export const PROFILE_VARIABLE = 'BUCKLE_BROWSER_PROFILE'

/**
 * Where the browser Buckle spawns keeps its cookies, logins and storage. Never the owner's
 * signed-in profile: a browser an agent drives holds only what that agent put there.
 */
export function resolveBrowserProfile(input: {
  stateDirectory: string
  workspaceRoot: string
  environment?: NodeJS.ProcessEnv
}): string {
  const configured = (input.environment ?? process.env)[PROFILE_VARIABLE]?.trim()
  if (configured) return resolve(configured)
  return join(input.stateDirectory, 'browser-profiles', workspaceProfileKey(input.workspaceRoot))
}

/** Keyed by workspace like the rest of the state, so one node serving several keeps them apart. */
export function workspaceProfileKey(workspaceRoot: string): string {
  const root = resolve(workspaceRoot)
  const name = basename(root).replace(UNSAFE_KEY_CHARACTERS, '-') || 'root'
  return `${name}-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`
}
