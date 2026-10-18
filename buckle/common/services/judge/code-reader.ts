import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import { constants, fstatSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'pathe'
import { withFileBeneath } from '../../adapters/beneath.js'
import { baseCommand, SHELL_COMMANDS, shellScriptOperand, shellStatementList, shellTokens } from '../../domain/argv.js'
import { commandFormsOf, READ_BUDGET } from '../../domain/command-forms.js'
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
  notFound: 'the code the interpreter runs was not found',
  fromCommand: 'the code the interpreter runs comes from another command',
  unknownOption: 'an option the reader does not know',
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
  // Each package by name, with every real folder an importer looks its version up from, or null for none (Python).
  const packages: Packages = new Map()
  // Each file to read, with the runtime whose rules resolve what it imports: the entry's program, or for a runner the
  // package it runs; a file inherits its importer's (fix brief 3, F1).
  const queue: Array<{ real: string; language: Language; runtime: string }> = []
  const enqueue = (found: Found, runtime: string) => { for (const item of found) queue.push({ ...item, runtime }) }
  for (const [command = '', ...args] of input.forms) {
    const program = programOf(command)
    const read = argumentsOf(program, args)
    // An option the reader does not model could change which word is the script, so the call asks rather than rate code
    // that may not be the code that runs (fix brief 3, R7).
    if (read.unknownOption) return refused(CODE_REFUSALS.unknownOption)
    inline.push(...read.inline)
    for (const name of read.packages) named(packages, name, cwd)
    const language = languageOfProgram(program)
    const runtime = RUNNERS.has(program) ? programOf(read.packages[0] ?? '') : program
    // `python -m a.b`: the module's file under the working directory, with its package's __main__.py, else a package.
    for (const module of read.modules) {
      const files = pythonModule({ module, roots: [cwd], view, main: true })
      if (files.length === 0) named(packages, module.split('.')[0]!, null)
      enqueue(files, runtime)
    }
    for (const preload of read.preloads) {
      const found = preloadOf(program, preload, { cwd, view, packages })
      if (typeof found === 'string') return refused(found)
      if (found !== null) queue.push({ real: found.real, language: 'js', runtime })
    }
    // The script, found as the interpreter finds it; where it names nothing and no inline code or module stands in for
    // it, the code that runs is unknown, so the call asks.
    for (const name of read.programFiles) {
      const entry = scriptEntry(program, name, cwd, view)
      if (entry === 'outside' || entry === 'unreadable') return refused(CODE_REFUSALS.unreadable)
      if (entry === 'none') return refused(CODE_REFUSALS.notFound)
      queue.push({ real: entry.real, language, runtime })
    }
    if (read.operand !== null) {
      const entry = scriptEntry(read.operand.runtime, read.operand.name, cwd, view)
      if (entry === 'outside' || entry === 'unreadable') return refused(CODE_REFUSALS.unreadable)
      if (typeof entry === 'object') queue.push({ real: entry.real, language, runtime: read.operand.runtime })
      else if (read.operand.required && read.inline.length === 0 && read.modules.length === 0) return refused(CODE_REFUSALS.notFound)
    }
    // A word naming no file is no script; one landing beyond every place the agent's view reaches may be one the
    // judge cannot see, so the call asks.
    for (const name of read.candidates) {
      const located = view.locate(name, cwd)
      if (located === 'outside') return refused(CODE_REFUSALS.unreadable)
      if (typeof located === 'object') queue.push({ real: located.real, language, runtime })
    }
    for (const code of read.inline) {
      const found = importsOf(language, code, { file: null, cwd, view, packages, runtime })
      if (typeof found === 'string') return refused(found)
      enqueue(found, runtime)
    }
  }
  const fed = fedInputsOf(input.shellForms ?? [], input.forms)
  if (fed.overBudget) return refused(CODE_REFUSALS.truncated, true)
  if (fed.fromCommand) return refused(CODE_REFUSALS.fromCommand)
  if (fed.unknown) return refused(CODE_REFUSALS.notFound)
  for (const { program, code } of fed.inline) {
    inline.push(code)
    const found = importsOf(languageOfProgram(program), code, { file: null, cwd, view, packages, runtime: program })
    if (typeof found === 'string') return refused(found)
    enqueue(found, program)
  }
  // A file redirected into an interpreter's input is its script (`python3 < job.py`).
  for (const { program, name } of fed.scripts) {
    const located = view.locate(name, cwd)
    if (located === 'outside') return refused(CODE_REFUSALS.unreadable)
    if (located === 'none') return refused(CODE_REFUSALS.notFound)
    queue.push({ real: located.real, language: languageOfProgram(program), runtime: program })
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
    const found = importsOf(language, content, { file: next.real, cwd, view, packages, runtime: next.runtime })
    if (typeof found === 'string') return refused(found)
    enqueue(found, next.runtime)
  }
  return { kind: 'read', reading: { inline: inline.length > 0 ? inline.join('\n') : null, files, packages: installed(packages, view) } }
}

