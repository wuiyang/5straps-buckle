import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { join } from 'pathe'
import { ignoresCase, isInsideComparable, nativePath, pathRoot } from './paths.js'
import { ToolInputError } from './tool.js'

/**
 * Extensions Windows hands straight to CreateProcess. `.cmd` and `.bat` are deliberately absent:
 * Node refuses to spawn them without a shell, so resolving one would advertise a tool that fails
 * on every call. Point the relevant config at the underlying `.exe` instead.
 */
const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.com']

/**
 * Resolves a binary by scanning PATH for an executable file. A shell function or alias is deliberately not found,
 * because a shell-less spawn cannot run one. Only absolute PATH entries are searched: a relative one (`.`, `bin`)
 * names a directory under whichever working directory a lookup runs in, and on Windows one with a root but no drive
 * (`\bin`) a directory on whichever drive is current (isFullPath).
 */
export function findExecutable(
  binary: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (isPathReference(binary, platform)) return firstExecutable(binary, platform)

  for (const directory of searchDirectories(environment, platform)) {
    const found = firstExecutable(join(directory, binary), platform)
    if (found) return found
  }
  return null
}

/** How a program is looked up: findExecutable's signature, so a test can put another in its place. */
export type ExecutableLookup = (binary: string, environment: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string | null

/** Where programs are looked up, and for which platform: the host's unless a test imitates another. */
export interface ProgramSearch {
  lookup?: ExecutableLookup
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

/**
 * A program Buckle runs: the absolute path it spawns, or why it is not run. `untrusted` is a program found where an
 * agent can write.
 */
export type ResolvedProgram = { path: string } | { path: null; reason: string; untrusted: boolean }

/** One workspace's resolveProgram, bound to its roots and search. */
export type ProgramResolver = (name: string) => ResolvedProgram

/**
 * Where no program Buckle runs may come from: every root the node knows an agent may have put one in, its workspaces',
 * its scratch roots, and its mounts (NodeRoots). `rootsUnknown` says why not all of them are known, when they are not
 * (the workspace registry cannot be read): every program is then refused, as it could lie in a root not listed.
 */
export interface UntrustedRoots {
  untrustedRoots: readonly string[]
  rootsUnknown?: string | null
}

/**
 * A program Buckle runs by name, looked up on PATH once (findExecutable, never in a working directory) and spawned by
 * the absolute path found. Spawned by its bare name, it would be looked up again by the system: on Windows libuv tries
 * `name.com` and `name.exe` in the child's working directory before PATH, so a program an agent wrote into the
 * workspace would run with Buckle's rights. A program found inside an untrusted root (`untrustedRoots`), as written or
 * where its links lead, is refused, compared as the disk compares paths (comparablePath).
 */
export function resolveProgram(name: string, input: ProgramSearch & UntrustedRoots): ResolvedProgram {
  const platform = input.platform ?? process.platform
  const found = (input.lookup ?? findExecutable)(name, input.environment ?? process.env, platform)
  if (found === null) return { path: null, reason: `${name} is not installed on this node`, untrusted: false }
  if (input.rootsUnknown) return { path: null, reason: `${name} is not run while ${input.rootsUnknown}`, untrusted: true }
  let path: string
  try { path = nativePath(found, platform) } catch (error) { return { path: null, reason: error instanceof Error ? error.message : String(error), untrusted: false } }
  if (pathRoot(path) === '') return { path: null, reason: `${name} is a relative path, which Buckle does not run from a working directory`, untrusted: false }
  const spellings = [path, realPathOr(path, platform)]
  if (input.untrustedRoots.some(root => spellings.some(spelling => isInsideComparable(root, spelling, ignoresCase(platform), platform)))) {
    return { path: null, reason: `${name} is found inside a workspace, a scratch root, or a mount of this node, where an agent may have put it, so Buckle does not run it`, untrusted: true }
  }
  return { path }
}

/**
 * The program a command word names, as the unsandboxed shell spawns it: a path the agent wrote stays as written, and
 * the rules judged that path; a bare name is resolved (resolveProgram), so a program the agent planted in its working
 * directory never stands in for the one on PATH that a rule naming it meant.
 */
export function runnableCommand(command: string, input: ProgramSearch & UntrustedRoots): string {
  if (isPathReference(command, input.platform ?? process.platform)) return command
  const program = resolveProgram(command, input)
  if (program.path === null) throw new ToolInputError(program.reason, program.untrusted ? { code: 'PERMISSION_DENIED' } : undefined)
  return program.path
}

/** Where a path really is, in pathe's form, or the path itself where it cannot be resolved. */
export function realPathOr(path: string, platform: NodeJS.Platform = process.platform): string {
  try { return nativePath(realpathSync.native(path), platform) } catch { return path }
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

function searchDirectories(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  return (environment.PATH ?? '').split(platform === 'win32' ? ';' : ':').flatMap(entry => {
    try {
      const directory = nativePath(entry, platform)
      return entry && isFullPath(directory, platform) ? [directory] : []
    } catch { return [] }
  })
}

/**
 * Whether a path in pathe's form names one place whatever the working directory: it has a root, and on Windows that
 * root is a drive or a share, never `/` alone, which is the root of whichever drive is current.
 */
function isFullPath(path: string, platform: NodeJS.Platform): boolean {
  const root = pathRoot(path, platform)
  return root !== '' && (platform !== 'win32' || root !== '/')
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
