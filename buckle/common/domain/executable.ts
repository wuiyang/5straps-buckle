import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, join } from 'pathe'
import { childPath, ignoresCase, isInsideComparable, nativePath, parentDirectory, pathRoot, withForwardSlashes } from './paths.js'
import { ToolInputError } from './tool.js'

/** Extensions Windows hands straight to CreateProcess. */
const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.com']

/**
 * The batch files npm, pnpm, and agent-browser's own install write for a command on Windows (`agent-browser.cmd`).
 * Buckle never runs one: Node refuses to spawn a batch file without a shell, and through cmd.exe the agent's arguments
 * would pass through its quoting, which no escaping makes safe. A shim is read as text instead, and the program it
 * starts is run in its place (shimProgram), only where no `.exe` or `.com` of that name is found in any place.
 */
const WINDOWS_SHIM_EXTENSIONS = ['.cmd', '.bat']

/**
 * Resolves a binary by scanning for an executable file: PATH, then the owner places after it (ownerPlaces), and on
 * Windows a shim in any of them only where none holds an `.exe` or `.com` (locateExecutable). A shell function or
 * alias is deliberately not found, because a shell-less spawn cannot run one. Only absolute entries are searched: a
 * relative one (`.`, `bin`) names a directory under whichever working directory a lookup runs in, and on Windows one
 * with a root but no drive (`\bin`) a directory on whichever drive is current (isFullPath).
 */
export function findExecutable(
  binary: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  places: readonly SearchPlace[] = ownerPlaces(environment, platform),
): string | null {
  return locateExecutable(binary, environment, platform, places)?.path ?? null
}

/**
 * A place a bare name is looked for after PATH. `label` names it in a reason an agent may read, never `directory`,
 * which is the owner's.
 */
export interface SearchPlace {
  directory: string
  label: string
}

/** Where a program was found: its path, and the label of the place that held it. */
export interface Located {
  path: string
  place: string
}

/** How a reason names PATH, and a path the owner configured, which is looked at alone. */
export const ON_PATH = 'on PATH'
export const AS_NAMED = 'as named'

/**
 * Where a binary is: a path is looked at alone, and on Windows may name a shim or a script (configuredScript); a bare
 * name in each PATH entry, then in each owner place, for an executable file, and on Windows only then for a shim in the
 * same order, so a program found today is found as before.
 */
export function locateExecutable(binary: string, environment: NodeJS.ProcessEnv, platform: NodeJS.Platform, places: readonly SearchPlace[]): Located | null {
  if (isPathReference(binary, platform)) {
    const found = firstExecutable(binary, platform) ?? firstShim(binary, platform) ?? configuredScript(binary, platform)
    return found === null ? null : { path: found, place: AS_NAMED }
  }
  const searched = [...searchDirectories(environment, platform).map(directory => ({ directory, label: ON_PATH })), ...places]
  for (const pass of [firstExecutable, firstShim]) {
    for (const place of searched) {
      const found = pass(join(place.directory, binary), platform)
      if (found) return { path: found, place: place.label }
    }
  }
  return null
}

/** Where Buckle itself runs from: its entry point and its Node, which two owner places are found by. */
export interface ProgramOrigin {
  entry: string | undefined
  execPath: string
}

/**
 * The places a bare name is looked for after PATH, in order (the owner's request of 2026-10-14, after Buckle did not
 * find a Windows node's agent-browser): the npm global bin that holds Buckle's own command (buckleBin), where
 * `npm i -g` puts the programs Buckle runs; the folder of the Node running Buckle, an nvm or volta bin; and on Windows
 * `%APPDATA%\npm`, npm's own global bin. Each is an owner place, judged like a PATH entry: a program in or through a
 * root an agent writes is still refused. No `where` or `which` is run: the scan is the same lookup with these places
 * added.
 */
