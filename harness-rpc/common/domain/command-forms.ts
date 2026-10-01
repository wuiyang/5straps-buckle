import { baseCommand, parseArgv, shellStatements, shellTokens, shellWords, statementsOf } from './argv.js'

/** How many wrappers, or shell bodies inside shell bodies, are read before the rest is called unread. */
const MAX_DEPTH = 8

/**
 * A program that runs the command named after its own options and operands. Only the options that take a
 * value are listed: getopt reads every other one as a flag, and each of these stops at its first operand.
 */
interface Wrapper {
  /** Short options taking a value: the rest of the cluster, or else the next word. */
  shortValues?: string
  /** Short options whose value is optional, so only the rest of the cluster (`xargs -i{}`), never the next word. */
  shortOptional?: string
  /** Long options taking a value as `--name value` or `--name=value`; a prefix getopt would expand counts. */
  longValues?: readonly string[]
  /** Options after which nothing runs (`chrt -p` acts on a process, `command -v` only prints). */
  runsNothing?: { short: string; long: readonly string[] }
  /** Words between the options and the command: timeout's duration, chrt's priority. */
  operands?: number
  /** `env`'s NAME=value words before the command. */
  assignments?: true
  /** An option whose value is split into words and read in its place (`env -S 'git push --force'`). */
  split?: { short: string; long: string }
  /** `nice -10`: a number written as an option. */
  numericOption?: true
  /** After the operands, an option whose value a shell runs (`flock <file> -c 'git push -f'`), read as `sh -c <value>`. */
  shellCommand?: readonly string[]
}

/**
 * The prefixes that run another command, a finite table (the continuation review, "Seen outside this range": `env
 * git push --force` passed the destructive floor and the command policy; slice 7 review F1; owner decision D25,
 * default (a)). Their option tables follow each program's getopt string (coreutils env, nice, nohup, timeout and
 * stdbuf; GNU time; findutils xargs; util-linux ionice, chrt, setsid and flock; the shell's `command`, `exec` and
 * `builtin`).
 *
 * Read the same way, though not in the table: a statement's leading NAME=value assignments (`A=1 git push
 * --force`); `eval`, whose words are read again as shell text, and asked about when that text holds an expansion
 * Buckle cannot know (`eval "$x"`; unknown structure asks); and each command of `find -exec`, `-execdir`, `-ok` or
 * `-okdir`, up to its `;` or `{} +`.
 *
 * Any other program that runs a command (`watch`, `parallel`, `su -c`, `ssh host ...`) is judged by its own words
 * only: the destructive floor does not read past it, the deny list meets it by its leading words, and an allow
 * list refuses it unless a glob admits the call as typed. Nothing here changes what a policy means.
 */
const WRAPPERS: Readonly<Record<string, Wrapper>> = {
  env: { shortValues: 'aCSu', longValues: ['argv0', 'chdir', 'split-string', 'unset'], assignments: true, split: { short: 'S', long: 'split-string' } },
  nice: { shortValues: 'n', longValues: ['adjustment'], numericOption: true },
  nohup: {},
  time: { shortValues: 'fo', longValues: ['format', 'output'] },
  timeout: { shortValues: 'ks', longValues: ['kill-after', 'signal'], operands: 1 },
  stdbuf: { shortValues: 'ioe', longValues: ['input', 'output', 'error'] },
  ionice: { shortValues: 'cnpPu', longValues: ['class', 'classdata', 'pid', 'pgid', 'uid'], runsNothing: { short: 'pPu', long: ['pid', 'pgid', 'uid'] } },
  chrt: { shortValues: 'TPD', longValues: ['sched-runtime', 'sched-period', 'sched-deadline'], operands: 1, runsNothing: { short: 'pm', long: ['pid', 'max'] } },
  command: { runsNothing: { short: 'vV', long: [] } },
  exec: { shortValues: 'a' },
  builtin: {},
  setsid: {},
  flock: { shortValues: 'wE', longValues: ['timeout', 'wait', 'conflict-exit-code'], operands: 1, shellCommand: ['-c', '--command'] },
  xargs: { shortValues: 'aEILnsPd', shortOptional: 'eil', longValues: ['arg-file', 'delimiter', 'max-args', 'max-procs', 'max-chars', 'process-slot-var'] },
}

