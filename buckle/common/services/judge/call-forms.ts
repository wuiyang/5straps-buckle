import { baseCommand, SHELL_COMMANDS, shellScriptOperand, shellStatementList, shellTokens, type ShellToken } from '../../domain/argv.js'
import { allForms, type CommandForms, isRedirection, READ_BUDGET, redirectionReadings, takesNextWord } from '../../domain/command-forms.js'

/** Why a call whose working directory changes before its code runs is not rated (fix brief 2, H2). */
export const CHANGES_DIRECTORY = 'the call changes its working directory before the code runs'

/** Why a call whose runtime loads variables from a file is not rated (fix brief 3, F2). */
export const LOADS_ENV_FILE = 'the call loads variables from a file; the decision AI does not rate it'

/** The runtimes that load variables from a file before the code runs, and the runners that start them. */
const ENV_FILE_RUNTIMES = /^(?:node|nodejs|tsx|bun|bunx|deno|npx|pnpx)(?:[\d.-]|$)/
/** The options that name such a file: node's and tsx's, and bun's and deno's `--env` too. */
const ENV_FILE_OPTIONS = ['--env-file', '--env-file-if-exists']

/**
 * Whether a running node, tsx, bun, or deno form, or a runner starting one, loads variables from a file (fix brief 3,
 * F2): `--env-file` or `--env-file-if-exists` (and `--env` for bun and deno) in either spelling, underscores read as
 * dashes as node reads them. The file may set NODE_OPTIONS or another variable that changes what code runs, which the
 * reader does not follow, so no stage rates the call. Read in every word before a `--`, which fails closed for a word
 * that is the script's own argument.
 */
export function loadsEnvFile(forms: CommandForms): boolean {
  return allForms(forms).some((form) => {
    const program = baseCommand(form[0] ?? '')
    if (!ENV_FILE_RUNTIMES.test(program)) return false
    const options = program.startsWith('bun') || program.startsWith('deno') ? [...ENV_FILE_OPTIONS, '--env'] : ENV_FILE_OPTIONS
    const end = form.indexOf('--')
    return form.slice(1, end < 0 ? form.length : end).some(word => options.includes(word.split('=')[0]!.replace(/_/g, '-')))
  })
}

/** Why a call that sets an npm option changing what code runs is not rated (fix brief 9, B33). */
export const NPM_CODE_OPTION = 'the call sets an npm option that changes what code runs; the decision AI does not rate it'

/**
 * npm's options that load code no stage sees: `--node-options` reaches node as NODE_OPTIONS, `--script-shell` names the
 * shell a script runs in, and `--userconfig` and `--globalconfig` name a config file that may set either (npm 11.19.0 ran
 * a planted preload or shell for each), as the `npm_config_*` variables of the same names do, which are refused too.
 */
const NPM_CODE_OPTIONS = ['--node-options', '--script-shell', '--userconfig', '--globalconfig']

/**
 * Whether an npm form sets one of NPM_CODE_OPTIONS before a `--` (fix brief 9, B33), read as npm reads an option
 * (selectsOption): bare or with `=value`, or by a prefix of three or more letters (`--node-opt=`, `--userconf=`). pnpm,
 * yarn, bun, and npx read none of these as npm does, so their forms are left alone.
 */
export function setsNpmCodeOption(forms: CommandForms): boolean {
  return allForms(forms).some((form) => {
    if (baseCommand(form[0] ?? '') !== 'npm') return false
    const end = form.indexOf('--')
    return form.slice(1, end < 0 ? form.length : end).some(word => NPM_CODE_OPTIONS.some(option => selectsOption(word, option)))
  })
}

/**
 * The shell builtins that change the working directory of every statement after them: `cd`, `pushd`, and `popd`, and
 * `chdir`, which dash, zsh, mksh, busybox ash, and tcsh take as `cd`, and fish's `prevd`, `nextd`, and `cdh` (fix brief
 * 4, G10).
 */