export function ownerPlaces(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  origin: ProgramOrigin = { entry: process.argv[1], execPath: process.execPath },
): SearchPlace[] {
  const places: SearchPlace[] = []
  // A place Buckle cannot read as the system does is not searched, as a PATH entry is not.
  const add = (label: string, directory: () => string | null): void => {
    try {
      const named = directory()
      if (named !== null && isFullPath(named, platform)) places.push({ directory: named, label })
    } catch { /* not searched */ }
  }
  add('beside buckle', () => buckleBin(origin.entry, platform))
  add('beside node', () => parentDirectory(nativePath(origin.execPath, platform)))
  if (platform === 'win32' && environment.APPDATA) add('in %APPDATA%\\npm', () => nativePath(`${environment.APPDATA}\\npm`, platform))
  return places
}

/** The npm global bin that holds Buckle's own command (npmGlobalBin), found from the real path of its entry point. */
function buckleBin(entry: string | undefined, platform: NodeJS.Platform): string | null {
  if (!entry) return null
  let real: string
  try { real = nativePath(realpathSync.native(entry), platform) } catch { return null }
  return npmGlobalBin(real, platform)
}

/**
 * The npm global bin beside a package's file, a real path in pathe's form, as npm lays a global install out:
 * `<prefix>/lib/node_modules/<package>` with the commands in `<prefix>/bin` on Linux and macOS, and
 * `<prefix>\node_modules\<package>` with the commands in `<prefix>` on Windows. Outside that layout, such as a clone,
 * the folder that holds the file.
 */
export function npmGlobalBin(real: string, platform: NodeJS.Platform): string {
  const names = real.split('/')
  const at = names.lastIndexOf('node_modules')
  if (at <= 0) return parentDirectory(real)
  const prefix = parentDirectory(names.slice(0, at + 1).join('/'))
  if (platform === 'win32') return prefix
  return basename(prefix) === 'lib' ? childPath(parentDirectory(prefix), 'bin') : parentDirectory(real)
}

/** How a reason names a search: PATH with its count of directories, then each owner place, joined as a list. */
function searchDescription(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform, places: readonly SearchPlace[]): string {
  const count = searchDirectories(environment, platform).length
  const labels = [...new Set([`${ON_PATH} (${count} ${count === 1 ? 'directory' : 'directories'})`, ...places.map(place => place.label)])]
  if (labels.length < 3) return labels.join(' or ')
  return `${labels.slice(0, -1).join(', ')}, or ${labels.at(-1)!}`
}

