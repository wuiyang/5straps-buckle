import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import { constants, fstatSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'pathe'
import { withFileBeneath } from '../../adapters/beneath.js'
import { baseCommand, shellScriptOperand, shellStatementList, shellTokens } from '../../domain/argv.js'
import { READ_BUDGET } from '../../domain/command-forms.js'
import type { PathView } from '../../domain/path-view.js'
import { isInside } from '../../domain/paths.js'
import type { JudgeFile, JudgePackage } from '../../types/ports/judge.js'
import { resolveTarget } from '../invocation/real-path.js'

/** What the judge reads of one call's code at most (D91, addendum B): beyond either, it rates nothing and the call asks. */
export const CODE_LIMITS = Object.freeze({ files: 50, bytes: 512 * 1_024 })

/** Why the judge rates nothing: the code ran past CODE_LIMITS, or it runs a file nobody may read for it. */
export const CODE_REFUSALS = Object.freeze({
  truncated: 'the code closure exceeds what the judge reads',
  unreadable: 'the code runs a file the agent cannot read without asking',
  unnamed: 'the code runs a file the sandbox does not name',
  binary: 'the code runs a file that is not text',
  missing: 'the code imports a file that does not exist',
  failed: 'the code could not be read',
})

export interface CodeReading { inline: string | null; files: JudgeFile[]; packages: JudgePackage[] }
export type CodeRead = { kind: 'read'; reading: CodeReading } | { kind: 'refused'; reason: string; truncated: boolean }

/**
 * How the reader reaches files: through the agent's own view and the checks its file tools make, so it reads nothing an
 * agent could not read without asking, follows no link out of the workspace, and names every file as the sandbox does.
 */
export interface CodeView {
  /**
   * Where a name lands, a relative one from `base` (a real folder): the real regular file, `none` where it names no
   * regular file, or `outside` where it lands beyond every place the agent's view reaches.
   */
  locate(name: string, base: string): Located
  /** Whether the agent may read the real file without asking. */
  readable(real: string): boolean
  /** The file's bytes, opened beneath its parent and never through a link; null where it holds more than `limit` bytes. */
  read(real: string, limit: number): Buffer | null
  /** The file as the judge is shown it, or null where only a host path would name it. */
  shown(real: string): string | null
  /** The real root of the workspace or the mount holding a real path, or null where neither does. */
  rootOf(real: string): string | null
}

export type Located = { real: string } | 'none' | 'outside'

type Language = 'js' | 'python' | 'shell' | null

/**
 * The code an interpreter call runs, read for the judge (D91, addendum B): the code its command line hands the
 * interpreter (`-c`, `-e`, or a here-string in the text of a shell that has them), every argument naming a regular file the agent may read, and every local file those import,
 * transitively, each read once by its real path. JavaScript and TypeScript `import`, `export from`, `import()`, and
 * `require()` of a path; Python `import` and `from import` of a module beside the file or under the working directory;
 * shell `source` and `.`. A bare specifier is a third-party package, named and never read. Refused, so the call asks,
 * past CODE_LIMITS, at an argument or a file beyond every place the agent's view reaches, at a file the agent may not
 * read or the sandbox does not name, at one that is not text, and at a local import naming nothing.
 */
export function readInterpreterCode(input: CodeInput): CodeRead {
  // A file that vanished, one nobody may open, or a hard link onto Buckle's state throws, naming a host path: the judge
  // rates nothing then, and the reason names no path.
  try { return readCode(input) } catch { return refused(CODE_REFUSALS.failed) }
}

/**
 * What the reader is handed: the interpreter invocations to read (`forms`), every form of the call (`shellForms`), in
 * which shell text may feed one of them a here-string, the real working directory, and the agent's view.
 */
export interface CodeInput { forms: readonly string[][]; shellForms?: readonly string[][]; cwd: string; view: CodeView }

function readCode(input: CodeInput): CodeRead {
  const { view, cwd } = input
  const inline: string[] = []
  // Each package by name, with the real folder its version is looked up from (the first importer's), or null for none.
  const packages: Packages = new Map()
  const queue: Array<{ real: string; language: Language }> = []
  for (const [command = '', ...args] of input.forms) {
    const program = programOf(command)
    const read = argumentsOf(program, args)
    inline.push(...read.inline)
    for (const name of read.packages) named(packages, name, cwd)
    const language = languageOfProgram(program)
    // `python -m a.b`: the module's file under the working directory, with its package's __main__.py, else a package.
    for (const module of read.modules) {
      const files = pythonModule({ module, roots: [cwd], view, main: true })
      if (files.length === 0) named(packages, module.split('.')[0]!, null)
      queue.push(...files)
    }
    // A word naming no file is no script; one landing beyond every place the agent's view reaches may be one the
    // judge cannot see, so the call asks.
    for (const name of read.candidates) {
      const located = view.locate(name, cwd)
      if (located === 'outside') return refused(CODE_REFUSALS.unreadable)
      if (typeof located === 'object') queue.push({ real: located.real, language })
    }
    for (const code of read.inline) {
      const found = importsOf(language, code, { file: null, cwd, view, packages })
      if (typeof found === 'string') return refused(found)
      queue.push(...found)
    }
  }
  for (const { program, code } of hereStringsOf(input.shellForms ?? [], input.forms)) {
    inline.push(code)
    const found = importsOf(languageOfProgram(program), code, { file: null, cwd, view, packages })
    if (typeof found === 'string') return refused(found)
    queue.push(...found)
  }
  const files: JudgeFile[] = []
  const seen = new Set<string>()
  // The code the command line hands the interpreter is sent too, so it counts toward what the judge reads.
  let bytes = inline.reduce((total, code) => total + Buffer.byteLength(code), 0)
  if (bytes > CODE_LIMITS.bytes) return refused(CODE_REFUSALS.truncated, true)
  while (queue.length > 0) {
    const next = queue.shift()!
    if (seen.has(next.real)) continue
    seen.add(next.real)
    if (files.length >= CODE_LIMITS.files) return refused(CODE_REFUSALS.truncated, true)
    if (!view.readable(next.real)) return refused(CODE_REFUSALS.unreadable)
    const path = view.shown(next.real)
    if (path === null) return refused(CODE_REFUSALS.unnamed)
    const buffer = view.read(next.real, CODE_LIMITS.bytes - bytes)
    if (buffer === null) return refused(CODE_REFUSALS.truncated, true)
    if (!isUtf8(buffer)) return refused(CODE_REFUSALS.binary)
    bytes += buffer.length
    const content = buffer.toString('utf8')
    files.push({ path, sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length, content })
    const language = languageOfFile(next.real, content) ?? next.language
    const found = importsOf(language, content, { file: next.real, cwd, view, packages })
    if (typeof found === 'string') return refused(found)
    queue.push(...found)
  }
  return { kind: 'read', reading: { inline: inline.length > 0 ? inline.join('\n') : null, files, packages: installed(packages, view) } }
}

/** The shells whose text may feed a command a here-string (`<<<`): bash, and the shells that share ksh's syntax for it. */
const HERE_STRING_SHELLS = new Set(['bash', 'rbash', 'zsh', 'ksh', 'mksh', 'yash'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const REDIRECTION = /^\d*[<>]/
const BARE_REDIRECTION = /^\d*(?:<<-|<<?<?|>>?|>\||<>)$/
const HERE_STRING = /^0?<<</

/**
 * The code a here-string hands an interpreter (D91, addendum 2 F3): in the `-c` text of each form run by a shell that has
 * here-strings, each statement whose command is one of the interpreters being read and whose input a `<<<` word feeds,
 * that word as the statement passes it, an expansion in it as written. A here-string fed to another command, which
 * pipes it on, is not the interpreter's code.
 */
function hereStringsOf(shellForms: readonly string[][], forms: readonly string[][]): Array<{ program: string; code: string }> {
  const running = new Set(forms.map(([command = '']) => programOf(command)))
  const found: Array<{ program: string; code: string }> = []
  for (const [command = '', ...args] of shellForms) {
    if (!HERE_STRING_SHELLS.has(baseCommand(command))) continue
    const { source, operand } = shellScriptOperand(args)
    if (source !== 'command' || operand === undefined) continue
    for (const statement of shellStatementList(operand, { characters: READ_BUDGET.characters }).statements) {
      const tokens = shellTokens(statement)
      const program = commandWord(tokens)
      if (program === null || !running.has(programOf(program))) continue
      for (let index = 0; index < tokens.length; index++) {
        const { raw, word } = tokens[index]!
        if (!HERE_STRING.test(raw)) continue
        const code = BARE_REDIRECTION.test(raw) ? tokens[index + 1]?.word : word.replace(HERE_STRING, '')
        if (code !== undefined) found.push({ program: programOf(program), code })
      }
    }
  }
  return found.filter((item, index) => found.findIndex(other => other.program === item.program && other.code === item.code) === index)
}

/** A statement's command word: the first word that is neither an assignment nor a redirection or its target. */
function commandWord(tokens: ReadonlyArray<{ raw: string; word: string }>): string | null {
  for (let index = 0; index < tokens.length; index++) {
    const { raw, word } = tokens[index]!
    if (REDIRECTION.test(raw)) {
      if (BARE_REDIRECTION.test(raw)) index++
      continue
    }
    if (!ASSIGNMENT.test(raw)) return word
  }
  return null
}

function refused(reason: string, truncated = false): CodeRead {
  return { kind: 'refused', reason, truncated }
}

/** An interpreter's program, its version and build dropped: `python3.12` is python, `nodejs` node. */
function programOf(command: string): string {
  const name = baseCommand(command)
  const match = /^(python|pypy|node|nodejs|deno|bun|perl|ruby|php|awk|gawk|mawk|nawk|lua|luajit|pwsh|powershell|tsx|ts-node|npx|pnpx|bunx|tcsh|csh|busybox|toybox)/.exec(name)
  const program = match?.[1] ?? name
  return program === 'nodejs' ? 'node' : program === 'pypy' ? 'python' : program
}

/** The flags after which the next word is code, by program; a `--flag=code` spelling counts too. */
const INLINE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  python: ['-c'], node: ['-e', '--eval', '-p', '--print'], bun: ['-e', '--eval', '-p', '--print'], tsx: ['-e', '--eval', '-p', '--print'],
  'ts-node': ['-e', '--eval', '-p', '--print'], deno: [], perl: ['-e', '-E'], ruby: ['-e'], php: ['-r'], lua: ['-e'], luajit: ['-e'],
  pwsh: ['-c', '-Command', '-command'], powershell: ['-c', '-Command', '-command'], tcsh: ['-c'], csh: ['-c'], busybox: ['-c'], toybox: ['-c'],
}
const AWKS = new Set(['awk', 'gawk', 'mawk', 'nawk'])
const RUNNERS = new Set(['npx', 'pnpx', 'bunx'])

/**
 * One interpreter invocation's words, read for the code they hand it: the code after an inline flag (and an awk
 * program, and `deno eval`'s text), the package a runner runs, which is named and never read, and every other word,
 * each a name that may be a file.
 */
function argumentsOf(program: string, args: readonly string[]): { inline: string[]; packages: string[]; modules: string[]; candidates: string[] } {
  const inline: string[] = []
  const packages: string[] = []
  const modules: string[] = []
  const candidates: string[] = []
  const flags = INLINE_FLAGS[program] ?? []
  const awkProgramFile = AWKS.has(program) && args.some(arg => arg === '-f' || arg.startsWith('-f'))
  let awkProgram = AWKS.has(program) && !awkProgramFile
  let runnerPackage = RUNNERS.has(program)
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    const equals = word.startsWith('--') ? word.indexOf('=') : -1
    if (flags.includes(word) && index + 1 < args.length) {
      inline.push(args[++index]!)
      continue
    }
    if (equals > 0 && flags.includes(word.slice(0, equals))) {
      inline.push(word.slice(equals + 1))
      continue
    }
    if (program === 'python' && word === '-m' && index + 1 < args.length) {
      modules.push(args[++index]!)
      // What follows the module is its own arguments, each a name that may be a file.
      candidates.push(...args.slice(index + 1))
      break
    }
    if (program === 'deno' && word === 'eval' && index + 1 < args.length) {
      inline.push(args[++index]!)
      continue
    }
    const positional = !word.startsWith('-')
    if (awkProgram && positional) {
      inline.push(word)
      awkProgram = false
      continue
    }
    if (runnerPackage && positional) {
      packages.push(packageName(word))
      runnerPackage = false
      continue
    }
    candidates.push(word)
    if (equals > 0) candidates.push(word.slice(equals + 1))
  }
  return { inline, packages, modules, candidates }
}

/** A package as its name: `@scope/name` or `name`, without a version, a subpath, or a `node:` builtin's prefix kept apart. */
function packageName(specifier: string): string {
  const unversioned = specifier.replace(/^(@?[^@]+)@.*$/, '$1')
  const parts = unversioned.split('/')
  return unversioned.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

function languageOfProgram(program: string): Language {
  if (program === 'python') return 'python'
  if (['node', 'deno', 'bun', 'tsx', 'ts-node', 'npx', 'pnpx', 'bunx'].includes(program)) return 'js'
  if (['tcsh', 'csh', 'busybox', 'toybox'].includes(program)) return 'shell'
  return null
}

/** A file's language by its extension, else its shebang; null where neither names one. */
function languageOfFile(real: string, content: string): Language {
  if (/\.(?:[cm]?[jt]sx?)$/.test(real)) return 'js'
  if (real.endsWith('.py')) return 'python'
  if (/\.(?:sh|bash|zsh|ksh)$/.test(real)) return 'shell'
  if (real.endsWith('.json')) return null
  const shebang = /^#!.*?\b(python|node|bash|zsh|ksh|dash|sh)\b/.exec(content)
  if (!shebang) return null
  return shebang[1] === 'python' ? 'python' : shebang[1] === 'node' ? 'js' : 'shell'
}

type Found = Array<{ real: string; language: Language }>
type Packages = Map<string, string | null>

/** A package imported, kept with the folder its first importer reads from; null where no version is looked up (Python). */
function named(packages: Packages, name: string, from: string | null): void {
  if (!packages.has(name)) packages.set(name, from)
}

/** An npm package name, scoped or not: anything else (a `node:` builtin, a stray word) has no node_modules folder. */
const NPM_NAME = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/i
const VERSION = /^[\w.+-]{1,64}$/
/** What of a package.json is read for its version at most. */
const MANIFEST_LIMIT = 64 * 1_024

/** Each package by name, sorted, with the version installed for its importer; no Socket summary yet. */
function installed(packages: Packages, view: CodeView): JudgePackage[] {
  return [...packages].sort(([one], [other]) => (one < other ? -1 : one > other ? 1 : 0)).map(([name, from]) => ({ name, version: from === null ? null : installedVersion(name, from, view), socket: null }))
}

/**
 * The version of `name` an importer in `from` gets (D91, addendum 2 C): the `version` of the nearest
 * `node_modules/<name>/package.json`, walking up from `from` and stopping at the workspace root or the mount root, read
 * with the same checks as the code. Null where none is found, where a link leaves for a place the agent may not read,
 * and where the manifest holds no version.
 */
function installedVersion(name: string, from: string, view: CodeView): string | null {
  const root = view.rootOf(from)
  if (!NPM_NAME.test(name) || root === null) return null
  for (let folder = from; isInside(root, folder); folder = dirname(folder)) {
    const located = view.locate(`./node_modules/${name}/package.json`, folder)
    if (typeof located === 'object') return manifestVersion(located.real, view)
    if (located === 'outside' || folder === root || dirname(folder) === folder) return null
  }
  return null
}

function manifestVersion(real: string, view: CodeView): string | null {
  try {
    if (!view.readable(real)) return null
    const buffer = view.read(real, MANIFEST_LIMIT)
    const version = buffer === null ? undefined : (JSON.parse(buffer.toString('utf8')) as { version?: unknown }).version
    return typeof version === 'string' && VERSION.test(version) ? version : null
  } catch {
    return null
  }
}

/**
 * The local files one piece of code imports, by its language, each with the language it is read as; the bare
 * specifiers are added to `packages`. A string where an import names a local file that does not exist.
 */
function importsOf(language: Language, code: string, place: { file: string | null; cwd: string; view: CodeView; packages: Packages }): Found | string {
  if (language === 'js') return jsImports(code, place)
  if (language === 'python') return pythonImports(code, place)
  if (language === 'shell') return shellSources(code, place)
  return []
}

const JS_SPECIFIERS = [
  /\bimport\s+(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"\n]+)['"]/g,
  /\bexport\s+[\w*{}\s,$]+?\s+from\s+['"]([^'"\n]+)['"]/g,
  /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
]
const JS_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.json']
/** A TypeScript project imports `./a.js` for the `./a.ts` it compiles to it. */
const TS_SOURCES: Readonly<Record<string, readonly string[]>> = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }

function jsImports(code: string, place: { file: string | null; cwd: string; view: CodeView; packages: Packages }): Found | string {
  const found: Found = []
  const base = place.file === null ? place.cwd : dirname(place.file)
  for (const pattern of JS_SPECIFIERS) {
    for (const [, specifier = ''] of code.matchAll(pattern)) {
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
        named(place.packages, packageName(specifier), base)
        continue
      }
      const located = jsCandidates(specifier).map(name => place.view.locate(name, base))
      const file = located.find(item => typeof item === 'object')
      if (file) found.push({ real: file.real, language: null })
      else return located.includes('outside') ? CODE_REFUSALS.unreadable : CODE_REFUSALS.missing
    }
  }
  return found
}