const DIRECTORY_COMMANDS = new Set(['cd', 'chdir', 'pushd', 'popd', 'prevd', 'nextd', 'cdh'])

/**
 * The options, by program, that run a command or a script from another folder: env's and sudo's (read among the
 * wrapper's own words alone, so an option of the command after them is not one), those of the runtimes and package
 * managers that take a folder to run in, and the words that select another workspace package, whose script then runs in
 * that package's folder while the working directory's package.json names another: npm's `-w`, `--workspace`,
 * `--workspaces`, `-ws`, `--ws`, and `--include-workspace-root` (npm 11.19.0 ran the selected package's script for each,
 * bare or as `=value`), and bun's `--filter` and `-F` (fix brief 8, B23). Each is read anywhere before a `--` as npm's
 * option parser reads it (selectsOption): bare, with `=value`, under any number of leading dashes, a long one by any prefix
 * of three or more letters, a short one by its letter's prefix, in a cluster of letters, or after `--` (`--C`, `-qw`), which
 * fails closed for a script's own argument (fix brief 9, B32; D91 follow-up F2). ruby's `-x[directory]` switches to the directory
 * before the script, as `-C` does (ruby(1); ruby is not installed here, so the manual is the only evidence). The workspace options of npx
 * and the selectors of pnpm are read apart, by position (selectsBeforeProgram).
 */
const WRAPPER_CHDIR: Readonly<Record<string, string>> = { env: 'C', sudo: 'D' }
/** npm's `--include-workspace-root`, and its shorthand `iwr` with the abbreviations of that (`iw`, `i`) nopt takes for it (npm 11.19.0). */
const NPM_INCLUDE_ROOT = ['--include-workspace-root', '--iwr', '--iw', '--i']
const PROGRAM_CHDIR: Readonly<Record<string, readonly string[]>> = {
  bun: ['--cwd', '--filter', '-F'], 'ts-node': ['--cwd'], ruby: ['-C', '-X', '-x'],
  npx: ['-C', '--prefix', '--dir', '--cwd'], pnpx: ['-C', '--prefix', '--dir', '--cwd'], bunx: ['-C', '--prefix', '--dir', '--cwd'],
  npm: ['-C', '--prefix', '--dir', '--cwd', '-w', '--workspace', '--workspaces', '--ws', ...NPM_INCLUDE_ROOT], pnpm: ['-C', '--prefix', '--dir', '--cwd'], yarn: ['-C', '--prefix', '--dir', '--cwd'],
}

/**
 * Whether a call moves to another folder before its code runs (fix brief 2, H2), so the code read at the call's own
 * working directory may not be the code that runs: a builtin of DIRECTORY_COMMANDS anywhere in it, `env -C` or `--chdir`,
 * `sudo -D` or `--chdir`, `bun --cwd`, a runner's or package manager's `-C`, `--prefix`, `--dir`, or `--cwd`, or a word
 * selecting another workspace package, npm's `-w` and bun's `--filter` among them (fix brief 8, B23).
 */
export function changesDirectory(forms: CommandForms): boolean {
  const all = allForms(forms)
  return all.some((form, index) => {
    const program = baseCommand(form[0] ?? '')
    if (DIRECTORY_COMMANDS.has(program)) return true
    const short = WRAPPER_CHDIR[program]
    if (short !== undefined) return wrapperWords(all, index).some(word => namesOption(word, short, 'chdir'))
    const options = PROGRAM_CHDIR[program]
    if (options === undefined) return false
    const end = form.indexOf('--')
    const words = form.slice(1, end < 0 ? form.length : end)
    return words.some(word => options.some(option => selectsOption(word, option))) || selectsPackage(program, words)
  })
}

/**
 * npm's workspace options, which npx reads as npm does (npm 11.19.0, probed in a scratch workspace of packages a and b with a
 * local command printing its folder): `-w`, `--workspace`, `--workspaces`, `--ws`, and `--include-workspace-root` typed before the
 * command ran it in a, or once in each package, with no warning.
 */
