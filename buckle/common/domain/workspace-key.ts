import { createHash } from 'node:crypto'
import { basename, resolve } from 'pathe'

const UNSAFE_KEY_CHARACTERS = /[^a-z0-9_-]+/gi

/** Keyed by workspace like the rest of the state, so one node serving several keeps them apart. */
export function workspaceStateKey(workspaceRoot: string): string {
  const root = resolve(workspaceRoot)
  const name = basename(root).replace(UNSAFE_KEY_CHARACTERS, '-') || 'root'
  return `${name}-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`
}
