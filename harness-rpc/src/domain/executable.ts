import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/**
 * Resolves a binary the way `spawn` will: by scanning PATH for an executable file. A shell
 * function or alias is deliberately not found, because a shell-less spawn cannot run one.
 */
export function findExecutable(binary: string, environment: NodeJS.ProcessEnv = process.env): string | null {
  if (binary.includes('/')) return isExecutable(binary) ? binary : null

  for (const directory of (environment.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = isAbsolute(directory) ? join(directory, binary) : join(process.cwd(), directory, binary)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

export function hasExecutable(binary: string, environment?: NodeJS.ProcessEnv): boolean {
  return findExecutable(binary, environment) !== null
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