const NPX_SELECTORS = ['-w', '--workspace', '--workspaces', '--ws', ...NPM_INCLUDE_ROOT]
/**
 * pnpm's options that run another package's script, or every package's, or the workspace root's (pnpm 10.33.2, probed in the
 * same way): `--filter` and `-F`, `--filter-prod`, `--recursive` and `-r`, `--parallel`, which implies a recursive run, and
 * `--workspace-root` and `-w`, which runs the root's script from inside a package.
 */
const PNPM_SELECTORS = ['--filter', '-F', '--filter-prod', '--recursive', '-r', '--parallel', '--workspace-root', '-w']
/** `--config.<key>=value`, which sets any pnpm option from the command line (`--config.dir=sub`, `--config.filter=a`), under any dashes. */
const PNPM_CONFIG_KEY = /^-+(?:no-)*config\./i
/** pnpm's commands that run a script or a program: options up to its name, then every word after it is its own. */
const PNPM_RUNNERS: ReadonlySet<string> = new Set(['run', 'run-script', 'exec'])
/** The script names that pnpm runs as `pnpm <name>`, and the commands that run one: every word after the first is the script's own. */
const PNPM_SCRIPT_WORDS: ReadonlySet<string> = new Set(['dev', 'build', 'test', 't', 'tst', 'start', 'stop', 'restart'])

/**
 * Whether an npx or pnpm form selects another package before its script or program runs (D91 follow-ups; standalone round 2),
 * as the program's own parser reads it. Both hand every word after the command (npx) or the script name (pnpm run) to it as its
 * own argument (`npx tsc -w` runs tsc's watch mode, `pnpm run build --filter a` runs the root's script with `--filter a`),
 * so a selector counts only before it. Any other pnpm command reads every word as its own option (`pnpm install --filter a`).
 */
function selectsPackage(program: string, words: readonly string[]): boolean {
  if (program === 'npx') return selectsBeforeProgram(words, word => NPX_SELECTORS.some(option => selectsOption(word, option)), () => true)
  if (program !== 'pnpm') return false
  const selects = (word: string) => PNPM_CONFIG_KEY.test(word) || PNPM_SELECTORS.some(option => selectsOption(word, option))
  return selectsBeforeProgram(words, selects, ([first = '', ...more]) => PNPM_SCRIPT_WORDS.has(first) || (PNPM_RUNNERS.has(first) && more.length > 0))
}

/**
 * Whether `selects` holds for an option word before the program the words start: `starts` is asked of the bare words (not
 * options) read so far, and answers true at the one that names the program or script, after which every word is its own.
 * The options' own types are not modeled, so a bare word after an option typed without `=value` may be that option's value:
 * from the first such option on, the reading never stops and a selector anywhere counts (`pnpm run --reporter silent --filter a
 * build`), which fails closed for `pnpm --silent run build --filter a`, `npx -y tsc -w`, and a pnpm script of another name
 * (`pnpm lint -r`).
 */
function selectsBeforeProgram(words: readonly string[], selects: (word: string) => boolean, starts: (bare: readonly string[]) => boolean): boolean {
  const bare: string[] = []
  let loose = false
  for (const word of words) {
    if (word.startsWith('-')) {
      if (selects(word)) return true
      loose ||= !word.includes('=')
      continue
    }
    bare.push(word)
    if (!loose && starts(bare)) return false
  }
  return false
}

/**
 * The single-letter shorthands of npm (npm 11.19.0) and pnpm (10.33.2), which both parse with nopt: nopt reads a word of
 * these letters, after any number of dashes, as each letter's option, so `-qw a` and `---sw a` select workspace `a` and
 * `pnpm --qC sub run build` runs in `sub`.
 */
const SINGLE_SHORTHANDS = 'dqsnacfgLlmpCSBDEOPHhvwy?riF'

