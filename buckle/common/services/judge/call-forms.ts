import { baseCommand, SHELL_COMMANDS, shellScriptOperand, shellStatementList, shellTokens, type ShellToken } from '../../domain/argv.js'
import { allForms, type CommandForms, READ_BUDGET } from '../../domain/command-forms.js'

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

/** The shell builtins that change the working directory of every statement after them. */
const DIRECTORY_COMMANDS = new Set(['cd', 'pushd', 'popd'])

/**
 * The options, by program, that run a command or a script from another folder: env's and sudo's (read among the
 * wrapper's own words alone, so an option of the command after them is not one), and those of the runtimes and package
 * managers that take a folder to run in (read anywhere before a `--`, which fails closed for a script's own argument).
 */
const WRAPPER_CHDIR: Readonly<Record<string, string>> = { env: 'C', sudo: 'D' }
const PROGRAM_CHDIR: Readonly<Record<string, readonly string[]>> = {
  bun: ['--cwd'], 'ts-node': ['--cwd'], ruby: ['-C', '-X'],
  npx: ['-C', '--prefix', '--dir', '--cwd'], pnpx: ['-C', '--prefix', '--dir', '--cwd'], bunx: ['-C', '--prefix', '--dir', '--cwd'],
  npm: ['-C', '--prefix', '--dir', '--cwd'], pnpm: ['-C', '--prefix', '--dir', '--cwd'], yarn: ['-C', '--prefix', '--dir', '--cwd'],
}

/**
 * Whether a call moves to another folder before its code runs (fix brief 2, H2), so the code read at the call's own
 * working directory may not be the code that runs: a `cd`, `pushd`, or `popd` anywhere in it, `env -C` or `--chdir`,
 * `sudo -D` or `--chdir`, `bun --cwd`, or a runner's or package manager's `-C`, `--prefix`, `--dir`, or `--cwd`.
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
    return form.slice(1, end < 0 ? form.length : end).some(word => options.some(option => word === option || word.startsWith(option.startsWith('--') ? `${option}=` : option)))
  })
}

/**
 * The words a wrapper form reads before the command it runs: its options, their values, and its NAME=value words. The
 * command behind it is the next form of its chain, which ends the form; where none does, every word after the wrapper.
 */
export function wrapperWords(all: readonly string[][], index: number): string[] {
  const form = all[index]!
  const next = all[index + 1]
  const start = next ? form.length - next.length : -1
  const ends = next !== undefined && start > 0 && baseCommand(form[start] ?? '') === next[0] && next.slice(1).every((word, offset) => form[start + 1 + offset] === word)
  return form.slice(1, ends ? start : form.length)
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
const REDIRECTION = /^\d*[<>]/
const BARE_REDIRECTION = /^\d*(?:<<-|<<?<?|>>?|>\||<>)$/

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
      for (const word of wrapperWords(all, index)) assignment(word, variables)
    }
    declared(program, form.slice(1).map(word => ({ raw: word, word })), variables)
    const text = shellText(form)
    if (text === null) return
    const listed = shellStatementList(text, { characters: READ_BUDGET.characters })
    unread ||= listed.overBudget
    for (const statement of listed.statements) statementAssignments(shellTokens(statement), C_SHELLS.has(program), variables)
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

function assignment(word: string, into: AssignedVariable[]): void {
  const match = ASSIGNMENT.exec(word)
  if (match) into.push({ name: match[1]!, value: word.slice(word.indexOf('=') + 1) })
}

/** One statement of shell text: its leading assignments, then what its command declares. */
function statementAssignments(tokens: readonly ShellToken[], cShell: boolean, into: AssignedVariable[]): void {
  let index = 0
  for (; index < tokens.length; index++) {
    const { raw, word } = tokens[index]!
    if (REDIRECTION.test(raw)) {
      if (BARE_REDIRECTION.test(raw)) index++
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
