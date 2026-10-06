import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, resolve } from 'pathe'

/**
 * Extensions Windows hands straight to CreateProcess. `.cmd` and `.bat` are deliberately absent:
 * Node refuses to spawn them without a shell, so resolving one would advertise a tool that fails
 * on every call. Point the relevant config at the underlying `.exe` instead.
 */
const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.com']

/**
 * Resolves a binary the way `spawn` will: by scanning PATH for an executable file. A shell
 * function or alias is deliberately not found, because a shell-less spawn cannot run one.
 */
export function findExecutable(
  binary: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (isPathReference(binary, platform)) return firstExecutable(binary, platform)

  for (const directory of searchDirectories(environment)) {
    const found = firstExecutable(resolve(directory, binary), platform)
    if (found) return found
  }
  return null
}

export function hasExecutable(
  binary: string,
  environment?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): boolean {
  return findExecutable(binary, environment, platform) !== null
}

/**
 * Names to try on disk for one candidate path. Windows stores `git` as `git.exe`, so a bare name
 * has to be suffixed before it will ever be found.
 */
export function executableCandidates(path: string, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return [path]
  if (hasWindowsExecutableExtension(path)) return [path]
  return WINDOWS_EXECUTABLE_EXTENSIONS.map(extension => `${path}${extension}`)
}

/** A backslash only separates directories on Windows; elsewhere it is a legal filename character. */
export function isPathReference(binary: string, platform: NodeJS.Platform): boolean {
  return binary.includes('/') || (platform === 'win32' && binary.includes('\\'))
}

function firstExecutable(path: string, platform: NodeJS.Platform): string | null {
  return executableCandidates(path, platform).find(isExecutableFile) ?? null
}

function hasWindowsExecutableExtension(path: string): boolean {
  const lower = path.toLowerCase()
  return WINDOWS_EXECUTABLE_EXTENSIONS.some(extension => lower.endsWith(extension))
}

function searchDirectories(environment: NodeJS.ProcessEnv): string[] {
  return (environment.PATH ?? '').split(delimiter).filter(Boolean)
}

/** Directories carry the execute bit too, so the file check is what keeps one out of the result. */
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