/**
 * The exact npm option names that begin a longer option the rules read (npm 11.19.0): nopt takes an exact name before any
 * abbreviation, so `--include` is not `--include-workspace-root` and `--global` is not `--globalconfig`.
 */
const EXACT_OPTIONS: ReadonlySet<string> = new Set(['include', 'global'])

/**
 * Whether a word names an option as npm's option parser (nopt) reads one (fix brief 9, B32; D91 follow-up F2): the option
 * itself, bare or with `=value`, under any number of leading dashes, as nopt strips them all (`-prefix sub`, `---C sub`);
 * a long option by a prefix of three or more letters, which nopt takes where it is unique (npm 11.19.0 ran sub's script for
 * `--prefi=sub`, and pnpm 10.33.2 read `--prefi` as `--prefix`), every such prefix read as one, which fails closed, but
 * never an exact npm option name (EXACT_OPTIONS); any run of `no-` before the name, since nopt toggles the value per `no-`
 * and a string or list option takes its next word as the value after one (`--no-no-workspaces`, `--no-workspace a`); and a
 * short option by its letter's prefix (`-Csub`, `-w=a`), by a cluster of single-letter shorthands holding the letter
 * (`-qw a`, and `--sw a` under two or more dashes, where every letter must be one), or by the double-dash spelling of the
 * letter (`--C sub`, `---w=a`, which npm ran with no warning). A bare run of dashes names none.
 */
export function selectsOption(word: string, option: string): boolean {
  const typed = word.split('=')[0]!
  const name = typed.replace(/^-+/, '')
  const dashes = typed.length - name.length
  if (dashes === 0 || name === '') return false
  if (option.startsWith('--')) {
    const long = option.slice(2)
    const bare = name.replace(/^(?:no-)+/i, '')
    return bare === long || (bare.length >= 3 && long.startsWith(bare) && !EXACT_OPTIONS.has(bare))
  }
  const letter = option.slice(1)
  return name.includes(letter) && (dashes === 1 || [...name].every(each => each === letter || SINGLE_SHORTHANDS.includes(each)))
}

/**
 * The words a wrapper form reads before the command it runs: its options, their values, and its NAME=value words. The
 * command behind it is the next form of its chain, which ends the form; where none does, every word after the wrapper.
 */
export function wrapperWords(all: readonly string[][], index: number): string[] {
  const form = all[index]!
  const next = all[index + 1]
  const start = next ? form.length - next.length : -1
  // The next form's command word is the typed one reduced as the rules reduce it: its basename, or an assignment-shaped
  // word as typed (fix brief 5, D1; fix brief 6, A7).
  const typed = form[start] ?? ''
  const ends = next !== undefined && start > 0 && (ASSIGNMENT.test(typed) ? typed : baseCommand(typed)) === next[0] && next.slice(1).every((word, offset) => form[start + 1 + offset] === word)
  return form.slice(1, ends ? start : form.length)
}

/**
 * The command word of the chain's form at `at` as the call typed it (`typed`, the call's own words): the call's first
 * word, or the word of the form before it where this form's words end that one; null where the chain does not show it,
 * as for a NAME=value program a wrapper runs, read by its basename (fix brief 6, A7 and B1).
 */
export function typedCommandWord(chain: readonly (readonly string[])[], at: number, typed: readonly string[]): string | null {
  if (at === 0) return typed[0] ?? null
  const form = chain[at]!
  const before = chain[at - 1]!
  const start = before.length - form.length
  if (start < 1 || !form.slice(1).every((word, offset) => before[start + 1 + offset] === word)) return null
  return before[start]!
}

/**
 * Whether a wrapper in the chain sets the program name an interpreter reads, which points it at a path the reader does
 * not show (fix brief 5, N1): `exec` with any option (bash's exec getopt is `cla:`, so `-a`, `-c`, and `-l` all set the
 * program name or the environment), or `env` with `-a` in a cluster or `--argv0` by any prefix getopt_long takes
 * (`--a`, `--argv=`; fix brief 6, B2). CPython takes argv[0] as its executable path and reads a venv's pyvenv.cfg and its
 * .pth files beside it before the script.
 */