/** How a program is looked up: findExecutable's signature, so a test can put another in its place. */
export type ExecutableLookup = (binary: string, environment: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string | null

/** Where programs are looked up, and for which platform: the host's unless a test imitates another. */
export interface ProgramSearch {
  /** Answers in the scan's place, for PATH alone: no owner place is then searched or named. */
  lookup?: ExecutableLookup
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** The places searched after PATH; the host's (ownerPlaces) unless a test names its own. */
  places?: readonly SearchPlace[]
}

/**
 * A program Buckle runs: the real path it spawns, with the path PATH gave it as its `argv0`, as a program that answers
 * to the name it was started by (busybox, ccache, a rustup proxy) reads it. `args` go before the arguments of every
 * call: empty for a native program, and the script for one Buckle's own Node runs from a Windows shim (shimProgram).
 */
export interface Program {
  path: string
  argv0: string
  args: string[]
}

/** Why a program is not run. `untrusted` is a program found where an agent can write. */
export interface ProgramRefusal {
  path: null
  reason: string
  untrusted: boolean
  /** For a bare name found nowhere, where it was looked for, by label (searchDescription), for a pack's own reason. */
  searched?: string
  /** For a Windows shim Buckle does not run: its file name, its place's label (null for a configured path), and why. */
  shim?: { file: string; place: string | null; why: string }
}

/** A program Buckle runs, or why it is not run. */
export type ResolvedProgram = Program | ProgramRefusal

/**
 * A resolved program with what only the owner's terminal shows (`buckle init`): the path it was found at and the
 * label of that place, and the shim it was read from. Never part of a reason, which an agent may read.
 */
export interface ProgramFinding {
  resolved: ResolvedProgram
  found: { path: string; place: string; shim: string | null } | null
}

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
 * A program Buckle runs by name, looked up once (findExecutable, never in a working directory) and spawned by the
 * real path it leads to. Spawned by its bare name, it would be looked up again by the system: on Windows libuv tries
 * `name.com` and `name.exe` in the child's working directory before PATH, so a program an agent wrote into the
 * workspace would run with Buckle's rights. A program is refused where any place on its way lies inside an untrusted
 * root (`untrustedRoots`): the path found, each link it passes through and where each leads, and where it lands
 * (walkLinks), compared as the disk compares paths (comparablePath). Judged by the path found and its real path alone,
 * a PATH entry linked to a folder in a workspace let the agent point the program there at a trusted one for the check
 * and at its own after it, and the PATH spelling then ran the agent's. On Windows a shim is read, never run, and the
 * program it starts is judged the same way (shimProgram). `shownAs` names the program in a refusal, where its
 * configured path, which may lie outside the workspace, is no business of the agent's; a place is named by its label.
 */
export function resolveProgram(name: string, input: ProgramSearch & UntrustedRoots & { shownAs?: string }): ResolvedProgram {
  return findProgram(name, input).resolved
}

/** resolveProgram, with where the program was found and the shim it was read from, for the owner's terminal alone. */
export function findProgram(name: string, input: ProgramSearch & UntrustedRoots & { shownAs?: string }): ProgramFinding {
  const platform = input.platform ?? process.platform
  const environment = input.environment ?? process.env
  const shown = input.shownAs ?? name
  // A lookup a test puts in the scan's place answers for PATH alone: no owner place is then searched, or named.
  const places = input.lookup ? [] : input.places ?? ownerPlaces(environment, platform)
  const located = input.lookup ? lookedUp(input.lookup(name, environment, platform), isPathReference(name, platform)) : locateExecutable(name, environment, platform, places)
  if (located === null) {
    if (isPathReference(name, platform)) return refused({ path: null, reason: `${shown} is not installed on this node`, untrusted: false })
    const searched = searchDescription(environment, platform, places)
    return refused({ path: null, reason: `${shown} was not found ${searched}`, untrusted: false, searched })
  }
  const finding = (resolved: ResolvedProgram, shim: string | null = null): ProgramFinding => ({ resolved, found: { path: located.path, place: located.place, shim } })
  if (input.rootsUnknown) return finding({ path: null, reason: `${shown} is not run while ${input.rootsUnknown}`, untrusted: true })
  let path: string
  // A refusal names the program by `shown` alone: the path found, or a link's target, may lie outside the workspace.
  try { path = nativePath(located.path, platform) } catch { return finding({ path: null, reason: `${shown} is a path Buckle cannot read as the system does, so Buckle does not run it`, untrusted: false }) }
  if (pathRoot(path) === '') return finding({ path: null, reason: `${shown} is a relative path, which Buckle does not run from a working directory`, untrusted: false })
  const judged = judgedPlace(path, shown, input.untrustedRoots, platform)
  if (typeof judged !== 'string') return finding(judged)
  if (platform === 'win32' && located.place === AS_NAMED && hasExtension(path, SCRIPT_EXTENSIONS)) {
    return finding(nodeRunning(judged, platform) ?? { path: null, reason: `${shown} is a script, while ${NODE_UNREADABLE}, so Buckle does not run it`, untrusted: false })
  }
  if (platform !== 'win32' || !hasExtension(path, WINDOWS_SHIM_EXTENSIONS)) return finding({ path: judged, argv0: path, args: [] })
  const shim = { file: basename(path), place: located.place === AS_NAMED ? null : located.place }
  const program = shimProgram({ shim: path, real: judged, shown, roots: input.untrustedRoots, platform })
  return finding('why' in program ? shimRefusal(shown, { ...shim, why: program.why }) : program, path)
}

/** The program a pack spawns, or null where it is refused, for a pack that withholds a tool without one (ripgrep). */
export function programOrNull(resolved: ResolvedProgram): Program | null {
  return resolved.path === null ? null : resolved
}

/** What a test's lookup answered, found as named for a path and on PATH for a bare name. */
function lookedUp(path: string | null, named: boolean): Located | null {
  return path === null ? null : { path, place: named ? AS_NAMED : ON_PATH }
}

function refused(resolved: ProgramRefusal): ProgramFinding {
  return { resolved, found: null }
}

/**
 * Where an absolute path in pathe's form really leads (walkLinks), or why it is refused: any place on its way inside an
 * untrusted root, or a chain Buckle cannot follow, which may be one an agent built.
 */
function judgedPlace(path: string, shown: string, roots: readonly UntrustedRoot[], platform: NodeJS.Platform): string | ProgramRefusal {
  let walked: LinkWalk
  try { walked = walkLinks(path, platform) } catch { return { path: null, reason: `${shown} cannot be followed to where it really is, so Buckle does not run it`, untrusted: true } }
  const root = rootHolding(roots, [path, ...walked.passed, walked.real], platform)
  if (root) return { path: null, reason: `${shown} is found in or through ${ROOT_NAMES[root.kind]} of this node, where an agent can write, so Buckle does not run it`, untrusted: true }
  return walked.real
}

/** A shim refused for `why`, named by its file and the label of its place, never by its path. */
function shimRefusal(shown: string, shim: { file: string; place: string | null; why: string }): ProgramRefusal {
  const found = shim.place === null ? `${shown} is ${shim.why}` : `${shown} was found ${shim.place} as ${shim.file}, ${shim.why}`
  return { path: null, reason: `${found}, so Buckle does not run it`, untrusted: false, shim }
}

/** The most of a shim Buckle reads: npm's is under 1 KiB, so a longer file is not one Buckle reads as a shim. */
export const MAX_SHIM_BYTES = 64 * 1024

/**
 * Why a shim's program is not known: Buckle reads only the shapes real generators write (SHIM_TEMPLATES), as it never
 * asks cmd.exe what one runs. A shim that sets a variable, passes arguments of its own, or does anything else is refused
 * this way rather than run without it (the owner's ruling of 2026-10-14: a refusal is honest, a silent drop is not).
 */
const UNREAD_SHIM = 'a shim Buckle cannot read'
const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs']

/**
 * The program a Windows shim starts, read from its text and never by running it (WINDOWS_SHIM_EXTENSIONS, shimTarget),
 * resolved against the shim's folder, a `..` folded as Windows folds it, and judged as every program is (judgedPlace).
 * A script is run by Buckle's own Node, `process.execPath`, with the script's real path first.
 */
function shimProgram(input: { shim: string; real: string; shown: string; roots: readonly UntrustedRoot[]; platform: NodeJS.Platform }): Program | ProgramRefusal | { why: string } {
  const text = readCapped(input.real, MAX_SHIM_BYTES)
  const named = text === null ? { why: UNREAD_SHIM } : shimTarget(text)
  if ('why' in named) return named
  let target: string
  try { target = nativePath(`${parentDirectory(input.shim)}/${named.relative}`, input.platform) } catch { return { why: UNREAD_SHIM } }
  const judged = judgedPlace(target, input.shown, input.roots, input.platform)
  if (typeof judged !== 'string') return judged
  if (!isFile(judged)) return { why: 'a shim whose program is not there' }
  if (!named.script) return { path: judged, argv0: target, args: [] }
  return nodeRunning(judged, input.platform) ?? { why: `a shim that starts a script, while ${NODE_UNREADABLE}` }
}

/** Why no script runs where Buckle's own Node is at a path it does not hand on, named without that path. */
const NODE_UNREADABLE = 'the Node.js running Buckle is at a path Buckle cannot read as the system does'

/**
 * Buckle's own Node, which runs Buckle itself, running a script: it never picks its interpreter from a PATH an agent may
 * reach. Null where that Node's path is one Buckle cannot read as the system does (a share, a device path, a name
 * ending in a dot), which a caller turns into a refusal naming no path, never a throw carrying it (review of 2026-10-14).
 */
function nodeRunning(script: string, platform: NodeJS.Platform): Program | null {
  try {
    return { path: nativePath(process.execPath, platform), argv0: process.execPath, args: [script] }
  } catch { return null }
}

/** A program a shim names beside itself, quoted: no variable, escape, quote, or tab inside the path. */
const BESIDE = String.raw`([^"%^\t]+)`
/** A separator in a template line: spaces and tabs, the ASCII ones cmd reads between words. */
const GAP = '[ \\t]+'
/** One template line, its words joined by GAP: matched whole, case aside, `indented` lines alone after spaces or tabs. */
const line = (words: readonly string[], indented = false): RegExp => new RegExp(`^${indented ? '[ \\t]*' : ''}${words.join(GAP)}$`, 'i')

/**
 * The shapes of shim Buckle reads, each matched exactly, line by line and in order, and nothing else, not even a
 * comment, as no generator writes one (re-checks of 2026-10-14: a grammar of known lines, and then comments, let a
 * chained command, a label in a block, a Ctrl-Z, or a line out of order through). npm's cmd-shim for a script it runs
 * with Node.js: its head, which sets `dp0` to the shim's folder, the probe for a `node.exe` beside it, and the line
 * that runs `"%_prog%"` on the script. And the two-line form agent-browser's own install writes, `@ECHO off` and the
 * native program beside the shim: an `.exe` or `.com` alone, as cmd hands a script named alone to its file association,
 * Windows Script Host for `.js`, never to Node.js.
 */
const SHIM_TEMPLATES: ReadonlyArray<{ lines: readonly RegExp[]; takes: 'script' | 'native' }> = [
  {
    lines: [
      line(['@echo', 'off']), line(['goto', 'start']), line([':find_dp0']), line(['set', 'dp0=%~dp0']), line(['exit', '\\/b']),
      line([':start']), line(['setlocal']), line(['call', ':find_dp0']), line(['if', 'exist', '"%dp0%\\\\node\\.exe"', '\\(']),
      line(['set', '"_prog=%dp0%\\\\node\\.exe"'], true), line(['\\)', 'else', '\\(']), line(['set', '"_prog=node"'], true),
      line(['set', 'pathext=%pathext:;\\.js;=;%'], true), line(['\\)']),
      line(['endlocal', '&', 'goto', '#_undefined_#', '2>nul', '\\|\\|', 'title', '%comspec%', '&', '"%_prog%"', `"%dp0%\\\\${BESIDE}"`, '%\\*']),
    ],
    takes: 'script',
  },
  { lines: [line(['@echo', 'off']), line([`"%~dp0${BESIDE}"`, '%\\*'])], takes: 'native' },
]
/** Printable ASCII, the tab, and the line ends: a shim holding any other character (Ctrl-Z, a BOM, a no-break space) is unread. */
const SHIM_CHARACTERS = /^[\t\n\r\x20-\x7e]*$/

/**
 * What a shim starts, read from its text: a character outside SHIM_CHARACTERS, which cmd may read as another line or
 * another word, or a caret, which it reads as an escape or a line continuation, makes it unread at once. Otherwise each
 * line, one CR at its end dropped and empty lines skipped, must be the next line of one of SHIM_TEMPLATES, to its end.
 * The program is the path its last line names beside the shim, of the kind that template takes.
 */
function shimTarget(text: string): { relative: string; script: boolean } | { why: string } {
  const unread = { why: UNREAD_SHIM }
  if (!SHIM_CHARACTERS.test(text) || text.includes('^')) return unread
  const lines = text.split('\n').map(each => each.replace(/\r$/, '')).filter(each => each !== '')
  for (const template of SHIM_TEMPLATES) {
    const named = matchTemplate(lines, template.lines)
    if (named === null) continue
    const relative = named.replace(/^[\\/]+/, '')
    const script = hasExtension(relative, SCRIPT_EXTENSIONS)
    const native = hasExtension(relative, WINDOWS_EXECUTABLE_EXTENSIONS)
    if (relative === '' || (template.takes === 'script' ? !script : !native)) return unread
    return { relative, script }
  }
  return unread
}

/** The path a shim's lines name beside it where they are `template`, whole and in order; null otherwise. */
function matchTemplate(lines: readonly string[], template: readonly RegExp[]): string | null {
  if (lines.length !== template.length) return null
  let named: string | null = null
  for (const [index, each] of lines.entries()) {
    const match = template[index]!.exec(each)
    if (!match) return null
    named = match[1] ?? named
  }
  return named
}

/** A file's text, or null where it cannot be read or holds more than `limit` bytes. */
function readCapped(path: string, limit: number): string | null {
  let descriptor: number
  try { descriptor = openSync(path, 'r') } catch { return null }
  try {
    if (!fstatSync(descriptor).isFile()) return null
    const buffer = Buffer.alloc(limit + 1)
    let length = 0
    for (let read = -1; read !== 0 && length <= limit;) {
      read = readSync(descriptor, buffer, length, buffer.length - length, null)
      length += read
    }
    return length > limit ? null : buffer.subarray(0, length).toString('utf8')
  } catch {
    return null
  } finally {
    closeSync(descriptor)
  }
}

/**
 * The program a command word names, as the unsandboxed shell spawns it: a path the agent wrote stays as written, and
 * the rules judged that path; a bare name is resolved (resolveProgram), so a program the agent planted in its working
 * directory never stands in for the one on PATH that a rule naming it meant.
 */
export function runnableCommand(command: string, input: ProgramSearch & UntrustedRoots): Program {
  if (isPathReference(command, input.platform ?? process.platform)) return { path: command, argv0: command, args: [] }
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

/**
 * Every place an absolute path in pathe's form passes on its way, as resolveProgram judges a program by them: the path
 * as named, each link met and where each leads, and where it lands, last (walkLinks). A folder the owner names for
 * Buckle to load from, a browser profile, is refused where any of these lies where an agent can write. Throws where the
 * chain cannot be followed.
 */
export function placesOnTheWay(path: string, platform: NodeJS.Platform = process.platform): string[] {
  const walked = walkLinks(path, platform)
  return [path, ...walked.passed, walked.real]
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
 * has to be suffixed before it will ever be found. A shim is never among them (firstShim).
 */
export function executableCandidates(path: string, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return [path]
  if (hasExtension(path, WINDOWS_EXECUTABLE_EXTENSIONS)) return [path]
  return WINDOWS_EXECUTABLE_EXTENSIONS.map(extension => `${path}${extension}`)
}

/** A backslash only separates directories on Windows; elsewhere it is a legal filename character. */
export function isPathReference(binary: string, platform: NodeJS.Platform): boolean {
  return binary.includes('/') || (platform === 'win32' && binary.includes('\\'))
}

function firstExecutable(path: string, platform: NodeJS.Platform): string | null {
  return executableCandidates(path, platform).find(isExecutableFile) ?? null
}

/**
 * A Windows shim for one candidate path: the path itself where it names one, or the path with each shim extension where
 * it names neither a shim nor an `.exe` or `.com`. Windows has no execute bit, so a file is enough.
 */
function firstShim(path: string, platform: NodeJS.Platform): string | null {
  if (platform !== 'win32' || hasExtension(path, WINDOWS_EXECUTABLE_EXTENSIONS)) return null
  const candidates = hasExtension(path, WINDOWS_SHIM_EXTENSIONS) ? [path] : WINDOWS_SHIM_EXTENSIONS.map(extension => `${path}${extension}`)
  return candidates.find(isFile) ?? null
}

/**
 * A script the owner names by its path on Windows, which has no shebang: Buckle's own Node runs it (nodeRunning), as a
 * shim's script is run, so the owner can name the script a shim Buckle refuses starts.
 */
function configuredScript(path: string, platform: NodeJS.Platform): string | null {
  return platform === 'win32' && hasExtension(path, SCRIPT_EXTENSIONS) && isFile(path) ? path : null
}

function hasExtension(path: string, extensions: readonly string[]): boolean {
  const lower = path.toLowerCase()
  return extensions.some(extension => lower.endsWith(extension))
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

function isFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}