/** The shells whose text may feed a command a here-string (`<<<`): bash, and the shells that share ksh's syntax for it. */
const HERE_STRING_SHELLS = new Set(['bash', 'rbash', 'zsh', 'ksh', 'mksh', 'yash'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const REDIRECTION = /^\d*[<>]/
const BARE_REDIRECTION = /^\d*(?:<<-|<<?<?|>>?|>\||<>)$/
const HERE_STRING = /^0?<<</
/** A heredoc on a statement's input (`<<EOF`, `0<<'EOF'`, `<<-EOF`), and one on any descriptor. */
const STDIN_HEREDOC = /^0?<<(?!<)/
const ANY_HEREDOC = /^\d*<<(?!<)/
const ANY_HEREDOC_IN_TEXT = /<<(?!<)/
/** A file redirected into a statement's input: `<`, `0<`, `<>`, or `0<>`, never a heredoc, a descriptor, or a process substitution. */
const STDIN_FILE = /^0?<(?![<&(])/
/** A descriptor duplicated onto a statement's input (`<&3`, `0<&3`), whose code no reading can know (fix brief 2, H6). */
const STDIN_DUPLICATE = /^0?<&/
const EXPANSION = /[$`]/
/** Any redirection of a statement's input: a file, a heredoc, a here-string, or a descriptor. */
const STDIN_REDIRECTION = /^0?</

/** What shell text feeds the interpreters being read: here-strings as inline code, files redirected into their input as scripts. */
interface FedInputs {
  inline: Array<{ program: string; code: string }>
  scripts: Array<{ program: string; name: string }>
  /** Whether a redirected file's name is built by an expansion, so which code runs is unknown. */
  unknown: boolean
  /** Whether reading the text and its heredoc bodies ran past READ_BUDGET, so some code was left unread. */
  overBudget: boolean
  /** Whether what a statement feeds goes to another command first, such as xargs, which runs the interpreter with it. */
  fromCommand: boolean
}

/**
 * What shell text feeds an interpreter's input (D91, addendum 2 F3, and fix brief 1 item 7): in the `-c` text of each
 * form run by a shell, each statement whose command is one of the interpreters being read, the word a `<<<` feeds it
 * (in a shell that has here-strings), an expansion in it as written, and the file a `<` redirects into it where it names
 * no script of its own. A here-string or a file fed to another command, which pipes it on, is not the interpreter's code.
 */
function fedInputsOf(shellForms: readonly string[][], forms: readonly string[][]): FedInputs {
  const running = new Set(forms.map(([command = '']) => programOf(command)))
  const fed: FedInputs = { inline: [], scripts: [], unknown: false, overBudget: false, fromCommand: false }
  // One budget for every text and every heredoc body walked, so no text costs more than READ_BUDGET in all (fix brief 2, R9).
  const meter = { characters: READ_BUDGET.characters }
  for (const [command = '', ...args] of shellForms) {
    const shell = baseCommand(command)
    if (!SHELL_COMMANDS.has(shell)) continue
    const { source, operand } = shellScriptOperand(args)
    if (source !== 'command' || operand === undefined) continue
    const heredocs = heredocIndex(operand, meter)
    for (const statement of shellStatementList(operand, meter).statements) {
      const tokens = shellTokens(statement)
      const chain = statementCommand(tokens)
      const form = chain?.at(-1)
      if (form === undefined || !running.has(programOf(form[0]!))) continue
      const program = programOf(form[0]!)
      // xargs reads the statement's input itself and runs the interpreter with what it read (fix brief 2, H6).
      if (chain!.some(([word = '']) => baseCommand(word) === 'xargs') && tokens.some(({ raw }) => STDIN_REDIRECTION.test(raw))) {
        fed.fromCommand = true
        continue
      }
      // A file on its input is the script only where the interpreter names none, or names `-`; past a script operand,
      // inline code, or a module, its input is data (fix brief 2, R7).
      const own = argumentsOf(program, form.slice(1))
      const inputIsScript = own.stdinScript || (own.operand === null && own.inline.length === 0 && own.modules.length === 0)
      for (let index = 0; index < tokens.length; index++) {
        const { raw, word: unquoted } = tokens[index]!
        const bare = BARE_REDIRECTION.test(raw)
        const prefix = STDIN_FILE.test(raw) ? /^0?<>?/ : /^0?<+/
        const target = bare ? tokens[index + 1] : { raw: raw.replace(prefix, ''), word: unquoted.replace(prefix, '') }
        if (HERE_STRING.test(raw)) {
          if (HERE_STRING_SHELLS.has(shell) && target !== undefined) fed.inline.push({ program, code: target.word })
        } else if (STDIN_HEREDOC.test(raw)) {
          const delimiter = bare ? target?.word : unquoted.replace(/^0?<<-?/, '')
          const bodies = delimiter === undefined ? null : heredocs.bodies(statement, { delimiter, tabs: raw.includes('<<-') })
          if (bodies === 'overBudget') fed.overBudget = true
          else if (bodies === null || tokens.filter(token => ANY_HEREDOC.test(token.raw)).length > 1) fed.unknown = true
          else fed.inline.push(...bodies.map(code => ({ program, code })))
        } else if ((STDIN_DUPLICATE.test(raw) || (STDIN_FILE.test(raw) && target === undefined)) && inputIsScript) {
          // A duplicated descriptor, or a redirection left with no target where the statement splits at its `&` (`<&3`).
          fed.unknown = true
        } else if (STDIN_FILE.test(raw) && target !== undefined && inputIsScript) {
          if (EXPANSION.test(target.raw)) fed.unknown = true
          else fed.scripts.push({ program, name: target.word })
        }
      }
    }
  }
  const kept = new Set<string>()
  fed.inline = fed.inline.filter((item) => {
    const key = `${item.program}\0${item.code}`
    return kept.has(key) ? false : (kept.add(key), true)
  })
  return fed
}

/**
 * The commands a statement runs, each wrapper's then the one it runs, with their words: its words without assignments
 * before them and without redirections or their targets, then through the wrappers command-forms reads (env, timeout,
 * nice, exec, command, nohup, stdbuf, xargs, and the rest), so `env python3 <<<` and `timeout 5 python3 <<<` end in
 * python3 (fix brief 1, item 9).
 */
function statementCommand(tokens: ReadonlyArray<{ raw: string; word: string }>): string[][] | null {
  const words: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const { raw, word } = tokens[index]!
    if (REDIRECTION.test(raw)) {
      if (BARE_REDIRECTION.test(raw)) index++
      continue
    }
    if (words.length === 0 && ASSIGNMENT.test(raw)) continue
    words.push(word)
  }
  const [command, ...args] = words
  if (command === undefined) return null
  const { chain } = commandFormsOf({ command, args })
  return chain.at(-1)?.[0] === undefined ? [words] : chain
}

/**
 * The heredoc bodies of one shell text (fix brief 2, R9), read in one pass: each statement's places in the text are found
 * once, and each body is read by walking lines from its own statement's line to its delimiter, every character walked
 * charged to the shared READ_BUDGET meter, so a text with many heredocs, or one left open, costs at most the budget and
 * then refuses (`overBudget`).
 */
function heredocIndex(text: string, meter: { characters: number }) {
  const places = new Map<string, number[]>()
  /** Every place a statement stands in the text, found once. */
  const placesOf = (statement: string): number[] | null => {
    const known = places.get(statement)
    if (known) return known
    const found: number[] = []
    let from = 0
    for (let at = text.indexOf(statement); at >= 0; at = text.indexOf(statement, at + 1)) {
      meter.characters -= at - from + 1
      from = at + 1
      if (meter.characters < 0) return null
      found.push(at)
    }
    meter.characters -= text.length - from
    places.set(statement, found)
    return meter.characters < 0 ? null : found
  }
  return {
    /**
     * The body of the heredoc a statement feeds its command, at every place the statement stands in the text: the lines
     * after the statement's own, up to its delimiter line (leading tabs dropped for `<<-`), or to the end of the text, as
     * a shell reads one left open. Null, so the code is unknown, where the statement is not found as written, has no line
     * after it, or follows another heredoc on its line, whose body would come first.
     */
    bodies(statement: string, heredoc: { delimiter: string; tabs: boolean }): string[] | null | 'overBudget' {
      const at = placesOf(statement)
      if (at === null) return 'overBudget'
      const bodies: string[] = []
      for (const place of at) {
        const lineStart = text.lastIndexOf('\n', place) + 1
        meter.characters -= place - lineStart
        if (ANY_HEREDOC_IN_TEXT.test(text.slice(lineStart, place))) return null
        const newline = text.indexOf('\n', place + statement.length)
        if (newline < 0) return null
        meter.characters -= newline - place
        const lines: string[] = []
        for (let start = newline + 1; ;) {
          const end = text.indexOf('\n', start)
          const raw = text.slice(start, end < 0 ? text.length : end)
          meter.characters -= raw.length + 1
          if (meter.characters < 0) return 'overBudget'
          const line = heredoc.tabs ? raw.replace(/^\t+/, '') : raw
          if (line === heredoc.delimiter) break
          lines.push(line)
          if (end < 0) break
          start = end + 1
        }
        bodies.push(lines.join('\n'))
      }
      return bodies.length === 0 ? null : bodies
    },
  }
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
/** The JavaScript runtimes, whose script operand must name a file; each finds it by its own rules (scriptEntry). */
const JS_RUNTIMES = new Set(['node', 'deno', 'bun', 'tsx', 'ts-node'])
/** The other interpreters whose first operand is their script, which must name a file, read by its exact name (fix brief 2, H8). */
const SCRIPT_INTERPRETERS = new Set(['perl', 'ruby', 'php', 'lua', 'luajit', 'tcsh', 'csh'])

/**
 * The options, by program, whose value is the next word, so it is no script operand (it is still read where it names a
 * file; a preload among them is found as the script is, PRELOAD_OPTIONS). One missing here makes its value the operand,
 * which then names nothing and asks; one too many skips a script that is still read by its exact name.
 */
const VALUE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  // node's value options are every String, StringList, Integer, UInteger, and HostPort option `node --help` lists under
  // Node 24 (probes/node-options.txt), less the ones left out so they fail closed (OPTIONS_REFUSED). A V8 option takes
  // its value only with `=`, so it is a flag here. `--env-file` is left out: F2 refuses it at the gate.
  node: ['--allow-fs-read', '--allow-fs-write', '--conditions', '--cpu-prof-dir', '--cpu-prof-interval', '--cpu-prof-name', '--debug-port', '--diagnostic-dir', '--disable-proto', '--disable-warning', '--dns-result-order', '--eval', '--experimental-loader', '--experimental-sea-config', '--experimental-test-isolation', '--experimental-test-tag-filter', '--heap-prof-dir', '--heap-prof-interval', '--heap-prof-name', '--heapsnapshot-near-heap-limit', '--heapsnapshot-signal', '--icu-data-dir', '--import', '--input-type', '--inspect-port', '--inspect-publish-uid', '--loader', '--localstorage-file', '--max-http-header-size', '--max-old-space-size-percentage', '--network-family-autoselection-attempt-timeout', '--redirect-warnings', '--report-dir', '--report-directory', '--report-filename', '--report-signal', '--require', '--secure-heap', '--secure-heap-min', '--security-revert', '--stack-trace-limit', '--test-concurrency', '--test-coverage-branches', '--test-coverage-exclude', '--test-coverage-functions', '--test-coverage-include', '--test-coverage-lines', '--test-isolation', '--test-name-pattern', '--test-random-seed', '--test-reporter-destination', '--test-rerun-failures', '--test-shard', '--test-skip-pattern', '--test-timeout', '--title', '--tls-cipher-list', '--tls-keylog', '--trace-event-categories', '--trace-event-file-pattern', '--trace-require-module', '--unhandled-rejections', '--use-largepages', '--v8-pool-size', '--watch-kill-signal', '--watch-path', '-C', '-r'],
  tsx: ['-r', '--require', '--import', '--loader', '-C', '--conditions', '--input-type', '--tsconfig'],
  'ts-node': ['-r', '--require', '-P', '--project', '-O', '--compiler-options', '-C', '--compiler', '--cwd', '-I', '--ignore'],
  bun: ['-r', '--preload', '--require', '--import', '--cwd', '-c', '--config', '--tsconfig-override', '--conditions', '--define', '-d', '--loader', '-l', '--filter', '-F', '--port', '--main-fields', '--extension-order', '--jsx-factory', '--jsx-fragment', '--jsx-import-source', '--jsx-runtime', '--elide-lines', '--shell', '--title', '--user-agent', '--console-depth', '--unhandled-rejections'],
  deno: ['-c', '--config', '--import-map', '--lock', '--location', '--seed', '--cert', '--ext'],
  python: ['-W', '-X', '--check-hash-based-pycs'],
  perl: ['-I', '-M', '-m'],
  ruby: ['-I', '-r', '-C', '-X', '-E', '--encoding'],
  php: ['-d', '-c', '-z', '-S', '-t'],
  lua: ['-l'],
  luajit: ['-l', '-j'],
}

/** The options of a program whose value is the next word (VALUE_OPTIONS), so a reader of its words skips that value. */
export function valueOptionsOf(program: string): readonly string[] {
  return VALUE_OPTIONS[program] ?? []
}

/**
 * The options, by program, that take no value: everything an interpreter documents that is neither a value option nor an
 * inline flag, so a word that is in none of these tables is one the reader does not model and the reading fails closed
 * (fix brief 3, R7). node's are every Boolean, NoOp, and V8 option `node --help` lists under Node 24, less the ones left
 * out so they refuse (OPTIONS_REFUSED); node also takes `--no-<boolean>` and underscores for dashes, handled below. The
 * tables for bun, deno, tsx, and ts-node, which are not installed here, are built from each one's published options and
 * stay deliberately narrow, so an option not listed refuses rather than hiding the script that runs. python's short
 * options cluster, so they are matched by shape (knownOption), not listed here.
 */
const FLAG_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  node: ['--abort-on-uncaught-exception', '--addons', '--allow-addons', '--allow-child-process', '--allow-inspector', '--allow-openssl-store', '--allow-wasi', '--allow-worker', '--async-context-frame', '--build-snapshot', '--check', '--completion-bash', '--cpu-prof', '--debug', '--debug-arraybuffer-allocations', '--debug-brk', '--deprecation', '--disable-sigusr1', '--disable-wasm-trap-handler', '--disallow-code-generation-from-strings', '--enable-etw-stack-walking', '--enable-fips', '--enable-source-maps', '--experimental-abortcontroller', '--experimental-addon-modules', '--experimental-detect-module', '--experimental-eventsource', '--experimental-fetch', '--experimental-global-customevent', '--experimental-global-navigator', '--experimental-global-webcrypto', '--experimental-import-meta-resolve', '--experimental-import-text', '--experimental-inspector-network-resource', '--experimental-json-modules', '--experimental-modules', '--experimental-network-inspection', '--experimental-print-required-tla', '--experimental-quic', '--experimental-repl-await', '--experimental-report', '--experimental-require-module', '--experimental-shadow-realm', '--experimental-specifier-resolution', '--experimental-sqlite', '--experimental-storage-inspection', '--experimental-stream-iter', '--experimental-test-coverage', '--experimental-test-module-mocks', '--experimental-test-snapshots', '--experimental-top-level-await', '--experimental-transform-types', '--experimental-vm-modules', '--experimental-wasi-unstable-preview1', '--experimental-wasm-modules', '--experimental-websocket', '--experimental-webstorage', '--experimental-worker', '--experimental-worker-inspection', '--expose-gc', '--expose-internals', '--extra-info-on-fatal-exception', '--force-async-hooks-checks', '--force-context-aware', '--force-fips', '--force-node-api-uncaught-exceptions-policy', '--frozen-intrinsics', '--global-search-paths', '--harmony-shadow-realm', '--heap-prof', '--help', '--http-parser', '--insecure-http-parser', '--inspect', '--inspect-brk', '--inspect-brk-node', '--inspect-wait', '--interactive', '--interpreted-frames-native-stack', '--jitless', '--max-heap-size', '--max-old-space-size', '--max-semi-space-size', '--napi-modules', '--network-family-autoselection', '--node-memory-debug', '--node-snapshot', '--openssl-legacy-provider', '--openssl-shared-config', '--pending-deprecation', '--perf-basic-prof', '--perf-basic-prof-only-functions', '--perf-prof', '--perf-prof-unwinding-info', '--permission', '--permission-audit', '--preserve-symlinks-main', '--print', '--prof', '--report-compact', '--report-exclude-env', '--report-exclude-network', '--report-on-fatalerror', '--report-on-signal', '--report-uncaught-exception', '--require-module', '--strip-types', '--test-force-exit', '--test-only', '--test-randomize', '--test-udp-no-try-send', '--test-update-snapshots', '--throw-deprecation', '--tls-max-v1.2', '--tls-max-v1.3', '--tls-min-v1.0', '--tls-min-v1.1', '--tls-min-v1.2', '--tls-min-v1.3', '--trace-deprecation', '--trace-env', '--trace-env-js-stack', '--trace-env-native-stack', '--trace-exit', '--trace-promises', '--trace-sigint', '--trace-sync-io', '--trace-tls', '--trace-uncaught', '--trace-warnings', '--track-heap-objects', '--use-bundled-ca', '--use-env-proxy', '--use-openssl-ca', '--use-system-ca', '--v8-options', '--verify-base-objects', '--version', '--warnings', '--watch', '--watch-preserve-output', '--zero-fill-buffers', '-c', '-h', '-i', '-v'],
  perl: ['-a', '-c', '-C', '-l', '-n', '-p', '-s', '-t', '-T', '-u', '-U', '-v', '-V', '-w', '-W', '-0', '-g', '-G'],
  ruby: ['-a', '-c', '-d', '--debug', '-l', '-n', '-p', '-s', '-U', '-v', '-w', '-W', '-h', '--version', '--verbose', '--copyright', '--jit', '--yjit', '--frozen-string-literal', '--help'],
  php: ['-a', '-e', '-h', '-l', '-n', '-q', '-s', '-v', '-w', '--version', '--interactive', '--no-php-ini', '--syntax-check'],
  lua: ['-i', '-v', '-E', '-W'],
  bun: ['--bun', '--smol', '--watch', '--hot', '--no-clear-screen', '--no-install', '--prefer-offline', '--prefer-latest', '--no-summary', '--silent', '--version', '-v', '--help', '-h', '-b', '--no-macros', '--no-addons'],
  deno: ['-A', '--allow-all', '--allow-read', '--allow-write', '--allow-net', '--allow-env', '--allow-run', '--allow-ffi', '--allow-sys', '--allow-hrtime', '--allow-import', '--allow-scripts', '--deny-read', '--deny-write', '--deny-net', '--deny-env', '--deny-run', '--deny-ffi', '--deny-sys', '-W', '-R', '-N', '-E', '-S', '-I', '--no-check', '--no-npm', '--no-remote', '--no-config', '--no-lock', '--no-prompt', '--cached-only', '--reload', '-r', '--watch', '--watch-hmr', '--unstable', '--inspect', '--inspect-brk', '--inspect-wait', '--quiet', '-q', '--frozen', '--version', '-V', '--help', '-h'],
  tsx: ['--watch', '--no-cache', '--cjs-interop', '--no-warnings', '--version', '-v', '--help', '-h'],
  'ts-node': ['-T', '--transpile-only', '--type-check', '-H', '--compiler-host', '--esm', '--files', '--pretty', '--skip-project', '--skip-ignore', '--emit', '--log-error', '--show-config', '--scope', '--version', '-v', '--help', '-h'],
}

/** The interpreters whose options the reader models, so an unmodelled one refuses; a runner's package options are not checked here. */
const OPTION_CHECKED = new Set(['node', 'python', 'perl', 'ruby', 'php', 'lua', 'bun', 'deno', 'tsx', 'ts-node'])
/** A word that marks an interpreter's script as coming from its standard input, so the redirected file is the script (fix brief 3, R7). */
const STDIN_SCRIPT_MARKER = new Set(['-', '/dev/stdin'])
/** Python's short options that take no value, so a cluster of only these is a known flag; a value letter (W, X) or code letter (c, m) in a cluster fails closed. */
const PYTHON_FLAG_CLUSTER = /^-[bBdEhiIOPqRsSuvVx]+$/

/**
 * Whether an interpreter option is one the reader models (fix brief 3, R7): an inline flag, a value option, a preload,
 * or a flag the interpreter documents. node also takes `--no-<boolean>` and underscores for dashes; python's short
 * options cluster, so an all-flag cluster is known and a cluster carrying a value or code letter is not. A `--opt=value`
 * long option is self-contained, so it is matched by the part before `=`. Anything else is unknown, and the reading
 * fails closed rather than guess which word is the script.
 */
function knownOption(program: string, word: string): boolean {
  if (program === 'python') {
    if (word === '-W' || word === '-X') return true
    if (PYTHON_FLAG_CLUSTER.test(word)) return true
    const head = word.split('=')[0]!
    return head === '--help' || head === '--version' || head === '--check-hash-based-pycs'
  }
  let core = word.startsWith('--') ? word.split('=')[0]! : word
  if (program === 'node') core = core.replace(/_/g, '-')
  if (program === 'node' && core.startsWith('--no-')) return FLAG_OPTIONS.node!.includes(`--${core.slice(5)}`)
  const inline = INLINE_FLAGS[program] ?? []
  const preloading = PRELOAD_OPTIONS[program] ?? []
  const values = VALUE_OPTIONS[program] ?? []
  const flags = FLAG_OPTIONS[program] ?? []
  return inline.includes(core) || preloading.includes(core) || values.includes(core) || flags.includes(core)
}

/**
 * The options, by program, whose value is code that runs before the script: a module node, tsx, or ts-node requires or
 * imports first, or one bun preloads (fix brief 2, H7). Each is found as the script is, or named as a package.
 */
const PRELOAD_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  node: ['-r', '--require', '--import', '--loader', '--experimental-loader'],
  tsx: ['-r', '--require', '--import', '--loader', '--experimental-loader'],
  'ts-node': ['-r', '--require', '--import', '--loader', '--experimental-loader'],
  bun: ['-r', '--preload', '--require', '--import'],
}
/** A preload a URL names (`data:`, `file:`, `http:`), whose code no file in the view holds. */
const URL_SPECIFIER = /^(?:data|file|https?):/i

/**
 * A runtime's subcommands: after one of `script` the next operand is the script (`deno run main.ts`, `bun run build.ts`,
 * `tsx watch app.ts`); after one of `other` no operand is a script the reader must find (`bun test`, `deno fmt`).
 */
const SUBCOMMANDS: Readonly<Record<string, { script: readonly string[]; other: readonly string[] }>> = {
  deno: { script: ['run', 'serve'], other: ['test', 'bench', 'compile', 'check', 'task', 'fmt', 'lint', 'repl', 'info', 'doc', 'upgrade', 'cache', 'types', 'completions', 'coverage', 'init', 'jupyter', 'publish', 'add', 'remove', 'install', 'uninstall', 'outdated', 'clean', 'x', 'vendor', 'bundle', 'lsp', 'help'] },
  bun: { script: ['run'], other: ['test', 'x', 'install', 'i', 'add', 'a', 'remove', 'rm', 'update', 'outdated', 'link', 'unlink', 'pm', 'build', 'init', 'create', 'c', 'upgrade', 'repl', 'exec', 'patch', 'publish', 'audit', 'info', 'why', 'help'] },
  tsx: { script: ['watch'], other: [] },
  node: { script: ['inspect'], other: [] },
}

/**
 * The first positional word an interpreter takes as its script; `required` where naming nothing leaves the code unknown,
 * and `runtime` the program whose rules find it: the interpreter's own, or for a runner the package it runs.
 */
interface Operand { name: string; required: boolean; runtime: string }

/**
 * One interpreter invocation's words, read for the code they hand it: the code after an inline flag (and an awk
 * program, and `deno eval`'s text), the package a runner runs, which is named and never read, and every other word,
 * each a name that may be a file.
 */
function argumentsOf(program: string, args: readonly string[]): { inline: string[]; packages: string[]; modules: string[]; preloads: string[]; programFiles: string[]; candidates: string[]; operand: Operand | null; stdinScript: boolean; unknownOption: boolean } {
  const inline: string[] = []
  const preloads: string[] = []
  // Whether the interpreter's script comes from its standard input (a `-`, `/dev/stdin`, php `--`, or csh/tcsh `-s`),
  // and whether a word is an option the reader does not model, so the reading fails closed (fix brief 3, R7).
  let stdinScript = false
  let unknownOption = false
  // The program files awk runs (`-f prog.awk`), each of which must name a file.
  const programFiles: string[] = []
  const packages: string[] = []
  const modules: string[] = []
  const candidates: string[] = []
  const flags = INLINE_FLAGS[program] ?? []
  const awkProgramFile = AWKS.has(program) && args.some(arg => arg === '-f' || arg.startsWith('-f'))
  let awkProgram = AWKS.has(program) && !awkProgramFile
  let runnerPackage = RUNNERS.has(program)
  // The script operand: for a runtime, its first positional word, or the word after a `--` that comes before one (fix
  // brief 2, H5), past a subcommand naming one; for a runner, the word after the package, which must name a file only
  // where that package is itself a runtime.
  let seeking = JS_RUNTIMES.has(program) || program === 'python' || SCRIPT_INTERPRETERS.has(program)
  let subcommand = false
  let operand: Operand | null = null
  const valueOptions = VALUE_OPTIONS[program] ?? []
  const preloading = PRELOAD_OPTIONS[program] ?? []
  const operandOf = (name: string): Operand => {
    const runtime = RUNNERS.has(program) ? programOf(packages[0] ?? '') : program
    return { name, required: !RUNNERS.has(program) || JS_RUNTIMES.has(runtime), runtime }
  }
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
    if (AWKS.has(program) && (word === '-f' || word === '--file') && index + 1 < args.length) {
      programFiles.push(args[++index]!)
      continue
    }
    if (AWKS.has(program) && (/^-f./.test(word) || word.startsWith('--file='))) {
      programFiles.push(word.startsWith('--') ? word.slice('--file='.length) : word.slice(2))
      continue
    }
    // php -f names its script as an option's value.
    if (program === 'php' && seeking && word === '-f' && index + 1 < args.length) {
      operand = operandOf(args[++index]!)
      seeking = false
      continue
    }
    if (program === 'deno' && word === 'eval' && index + 1 < args.length) {
      inline.push(args[++index]!)
      continue
    }
    // The script comes from standard input, so the redirected file is the script and the words after here are its
    // arguments, never candidates (fix brief 3, R7): a lone `-` or `/dev/stdin` for any seeking interpreter, php's `--`,
    // or csh/tcsh `-s`.
    if (seeking && (STDIN_SCRIPT_MARKER.has(word) || (program === 'php' && word === '--') || ((program === 'csh' || program === 'tcsh') && word === '-s'))) {
      stdinScript = true
      seeking = false
      break
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
      seeking = true
      continue
    }
    if (word === '--') {
      // node and python take the word after a leading `--` as their script, as a runtime does after its package.
      if (seeking && index + 1 < args.length) {
        const next = args[++index]!
        operand = operandOf(next)
        candidates.push(word, next)
        seeking = false
        continue
      }
      seeking = false
    }
    if (seeking) {
      // A preload runs before the script, so it is found as the entry is (fix brief 2, H7).
      if (preloading.includes(word) && index + 1 < args.length) {
        preloads.push(args[++index]!)
        continue
      }
      if (equals > 0 && preloading.includes(word.slice(0, equals))) {
        preloads.push(word.slice(equals + 1))
        continue
      }
      if (valueOptions.includes(word) && index + 1 < args.length) {
        candidates.push(word, args[++index]!)
        continue
      }
      if (positional) {
        const named = SUBCOMMANDS[program]
        if (!subcommand && named?.script.includes(word)) subcommand = true
        else if (!subcommand && named?.other.includes(word)) seeking = false
        else {
          operand = operandOf(word)
          seeking = false
        }
      }
    }
    // While seeking the script, an option in none of the interpreter's tables could take the next word as its value and
    // hide the script that runs, so the reading fails closed (fix brief 3, R7). A runner's package options are not checked.
    if (seeking && word.startsWith('-') && word !== '-' && word !== '--' && OPTION_CHECKED.has(program) && !knownOption(program, word)) unknownOption = true
    candidates.push(word)
    if (equals > 0) candidates.push(word.slice(equals + 1))
  }
  return { inline, packages, modules, preloads, programFiles, candidates, operand, stdinScript, unknownOption }
}

/**
 * Where an interpreter finds its script (fix brief 1, item 7; fix brief 2, H1 and H8), by the rules of the runtime that
 * runs it (`runtime`, the package for a runner): node's own (nodeEntry), Python's (the name, then a folder's
 * `__main__.py`), the exact name for perl, ruby, php, lua, the C shells, and awk, or the TypeScript runners'
 * (typeScriptEntry). `unreadable` where a folder's manifest is one the agent may not read.
 */
function scriptEntry(runtime: string, name: string, base: string, view: CodeView): Located | 'unreadable' {
  if (runtime === 'python') return firstLocated(view, [name, `${name}/__main__.py`], base)
  if (runtime === 'node') return nodeEntry(name, base, view)
  // perl, ruby, php, lua, the C shells, and awk try no extension and no folder: the name as written.
  if (SCRIPT_INTERPRETERS.has(runtime) || AWKS.has(runtime)) return firstLocated(view, [name], base)
  return typeScriptEntry(name, base, view)
}

/** The extensions node's CommonJS loader tries, in its order (`require.extensions`); a `.node` addon is no text, so it refuses. */
const NODE_EXTENSIONS = ['.js', '.json', '.node']

/**
 * The file node runs for `node <name>`, in node 24's own order (Module._findPath and tryPackage): the name as a file,
 * then with `.js`, `.json`, `.node`; for a folder, its package.json `main` resolved as a path (an absolute one as written,
 * so one outside every place the agent's view reaches refuses), as a file, with each extension, then as a folder's
 * index file; and where `main` names nothing, or there is none, the folder's own index file. No ESM or TypeScript
 * sibling is tried, as node tries none: `main: "start"` beside start.mjs runs index.js.
 */
function nodeEntry(name: string, base: string, view: CodeView): Located | 'unreadable' {
  const withExtensions = (path: string) => [path, ...NODE_EXTENSIONS.map(extension => `${path}${extension}`)]
  const indexes = (folder: string) => NODE_EXTENSIONS.map(extension => `${folder}/index${extension}`)
  const direct = firstLocated(view, withExtensions(name), base)
  if (direct !== 'none') return direct
  const main = packageMain(name, base, view)
  if (main === 'unreadable') return main
  if (main !== null) {
    const path = main.startsWith('/') ? main : join(name, main)
    const entry = firstLocated(view, [...withExtensions(path), ...indexes(path)], base)
    if (entry !== 'none') return entry
  }
  return firstLocated(view, indexes(name), base)
}

/**
 * The file a TypeScript runner (tsx, ts-node, bun, deno, or a runner's package that is none of node or python) runs for
 * a name: the name, then with each JavaScript and TypeScript extension and the `.ts` behind a `.js`, then a folder's
 * package.json `main` the same way, then its index file. These runners resolve more widely than node does, so the
 * reader tries the wider list.
 */
function typeScriptEntry(name: string, base: string, view: CodeView): Located | 'unreadable' {
  const candidates = jsCandidates(name)
  const indexes = candidates.slice(-JS_EXTENSIONS.length)
  const direct = firstLocated(view, candidates.slice(0, -JS_EXTENSIONS.length), base)
  if (direct !== 'none') return direct
  const main = packageMain(name, base, view)
  if (main === 'unreadable') return main
  if (main !== null) {
    const entry = firstLocated(view, jsCandidates(main.startsWith('/') ? main : join(name, main)), base)
    if (entry !== 'none') return entry
  }
  return firstLocated(view, indexes, base)
}

/** The first name that lands on a regular file; `outside` where none does and one lands beyond the agent's view. */
function firstLocated(view: CodeView, names: readonly string[], base: string): Located {
  const located = names.map(name => view.locate(name, base))
  return located.find(item => typeof item === 'object') ?? (located.includes('outside') ? 'outside' : 'none')
}

/**
 * The file a preload names (fix brief 2, H7): a relative or absolute path, found as the runtime finds its script; a bare
 * specifier is a package, named by its package (`dotenv/config` is dotenv) and never read. A refusal where a path names
 * nothing, lands beyond the agent's view, or a URL names the code.
 */
function preloadOf(runtime: string, specifier: string, place: { cwd: string; view: CodeView; packages: Packages }): { real: string } | null | string {
  if (URL_SPECIFIER.test(specifier)) return CODE_REFUSALS.notFound
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    named(place.packages, packageName(specifier), place.cwd)
    return null
  }
  const entry = scriptEntry(runtime, specifier, place.cwd, place.view)
  if (entry === 'outside' || entry === 'unreadable') return CODE_REFUSALS.unreadable
  return entry === 'none' ? CODE_REFUSALS.notFound : entry
}

/** A folder's package.json `main`, or null where it has no manifest or the manifest names none. */
function packageMain(folder: string, base: string, view: CodeView): string | null | 'unreadable' {
  const located = view.locate(join(folder, 'package.json'), base)
  if (typeof located !== 'object') return null
  if (!view.readable(located.real)) return 'unreadable'
  const buffer = view.read(located.real, MANIFEST_LIMIT)
  if (buffer === null) return 'unreadable'
  try {
    const main = (JSON.parse(buffer.toString('utf8')) as { main?: unknown }).main
    return typeof main === 'string' && main !== '' ? main : null
  } catch {
    return null
  }
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
type Packages = Map<string, Set<string | null>>

/** A package imported, kept with each folder an importer reads it from; null where no version is looked up (Python). */
function named(packages: Packages, name: string, from: string | null): void {
  const folders = packages.get(name) ?? new Set<string | null>()
  folders.add(from)
  packages.set(name, folders)
}

/** An npm package name, scoped or not: anything else (a `node:` builtin, a stray word) has no node_modules folder. */
const NPM_NAME = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/i
const VERSION = /^[\w.+-]{1,64}$/
/** What of a package.json is read for its version at most. */
const MANIFEST_LIMIT = 64 * 1_024

/**
 * Each package once per version its importers get (fix brief 1, item 10), sorted by name and then version, so a nested
 * copy of another version is shown, looked up at Socket, and part of the cache key too; no Socket summary yet.
 */
function installed(packages: Packages, view: CodeView): JudgePackage[] {
  const entries = [...packages].flatMap(([name, folders]) => [...new Set([...folders].map(from => (from === null ? null : installedVersion(name, from, view))))].map(version => ({ name, version, socket: null })))
  const order = (item: JudgePackage) => `${item.name}\0${item.version ?? ''}`
  return entries.sort((one, other) => (order(one) < order(other) ? -1 : order(one) > order(other) ? 1 : 0))
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
/** Where an import is resolved from: its file (null for inline code), the working directory, the view, the packages met, and the runtime whose rules resolve it. */
interface Place { file: string | null; cwd: string; view: CodeView; packages: Packages; runtime?: string }

function importsOf(language: Language, code: string, place: Place): Found | string {
  if (language === 'js') return jsImports(code, place)
  if (language === 'python') return pythonImports(code, place)
  if (language === 'shell') return shellSources(code, place)
  return []
}

/** The ES module statements: `import`, `export from`, and `import()`, which node resolves by the exact name. */
const JS_MODULE_SPECIFIERS = [
  /\bimport\s+(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"\n]+)['"]/g,
  /\bexport\s+[\w*{}\s,$]+?\s+from\s+['"]([^'"\n]+)['"]/g,
  /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
]
/** CommonJS `require()`, which node resolves with its extensions, a folder's main, and its index files. */
const JS_REQUIRE_SPECIFIER = /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g
const JS_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.json']
/** A TypeScript project imports `./a.js` for the `./a.ts` it compiles to it. */
const TS_SOURCES: Readonly<Record<string, readonly string[]>> = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }

/**
 * The local files one piece of JavaScript imports (fix brief 3, F1). Under node the statement decides the rules, as node's
 * own loaders do, whatever the file's package.json `type` says: `import`, `export from`, and `import()` name a file
 * exactly, with no extension, index, or folder tried (ERR_UNSUPPORTED_DIR_IMPORT), so a name that is no file refuses;
 * `require()` follows node's CommonJS order (nodeEntry): the name, `.js`, `.json`, `.node`, a folder's main, then its
 * index. tsx, ts-node, bun, and deno resolve more widely, so they keep the wider list (jsCandidates). A file node never
 * loads, such as a `lib.mjs` beside the `lib/` a require runs, is never shown in place of the one it runs.
 */
function jsImports(code: string, place: Place): Found | string {
  const found: Found = []
  const base = place.file === null ? place.cwd : dirname(place.file)
  const node = place.runtime === 'node'
  const statements: Array<{ pattern: RegExp; resolve: (specifier: string) => Located | 'unreadable' }> = [
    ...JS_MODULE_SPECIFIERS.map(pattern => ({ pattern, resolve: (specifier: string) => (node ? place.view.locate(specifier, base) : firstLocated(place.view, jsCandidates(specifier), base)) })),
    { pattern: JS_REQUIRE_SPECIFIER, resolve: (specifier: string) => (node ? nodeEntry(specifier, base, place.view) : firstLocated(place.view, jsCandidates(specifier), base)) },
  ]
  for (const { pattern, resolve } of statements) {
    for (const [, specifier = ''] of code.matchAll(pattern)) {
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
        named(place.packages, packageName(specifier), base)
        continue
      }
      const file = resolve(specifier)
      if (typeof file === 'object') found.push({ real: file.real, language: null })
      else return file === 'none' ? CODE_REFUSALS.missing : CODE_REFUSALS.unreadable
    }
  }
  return found
}

function jsCandidates(specifier: string): string[] {
  const extension = /\.[cm]?js$/.exec(specifier)?.[0]
  const swapped = extension ? (TS_SOURCES[extension] ?? []).map(source => specifier.slice(0, -extension.length) + source) : []
  return [specifier, ...swapped, ...JS_EXTENSIONS.map(ext => `${specifier}${ext}`), ...JS_EXTENSIONS.map(ext => `${specifier}/index${ext}`)]
}

// A statement starts a line, or follows `;` or a compound statement's `:` (`import os; import helper`, `try: import x`);
// a from-import's names may sit in parentheses across lines, comments among them (groupedNames). A `;` or `:` inside a
// string can read as one too, which fails closed: the name becomes a package, or a relative import names nothing and refuses.
const PYTHON_IMPORT = /(?:^|[;:])[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm
const PYTHON_FROM = /(?:^|[;:])[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\()?([\w\t ,*]*)/gm
/** The most lines a parenthesised from-import's names are read across. */
const GROUP_LINES = 60
/** A line that starts another statement or a string, so an open `(` before it was no from-import's (a docstring's, a comment's). */
const GROUP_BREAK = /^[ \t]*(?:from |import |def |class |"""|\'\'\')/

/**
 * The names of a parenthesised from-import, from just after its `(` to the first `)` outside a comment (fix brief 2,
 * R8): at most GROUP_LINES lines, and null, so the import reads as its first line alone, where none closes it in time or
 * a line inside starts another statement or a string. So an unclosed `(` in a docstring or a comment never swallows the
 * real imports after it.
 */
function groupedNames(code: string, from: number): string | null {
  const parts: string[] = []
  let at = from
  for (let line = 0; line < GROUP_LINES; line++) {
    const end = code.indexOf('\n', at)
    const text = code.slice(at, end < 0 ? code.length : end).replace(/#.*/, '')
    if (line > 0 && GROUP_BREAK.test(text)) return null
    const close = text.indexOf(')')
    if (close >= 0) return [...parts, text.slice(0, close)].join(',')
    parts.push(text)
    if (end < 0) return null
    at = end + 1
  }
  return null
}

function pythonImports(code: string, place: Place): Found | string {
  const found: Found = []
  const beside = place.file === null ? place.cwd : dirname(place.file)
  for (const [, list = ''] of code.matchAll(PYTHON_IMPORT)) {
    for (const module of list.split(',').map(item => item.trim().split(/\s+/)[0]!).filter(Boolean)) {
      const files = pythonModule({ module, roots: [beside, place.cwd], view: place.view })
      if (files.length === 0) named(place.packages, module.split('.')[0]!, null)
      found.push(...files)
    }
  }
  for (const match of code.matchAll(PYTHON_FROM)) {
    const [whole, dots = '', module = '', open, plain = ''] = match
    const grouped = open ? groupedNames(code, match.index + whole.length - plain.length) : null
    const imported = (grouped ?? plain).split(',').map(name => name.trim().split(/\s+/)[0]!).filter(name => name && name !== '*')
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
 * import; with `main`, as `python -m` runs it, a package's `__main__.py` too, and a namespace package's, a folder with
 * no `__init__.py` (fix brief 2, H5).
 */
function pythonModule(input: { module: string; roots: readonly string[]; view: CodeView; main?: boolean }): Found {
  const parts = input.module.split('.').filter(Boolean)
  for (const root of input.roots) {
    const path = join(...parts)
    const module = fileAt(input.view, `./${path}.py`, root) ?? fileAt(input.view, `./${path}/__init__.py`, root)
    const namespaceMain = !module && input.main ? fileAt(input.view, `./${path}/__main__.py`, root) : null
    if (!module && !namespaceMain) continue
    const packages = parts.slice(0, -1).flatMap((_, index) => {
      const init = fileAt(input.view, `./${join(...parts.slice(0, index + 1))}/__init__.py`, root)
      return init ? [init] : []
    })
    const main = namespaceMain ?? (input.main && module!.endsWith('__init__.py') ? fileAt(input.view, `./${path}/__main__.py`, root) : null)
    return [...packages, ...(module ? [module] : []), ...(main ? [main] : [])].map(real => ({ real, language: 'python' as const }))
  }
  return []
}

const SHELL_SOURCE = /(?:^|[\n;&|(]|\bthen|\bdo|\belse)[ \t]*(?:source|\.)[ \t]+(['"]?)([^\s'";&|)]+)\1/g

function shellSources(code: string, place: Place): Found | string {
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