export function setsProgramName(all: readonly string[][]): boolean {
  return all.some((form, index) => {
    const program = baseCommand(form[0] ?? '')
    if (program !== 'exec' && program !== 'env') return false
    const words = wrapperWords(all, index)
    return program === 'exec'
      ? words.some(word => word.startsWith('-') && word !== '--')
      : words.some(word => namesOption(word, 'a', 'argv0'))
  })
}

/**
 * Whether an env in the chain splits a word into more words (`-S` in a cluster, or `--split-string` by any prefix), which
 * env then reads as options and a command again, by rules the reader does not follow there (fix brief 6, B2).
 */
export function splitsWords(all: readonly string[][]): boolean {
  return all.some((form, index) => baseCommand(form[0] ?? '') === 'env' && wrapperWords(all, index).some(word => namesOption(word, 'S', 'split-string')))
}

/**
 * Whether a word is an option: a cluster of short options holding `short` (`-iC`; a value letter's own value may read as
 * one too, which fails closed), or a long one getopt would take for `long`, by any prefix typed (`--ch`).
 */
function namesOption(word: string, short: string, long: string): boolean {
  if (word.startsWith('--')) {
    const typed = word.slice(2).split('=')[0]!
    return typed.length > 0 && long.startsWith(typed)
  }
  return word.startsWith('-') && word.slice(1).includes(short)
}

/** A shell assignment word: a name, an optional array index, an optional `+`, then `=`. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/
/** A variable's name alone, as `export NAME` or `declare -x NAME` gives it. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** The builtins that declare or export the variable each operand names (`export NODE_OPTIONS=...`, `declare -x PATH`). */
const DECLARING = new Set(['export', 'declare', 'typeset', 'local', 'readonly'])
/** The C shells, whose text sets a variable with `setenv NAME value`, or `set path=(...)`, which sets PATH too. */
const C_SHELLS = new Set(['csh', 'tcsh'])
/** The busybox and toybox applets that are a shell, whose `-c` text follows the applet's name. */
const SHELL_APPLETS = new Set(['sh', 'ash', 'hush', 'bash', 'toysh'])

/** A variable a call's words or shell text set: its name, and its value as written, or null where none is given or its spelling is lost. */
export interface AssignedVariable { name: string; value: string | null }

/**
 * The variables a call's own words set (fix brief 2, H3), beside its `env` argument: a statement's leading NAME=value
 * words, in the call as typed, in every form of it, and in the raw text of every shell it runs, where a value holding a
 * slash, which a form's command word loses, is still read; the NAME=value words env and sudo read before their command;
 * the operands of `export`, `declare`, `typeset`, `local`, and `readonly`; and `setenv` and `set` in C shell text. An
 * assignment statement counts whether or not `set -a` exports it, as a variable already exported keeps a value given
 * later. A heredoc's body in shell text is read as statements too, which reads more, never less. `unread` where shell
 * text ran past READ_BUDGET, so a variable may be set unseen.
 */
export function assignedVariables(effect: { command: string; args: readonly string[] }, forms: CommandForms): { variables: AssignedVariable[]; unread: boolean } {
  const variables: AssignedVariable[] = []
  let unread = false
  const all = allForms(forms)
  leadingAssignments([effect.command, ...effect.args], variables, true)
  all.forEach((form, index) => {
    // A form's command word is its basename, lower-cased, so its spelling counts toward the rule alone.
    leadingAssignments(form, variables, false)
    const program = baseCommand(form[0] ?? '')
    if (program === 'env' || program === 'sudo') {
      // env sets any NAME=value word, its name holding any character but `=` (`BASH_FUNC_python3%%=() { ...; }`).
      for (const word of wrapperWords(all, index)) wrapperAssignment(word, variables)
    }
    declared(program, form.slice(1).map(word => ({ raw: word, word })), variables)
    const text = shellText(form)
    if (text === null) return
    const listed = shellStatementList(text, { characters: READ_BUDGET.characters })
    unread ||= listed.overBudget
    for (const statement of listed.statements) {
      const tokens = shellTokens(statement)
      for (const clobber of redirectionReadings(tokens)) statementAssignments(tokens, C_SHELLS.has(program), clobber, variables)
    }
  })
  return { variables, unread }
}

