import { accessSync, constants, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { join } from 'pathe'
import { childPath, ignoresCase, isInsideComparable, nativePath, parentDirectory, pathRoot, withForwardSlashes } from './paths.js'
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
 * A program Buckle runs: the real path it spawns, with the path PATH gave it as its `argv0`, as a program that answers
 * to the name it was started by (busybox, ccache, a rustup proxy) reads it.
 */
export interface Program {
  path: string
  argv0: string
}

/** A program Buckle runs, or why it is not run. `untrusted` is a program found where an agent can write. */
export type ResolvedProgram = Program | { path: null; reason: string; untrusted: boolean }

/** One workspace's resolveProgram, bound to its roots and search. */
export type ProgramResolver = (name: string) => ResolvedProgram

/** What a root an agent can write is to the node. */
export type RootKind = 'workspace' | 'scratch root' | 'writable mount'

/** A root an agent can write: a workspace, a scratch root, or the source of a mount the sandbox shares writable. */
export interface UntrustedRoot {
  path: string
  kind: RootKind
}

/** Roots of one kind, from the list the configuration names them in. */
export function rootsOf(kind: RootKind, paths: readonly string[]): UntrustedRoot[] {
  return paths.map(path => ({ path, kind }))
}

/** A workspace's own roots, its root and its scratch roots, which a pack built without the node's roots refuses. */
export function ownRoots(view: { root: string; scratchRoots: readonly string[] }): UntrustedRoots {
  return { untrustedRoots: [...rootsOf('workspace', [view.root]), ...rootsOf('scratch root', view.scratchRoots)] }
}

/**
 * Where no program Buckle runs may come from: every root the node knows an agent may have put one in, its workspaces',
 * its scratch roots, and the sources of its writable mounts (NodeRoots). `rootsUnknown` says why not all of them are
 * known, when they are not (the workspace registry cannot be read): every program is then refused, as it could lie in a
 * root not listed.
 */
export interface UntrustedRoots {
  untrustedRoots: readonly UntrustedRoot[]
  rootsUnknown?: string | null
}

// A refusal names the kind of root, never its path: a mounted workspace hides every host path from its agent, and one
// workspace's root is no business of another's.
const ROOT_NAMES: Record<RootKind, string> = { 'workspace': 'a workspace', 'scratch root': 'a scratch root', 'writable mount': 'the source of a writable mount' }

/**
 * A program Buckle runs by name, looked up on PATH once (findExecutable, never in a working directory) and spawned by
 * the real path it leads to. Spawned by its bare name, it would be looked up again by the system: on Windows libuv
 * tries `name.com` and `name.exe` in the child's working directory before PATH, so a program an agent wrote into the
 * workspace would run with Buckle's rights. A program is refused where any place on its way lies inside an untrusted
 * root (`untrustedRoots`): the path found, each link it passes through and where each leads, and where it lands
 * (walkLinks), compared as the disk compares paths (comparablePath). Judged by the path found and its real path alone,
 * a PATH entry linked to a folder in a workspace let the agent point the program there at a trusted one for the check
 * and at its own after it, and the PATH spelling then ran the agent's. `shownAs` names the program in a refusal, where
 * its configured path, which may lie outside the workspace, is no business of the agent's.
 */
export function resolveProgram(name: string, input: ProgramSearch & UntrustedRoots & { shownAs?: string }): ResolvedProgram {
  const platform = input.platform ?? process.platform
  const shown = input.shownAs ?? name
  const found = (input.lookup ?? findExecutable)(name, input.environment ?? process.env, platform)
  if (found === null) return { path: null, reason: `${shown} is not installed on this node`, untrusted: false }
  if (input.rootsUnknown) return { path: null, reason: `${shown} is not run while ${input.rootsUnknown}`, untrusted: true }
  let path: string
  try { path = nativePath(found, platform) } catch (error) { return { path: null, reason: messageOf(error), untrusted: false } }
  if (pathRoot(path) === '') return { path: null, reason: `${shown} is a relative path, which Buckle does not run from a working directory`, untrusted: false }
  let walked: LinkWalk
  // A chain Buckle cannot follow may be one an agent built, so it is refused as one found where an agent writes.
  try { walked = walkLinks(path, platform) } catch (error) { return { path: null, reason: `${shown} cannot be followed to where it really is: ${messageOf(error)}`, untrusted: true } }
  const root = rootHolding(input.untrustedRoots, [path, ...walked.passed, walked.real], platform)
  if (root) return { path: null, reason: `${shown} is found in or through ${ROOT_NAMES[root.kind]} of this node, where an agent can write, so Buckle does not run it`, untrusted: true }
  return { path: walked.real, argv0: path }
}

/**
 * The program a command word names, as the unsandboxed shell spawns it: a path the agent wrote stays as written, and
 * the rules judged that path; a bare name is resolved (resolveProgram), so a program the agent planted in its working
 * directory never stands in for the one on PATH that a rule naming it meant.
 */
export function runnableCommand(command: string, input: ProgramSearch & UntrustedRoots): Program {
  if (isPathReference(command, input.platform ?? process.platform)) return { path: command, argv0: command }
  const program = resolveProgram(command, input)
  if (program.path === null) throw new ToolInputError(program.reason, program.untrusted ? { code: 'PERMISSION_DENIED' } : undefined)
  return program
}

/**
 * PATH for a program Buckle runs on the host: each entry that names one place whatever the working directory
 * (isFullPath), handed over as the real place it leads to (walkLinks), and dropped where any place on its way lies inside
 * an untrusted root. A trusted script that starts `#!/usr/bin/env node`, such as the environment validator,
 * agent-browser, or a node-based language server, looks `node` up on this PATH, so the `node` an agent planted in
 * `<ws>/node_modules/.bin`, which `npx` and `pnpm exec` put first, is never it. The child is handed the path that was
 * judged, never the entry as written: its kernel walks a spelling again, a link first and then a `..`, so
 * `<ws>/lnk/../../bin` judged as text reached the agent's `<ws>/bin`, and a folder the walk passed could become a link
 * after it. An entry through `/proc/self`, `/proc/thread-self`, or `/dev/fd` names a place of whichever process reads
 * it (OWN_PROCESS_PLACES), so it is dropped. On Windows each entry is handed over in the native backslash spelling.
 * Empty while the roots are unknown, as an entry could lie in a root not listed.
 */
export function trustedSearchPath(searchPath: string | undefined, roots: UntrustedRoots, platform: NodeJS.Platform = process.platform): string {
  if (roots.rootsUnknown) return ''
  const delimiter = searchPathDelimiter(platform)
  return (searchPath ?? '').split(delimiter).flatMap(entry => {
    if (!entry) return []
    try {
      const directory = nativePath(entry, platform)
      if (!isFullPath(directory, platform)) return []
      const walked = walkLinks(directory, platform)
      const places = [directory, ...walked.passed, walked.real]
      if (places.some(place => namesOwnProcess(place, platform)) || rootHolding(roots.untrustedRoots, places, platform)) return []
      return [platform === 'win32' ? walked.real.replaceAll('/', '\\') : walked.real]
    } catch { return [] }
  }).join(delimiter)
}

/** Folders that name a place of whichever process reads them: its working directory, root, and open files. */
const OWN_PROCESS_PLACES = ['/proc/self', '/proc/thread-self', '/dev/fd']

function namesOwnProcess(place: string, platform: NodeJS.Platform): boolean {
  return OWN_PROCESS_PLACES.some(folder => isInsideComparable(folder, place, ignoresCase(platform), platform))
}

/** The first untrusted root that holds any of `places`. */
function rootHolding(roots: readonly UntrustedRoot[], places: readonly string[], platform: NodeJS.Platform): UntrustedRoot | undefined {
  return roots.find(root => places.some(place => isInsideComparable(root.path, place, ignoresCase(platform), platform)))
}

/** How many links one lookup follows, as Linux allows (SYMLOOP_MAX). */
const MAX_LINKS = 40

interface LinkWalk {
  /** Where the path lands, each link on the way followed; past a name that does not exist, named as written. */
  real: string
  /** Each link met, where it really lies, and the place it leads, in the order met. */
  passed: string[]
}

/**
 * Where an absolute path in pathe's form really leads, walked one name at a time from its root as the kernel walks it,
 * with every place on the way an agent could change to send it elsewhere: each link met, named where it really lies,
 * and where it leads, followed even where it leads nowhere yet. Each name is appended as text (childPath), and a `..`
 * climbs from where the walk really is. `platform`: the host's unless a test imitates another.
 */
function walkLinks(path: string, platform: NodeJS.Platform): LinkWalk {
  const passed: string[] = []
  let links = 0
  const follow = (start: string, names: readonly string[]): string => {
    let current = start
    for (const name of names) {
      if (name === '' || name === '.') continue
      if (name === '..') { current = parentDirectory(current); continue }
      const next = childPath(current, name)
      if (!isLink(next)) { current = next; continue }
      if (++links > MAX_LINKS) throw new Error(`it passes through more than ${MAX_LINKS} links`)
      const target = withForwardSlashes(readlinkSync(next), platform)
      const root = pathRoot(target, platform)
      passed.push(next)
      current = follow(root === '' ? current : root, target.slice(root.length).split('/'))
      passed.push(current)
    }
    return current
  }
  const root = pathRoot(path, platform)
  return { real: follow(root, path.slice(root.length).split('/')), passed }
}

function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

function searchPathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':'
}

function searchDirectories(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  return (environment.PATH ?? '').split(searchPathDelimiter(platform)).flatMap(entry => {
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