function jsCandidates(specifier: string): string[] {
  const extension = /\.[cm]?js$/.exec(specifier)?.[0]
  const swapped = extension ? (TS_SOURCES[extension] ?? []).map(source => specifier.slice(0, -extension.length) + source) : []
  return [specifier, ...swapped, ...JS_EXTENSIONS.map(ext => `${specifier}${ext}`), ...JS_EXTENSIONS.map(ext => `${specifier}/index${ext}`)]
}

const PYTHON_IMPORT = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm
const PYTHON_FROM = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+\(?([\w\t ,*]+)/gm

function pythonImports(code: string, place: { file: string | null; cwd: string; view: CodeView; packages: Packages }): Found | string {
  const found: Found = []
  const beside = place.file === null ? place.cwd : dirname(place.file)
  for (const [, list = ''] of code.matchAll(PYTHON_IMPORT)) {
    for (const module of list.split(',').map(item => item.trim().split(/\s+/)[0]!).filter(Boolean)) {
      const files = pythonModule({ module, roots: [beside, place.cwd], view: place.view })
      if (files.length === 0) named(place.packages, module.split('.')[0]!, null)
      found.push(...files)
    }
  }
  for (const [, dots = '', module = '', names = ''] of code.matchAll(PYTHON_FROM)) {
    const imported = names.split(',').map(name => name.trim().split(/\s+/)[0]!).filter(name => name && name !== '*')
    let roots = [beside, place.cwd]
    if (dots.length > 0) {
      let root = beside
      for (let level = 1; level < dots.length; level++) root = dirname(root)
      roots = [root]
      // `from . import a`: each name is a module of the package; `from .m import a`: m is, and a may be one too.
      for (const name of module === '' ? imported : [module]) {
        const files = pythonModule({ module: name, roots, view: place.view })
        if (files.length === 0) return CODE_REFUSALS.missing
        found.push(...files)
      }
      if (module === '') continue
    } else {
      const files = pythonModule({ module, roots, view: place.view })
      if (files.length === 0) {
        named(place.packages, module.split('.')[0]!, null)
        continue
      }
      found.push(...files)
    }
    // A name imported from a package may be a module of it, which runs on import too.
    for (const name of imported) found.push(...pythonModule({ module: `${module}.${name}`, roots, view: place.view }))
  }
  return found
}

/**
 * A dotted module's file under the first root that holds it, with every package `__init__.py` above it that runs on
 * import; with `main`, as `python -m` runs it, a package's `__main__.py` too.
 */
function pythonModule(input: { module: string; roots: readonly string[]; view: CodeView; main?: boolean }): Found {
  const parts = input.module.split('.').filter(Boolean)
  for (const root of input.roots) {
    const path = join(...parts)
    const module = fileAt(input.view, `./${path}.py`, root) ?? fileAt(input.view, `./${path}/__init__.py`, root)
    if (!module) continue
    const packages = parts.slice(0, -1).flatMap((_, index) => {
      const init = fileAt(input.view, `./${join(...parts.slice(0, index + 1))}/__init__.py`, root)
      return init ? [init] : []
    })
    const main = input.main && module.endsWith('__init__.py') ? fileAt(input.view, `./${path}/__main__.py`, root) : null
    return [...packages, module, ...(main ? [main] : [])].map(real => ({ real, language: 'python' as const }))
  }
  return []
}

const SHELL_SOURCE = /(?:^|[\n;&|(]|\bthen|\bdo|\belse)[ \t]*(?:source|\.)[ \t]+(['"]?)([^\s'";&|)]+)\1/g

function shellSources(code: string, place: { file: string | null; cwd: string; view: CodeView; packages: Packages }): Found | string {
  const found: Found = []
  for (const [, , name = ''] of code.matchAll(SHELL_SOURCE)) {
    // A name an expansion supplies exists only once the shell runs; the judge reads the line that names it.
    if (name.includes('$') || name.includes('`')) continue
    const located = [place.view.locate(name, place.cwd), ...(place.file === null ? [] : [place.view.locate(name, dirname(place.file))])]
    const file = located.find(item => typeof item === 'object')
    if (file) found.push({ real: file.real, language: 'shell' })
    else return located.includes('outside') ? CODE_REFUSALS.unreadable : CODE_REFUSALS.missing
  }
  return found
}

/** The real file a name lands on, or null where it lands on none. */
function fileAt(view: CodeView, name: string, base: string): string | null {
  const located = view.locate(name, base)
  return typeof located === 'object' ? located.real : null
}

/**
 * The reader's view through a workspace's paths: a name lands where the agent's own view resolves it, followed to the
 * file it reaches as a file tool's would be; `canRead` is the permission rules' answer for a read there with no grant,
 * and the bytes are read beneath their folder, never through a link, refusing a hard link onto Buckle's state.
 */
export function createCodeView(input: { paths: PathView; canRead: (real: string) => boolean; protectedRoots: readonly string[] }): CodeView {
  const { paths } = input
  return {
    locate(name, base) {
      let named: string
      try { named = name.startsWith('/') ? paths.resolve(name) : paths.resolve(join(base, name)) } catch { return 'outside' }
      try {
        const real = resolveTarget(named, { shares: paths.shares })
        return statSync(real).isFile() ? { real } : 'none'
      } catch {
        return 'none'
      }
    },
    readable: input.canRead,
    read(real, limit) {
      return withFileBeneath(real, { flags: constants.O_RDONLY, protectedRoots: input.protectedRoots, roots: paths.reachableRoots }, (descriptor) => {
        if (fstatSync(descriptor).size > limit) return null
        return readFileSync(descriptor)
      })
    },
    shown(real) {
      if (isInside(paths.root, real)) return joinShown(paths.mount ?? '/workspace', relative(paths.root, real))
      const mount = paths.mountOf(real)
      if (!mount || mount.target === mount.source) return null
      return joinShown(mount.target, relative(mount.source, real))
    },
    rootOf(real) {
      if (isInside(paths.root, real)) return paths.root
      return paths.mountOf(real)?.source ?? null
    },
  }
}

function joinShown(target: string, rest: string): string {
  return rest === '' ? target : `${target.replace(/\/$/, '')}/${rest}`
}