/** The `-c` text a form hands a shell, a C shell, or a busybox or toybox shell applet; null for any other form. */
function shellText(form: readonly string[]): string | null {
  const program = baseCommand(form[0] ?? '')
  const applet = (program === 'busybox' || program === 'toybox') && SHELL_APPLETS.has(baseCommand(form[1] ?? ''))
  const args = applet ? form.slice(2) : form.slice(1)
  if (C_SHELLS.has(program)) {
    const at = args.indexOf('-c')
    return at >= 0 && at + 1 < args.length ? args[at + 1]! : null
  }
  if (!SHELL_COMMANDS.has(program) && !applet) return null
  const { source, operand } = shellScriptOperand(args)
  return source === 'command' && operand !== undefined ? operand : null
}

function leadingAssignments(words: readonly string[], into: AssignedVariable[], typed: boolean): void {
  for (let index = 0; index < words.length && ASSIGNMENT.test(words[index]!); index++) {
    const word = words[index]!
    into.push({ name: ASSIGNMENT.exec(word)![1]!, value: typed || index > 0 ? word.slice(word.indexOf('=') + 1) : null })
  }
}

/** A NAME=value word a wrapper reads before its command, whatever characters its name holds; an option is none. */
function wrapperAssignment(word: string, into: AssignedVariable[]): void {
  const equals = word.indexOf('=')
  if (equals > 0 && !word.startsWith('-')) into.push({ name: word.slice(0, equals), value: word.slice(equals + 1) })
}

function assignment(word: string, into: AssignedVariable[]): void {
  const match = ASSIGNMENT.exec(word)
  if (match) into.push({ name: match[1]!, value: word.slice(word.indexOf('=') + 1) })
}

/**
 * One statement of shell text, its redirections read as `clobber` says (redirectionReadings, the grammar the rules read
 * shares): its leading assignments, then what its command declares.
 */
function statementAssignments(tokens: readonly ShellToken[], cShell: boolean, clobber: boolean, into: AssignedVariable[]): void {
  let index = 0
  for (; index < tokens.length; index++) {
    const { raw, word } = tokens[index]!
    if (isRedirection(raw)) {
      if (takesNextWord(raw, clobber)) index++
      continue
    }
    const match = ASSIGNMENT.exec(raw)
    if (!match) break
    into.push({ name: match[1]!, value: word.slice(word.indexOf('=') + 1) })
  }
  const command = tokens[index]?.word
  if (command === undefined) return
  const rest = tokens.slice(index + 1)
  if (command === 'setenv') {
    if (rest[0] !== undefined) into.push({ name: rest[0].word, value: rest[1]?.word ?? null })
  } else if (command === 'set' && cShell) {
    for (const token of rest) assignment(token.word, into)
  } else {
    declared(command, rest, into)
  }
}

/** The variables `export`, `declare`, `typeset`, `local`, or `readonly` names, each with its value where one is given. */
function declared(command: string, operands: readonly ShellToken[], into: AssignedVariable[]): void {
  if (!DECLARING.has(command)) return
  for (const { raw, word } of operands) {
    if (raw.startsWith('-') || raw.startsWith('+')) continue
    const match = ASSIGNMENT.exec(raw)
    if (match) into.push({ name: match[1]!, value: word.slice(word.indexOf('=') + 1) })
    else if (NAME.test(word)) into.push({ name: word, value: null })
  }
}