/** A shell assignment word: a name, an optional array index, an optional `+`, then `=`. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/

/** eval text holding an expansion or a substitution, whose words only exist once the shell has run. */
const UNKNOWN_TEXT = /[$`]/

const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir'])

/** Words a shell reads before the command of a statement (`if git push -f; then`), none taking an option. */
const SHELL_KEYWORDS = new Set(['!', '{', 'if', 'then', 'else', 'elif', 'do', 'while', 'until'])
const KEYWORD: Wrapper = {}

function wrapperOf(command: string): Wrapper | undefined {
  if (Object.hasOwn(WRAPPERS, command)) return WRAPPERS[command]
  return SHELL_KEYWORDS.has(command) ? KEYWORD : undefined
}

/** A redirection word: optional descriptor digits, then `<` or `>`; a bare operator's target is the next word. */
const REDIRECTION = /^\d*[<>]/
const BARE_REDIRECTION = /^\d*(?:<<?<?|>>?|>\||<>)$/

export interface CommandForms {
  /** The call as typed, then the command behind each wrapper prefix in turn: the last one is what runs. */
  chain: string[][]
  /** Every command the last of the chain runs inside itself (a shell body's statements, eval's text, a find -exec command), each with its own chain and bodies, flattened. */
  nested: string[][]
  /** Wrappers or shell bodies nested deeper than Buckle reads, so a command was left unread. */
  unread: boolean
  /** An eval whose text holds an expansion (`eval "$x"`), or that statement splitting left empty, so what it runs is unknown. */
  unknownEval: boolean
}

/**
 * Every command a call runs, as words a rule judges (each command word reduced to its basename): the call
 * itself, the command behind each wrapper prefix or assignment, and each statement of a shell body or of eval's
 * text and each find -exec command, recursively. Display and
 * identity never use these forms; a rule shows and binds the raw argv (owner decision D17).
 */
export function commandForms(command: string, args: readonly string[]): CommandForms {
  return formsOf([command, ...args], 0)
}

/** Every form, in the order a rule should meet them: the call as typed first. */
export function allForms(forms: CommandForms): string[][] {
  return [...forms.chain, ...forms.nested]
}

/** `words` as written: the command word is reduced to its basename only after an assignment prefix is read. */
function formsOf(words: readonly string[], depth: number): CommandForms {
  const { chain, unread } = wrapperChain(words)
  const inner = innerCommands(chain.at(-1)!)
  const forms: CommandForms = { chain, nested: [], unread, unknownEval: inner.unknownEval }
  for (const command of inner.commands) {
    if (depth >= MAX_DEPTH) return { ...forms, unread: true }
    const nested = formsOf(command, depth + 1)
    forms.nested.push(...nested.chain, ...nested.nested)
    forms.unread ||= nested.unread
    forms.unknownEval ||= nested.unknownEval
  }
  return forms
}

/** The commands a command runs inside itself: each statement of a shell's script body or of eval's text, and each find -exec command. */
function innerCommands(runs: readonly string[]): { commands: string[][]; unknownEval: boolean } {
  const [command = '', ...args] = runs
  if (command === 'find') return { commands: findCommands(args), unknownEval: false }
  if (command === 'eval') {
    // eval joins its words with spaces and runs the result as shell text.
    const text = args.join(' ')
    return { commands: statementForms(statementsOf(text)), unknownEval: UNKNOWN_TEXT.test(text) || text.trim() === '' }
  }
  return { commands: statementForms(shellStatements(parseArgv(command, args))), unknownEval: false }
}

/** Each `-exec`, `-execdir`, `-ok` or `-okdir` command, up to the `;` or the `{} +` that ends it, or to the end. */
function findCommands(args: readonly string[]): string[][] {
  const commands: string[][] = []
  for (let index = 0; index < args.length; index++) {
    if (!FIND_EXEC.has(args[index]!)) continue
    let end = index + 1
    while (end < args.length && args[end] !== ';' && !(args[end] === '+' && args[end - 1] === '{}')) end++
    if (end > index + 1) commands.push(args.slice(index + 1, end))
    index = end
  }
  return commands
}

function wrapperChain(words: readonly string[]): { chain: string[][]; unread: boolean } {
  const chain = [reduced(words)]
  let current = words
  for (let depth = 0; ; depth++) {
    const inner = unwrapped(current)
    if (inner === undefined) return { chain, unread: false }
    if (depth >= MAX_DEPTH) return { chain, unread: true }
    if (!inner?.[0]) return { chain, unread: false }
    current = inner
    chain.push(reduced(current))
  }
}

/** What the first words run: past NAME=value assignments, a wrapper's options or a shell keyword. Undefined when the first word is none of those, null when nothing runs. */
function unwrapped(words: readonly string[]): string[] | null | undefined {
  if (ASSIGNMENT.test(words[0] ?? '')) {
    const command = words.findIndex(word => !ASSIGNMENT.test(word))
    return command < 0 ? null : words.slice(command)
  }
  const wrapper = wrapperOf(baseCommand(words[0] ?? ''))
  return wrapper === undefined ? undefined : innerCommand(wrapper, words.slice(1))
}

/** A command as a rule compares it: the command word reduced to its basename. */
function reduced(words: readonly string[]): string[] {
  const [command = '', ...args] = words
  return [baseCommand(command), ...args]
}

/** The command a wrapper runs, read past its options, assignments and operands; null when it runs none. */
function innerCommand(wrapper: Wrapper, args: readonly string[]): string[] | null {
  const words = [...args]
  let index = 0
  while (index < words.length) {
    const word = words[index]!
    if (word === '--') {
      index++
      break
    }
    // `env -` is `env -i`; for every other wrapper a lone `-` is the command word.
    if (word === '-' && wrapper.assignments) {
      index++
      continue
    }
    if (word === '-' || !word.startsWith('-')) break
    if (wrapper.numericOption && /^-[-+]?\d/.test(word)) {
      index++
      continue
    }
    const option = word.startsWith('--') ? readLong(wrapper, words, index) : readShort(wrapper, words, index)
    if (option.runsNothing) return null
    index = option.next
    if (option.split !== undefined) words.splice(index, 0, ...shellWords(option.split))
  }
  if (wrapper.assignments) while (index < words.length && words[index]!.includes('=')) index++
  index += wrapper.operands ?? 0
  if (wrapper.shellCommand?.includes(words[index] ?? '')) return index + 1 < words.length ? ['sh', '-c', words[index + 1]!] : null
  return index < words.length ? words.slice(index) : null
}

interface ReadOption { next: number; runsNothing?: true; split?: string }

function readLong(wrapper: Wrapper, words: readonly string[], index: number): ReadOption {
  const word = words[index]!
  const separator = word.indexOf('=')
  const typed = separator === -1 ? word.slice(2) : word.slice(2, separator)
  if (typed.length > 0 && wrapper.runsNothing?.long.some(name => name.startsWith(typed))) return { next: index + 1, runsNothing: true }
  const name = typed.length > 0 ? wrapper.longValues?.find(candidate => candidate.startsWith(typed)) : undefined
  if (name === undefined) return { next: index + 1 }
  const value = separator === -1 ? words[index + 1] : word.slice(separator + 1)
  const next = separator === -1 ? index + 2 : index + 1
  return name === wrapper.split?.long && value !== undefined ? { next, split: value } : { next }
}

function readShort(wrapper: Wrapper, words: readonly string[], index: number): ReadOption {
  const word = words[index]!
  for (let offset = 1; offset < word.length; offset++) {
    const character = word.charAt(offset)
    if (wrapper.runsNothing?.short.includes(character)) return { next: index + 1, runsNothing: true }
    if (wrapper.shortOptional?.includes(character)) return { next: index + 1 }
    if (!wrapper.shortValues?.includes(character)) continue
    const attached = word.slice(offset + 1)
    const value = attached.length > 0 ? attached : words[index + 1]
    const next = attached.length > 0 ? index + 1 : index + 2
    return character === wrapper.split?.short && value !== undefined ? { next, split: value } : { next }
  }
  return { next: index + 1 }
}

function statementForms(statements: readonly string[]): string[][] {
  return statements.map(statementForm).filter(form => form.length > 0)
}

/**
 * A statement's words without its redirections, so `make > /dev/null` is judged as `make`. Only an unquoted
 * operator redirects: `git clean -e '>' -f` hands git a `>` and keeps its `-f` (slice 7 review F2).
 */
function statementForm(statement: string): string[] {
  const tokens = shellTokens(statement)
  const kept: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const { raw, word } = tokens[index]!
    if (!REDIRECTION.test(raw)) kept.push(word)
    else if (BARE_REDIRECTION.test(raw)) index++
  }
  return kept
}
