import { baseCommand, parseArgv, SHELL_COMMANDS, shellStatementList, shellTokensUpTo, shellWords, statementPieces } from './argv.js'

/** How many wrappers, or shell bodies inside shell bodies, are read before the rest is called unread. */
const MAX_DEPTH = 8

/**
 * What one reading of a call takes in across every nesting level before it stops and asks (slice 7b review W7B-1,
 * W7B-8): the characters of shell text it splits into statements, the words of those statements, and the commands
 * it keeps. A 1 MB request read at every level MAX_DEPTH allows fits; whatever runs past the budget is unread.
 */
export const READ_BUDGET = { characters: 8_000_000, words: 1_000_000, commands: 100_000 } as const

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
/**
 * GNU find's primaries and options that take the next word as their value (findutils parser.c), so a value such
 * as the `-exec` of `-name -exec` is never read as a primary (slice 7b review W7B-6). `-newerXY` takes one too.
 */
const FIND_VALUE_PRIMARIES = new Set([
  '-amin', '-anewer', '-atime', '-cmin', '-cnewer', '-context', '-ctime', '-files0-from', '-fls', '-fprint', '-fprint0', '-fprintf', '-fstype',
  '-gid', '-group', '-ilname', '-iname', '-inum', '-ipath', '-iregex', '-iwholename', '-links', '-lname', '-maxdepth', '-mindepth', '-mmin',
  '-mtime', '-name', '-newer', '-path', '-perm', '-printf', '-regex', '-regextype', '-samefile', '-size', '-type', '-uid', '-used', '-user',
  '-wholename', '-xtype', '-D',
])
const FIND_NEWER = /^-newer[aBcmt][aBcmt]$/
/** A word find reads as a primary, an option or an operator, never as a command it runs. */
const FIND_PRIMARY = /^-[A-Za-z]/

/** Words a shell reads before the command of a statement (`if git push -f; then`), none taking an option. */
const SHELL_KEYWORDS = new Set(['!', '{', 'if', 'then', 'else', 'elif', 'do', 'while', 'until'])
const KEYWORD: Wrapper = {}
/** What may follow `coproc NAME`: a compound command, which alone lets a coprocess have a name (bash, coproc). */
const COMPOUND_START = new Set(['{', 'if', 'while', 'until', 'for', 'select', 'case', '[[', '(('])

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
  /** Wrappers or shell bodies nested deeper than Buckle reads, or a find -exec command that is a primary, so a command was left unread. */
  unread: boolean
  /** An eval whose text holds an expansion (`eval "$x"`), or that statement splitting left empty, so what it runs is unknown. */
  unknownEval: boolean
  /** The read budget (READ_BUDGET) ran out, so the commands past it were left unread. */
  overBudget: boolean
}

/**
 * Every command a call runs, as words a rule judges (each command word reduced to its basename): the call
 * itself, the command behind each wrapper prefix or assignment, and each statement of a shell body or of eval's
 * text and each find -exec command, recursively. Display and
 * identity never use these forms; a rule shows and binds the raw argv (owner decision D17).
 */
export function commandForms(command: string, args: readonly string[]): CommandForms {
  const { rereads: _rereads, ...forms } = formsOf([command, ...args], 0, { ...READ_BUDGET, spent: false })
  return forms
}

const formsByEffect = new WeakMap<object, CommandForms>()

/**
 * The forms of one exec effect, read once and shared by every rule that judges it, the node ceiling's included,
 * and by every check of the same call (slice 7b review W7B-1). Keyed by the effect object, which a call keeps for
 * all of its checks; the forms are read only, never changed.
 */
export function commandFormsOf(effect: { command: string; args: readonly string[] }): CommandForms {
  const known = formsByEffect.get(effect)
  if (known) return known
  const forms = commandForms(effect.command, effect.args)
  formsByEffect.set(effect, forms)
  return forms
}

/** Every form, in the order a rule should meet them: the call as typed first. */
export function allForms(forms: CommandForms): string[][] {
  return [...forms.chain, ...forms.nested]
}

/** What is left of READ_BUDGET in one reading; `spent` once any part ran out. */
interface Budget { characters: number; words: number; commands: number; spent: boolean }

/** The forms, and whether the last of the chain reads its own text again as shell text (eval, a shell, find -exec). */
interface Reading extends CommandForms { rereads: boolean }

/**
 * `words` as written: the command word is reduced to its basename only after an assignment prefix is read. Each
 * statement of an inner text is read, and its pieces too unless the statement reads its own text again (eval, a
 * shell, find -exec), which covers them, so no text is read twice per level (slice 7b review W7B-1).
 */
function formsOf(words: readonly string[], depth: number, budget: Budget): Reading {
  const { chain, unread } = wrapperChain(words)
  const inner = innerCommands(chain.at(-1)!, budget)
  const forms: Reading = { chain, nested: [], unread: unread || inner.unread, unknownEval: inner.unknownEval, overBudget: false, rereads: inner.rereads }
  const read = (command: string[]): Reading | null => {
    if (depth >= MAX_DEPTH) {
      forms.unread = true
      return null
    }
    const nested = formsOf(command, depth + 1, budget)
    keep(forms.nested, nested.chain, budget)
    keep(forms.nested, nested.nested, budget)
    forms.unread ||= nested.unread
    forms.unknownEval ||= nested.unknownEval
    return nested
  }
  for (const group of inner.groups) {
    if (budget.spent) break
    if (group.command.length > 0) {
      const nested = read(group.command)
      if (nested === null) break
      if (nested.rereads) continue
    }
    // Split and read only now: a statement that reads its own text again has covered its pieces.
    for (const piece of statementPieces(group.statement)) {
      const form = budget.spent ? null : statementForm(piece, budget)
      if (form === null) break
      if (form.length > 0) read(form)
    }
  }
  forms.overBudget = budget.spent
  return forms
}

/** Forms appended one at a time, never spread into one call (slice 7b review W7B-8), up to the budget's command count. */
function keep(into: string[][], forms: readonly string[][], budget: Budget): void {
  for (const form of forms) {
    if (budget.commands <= 0) {
      budget.spent = true
      return
    }
    budget.commands--
    into.push(form)
  }
}

/** A command a statement runs, and the statement as written, whose pieces are read too unless the command reads its own text again. */
interface CommandGroup { command: string[]; statement: string }

interface InnerCommands { groups: CommandGroup[]; unknownEval: boolean; unread: boolean; rereads: boolean }

/** The commands a command runs inside itself: each statement of a shell's script body or of eval's text, and each find -exec command. */
function innerCommands(runs: readonly string[], budget: Budget): InnerCommands {
  const [command = '', ...args] = runs
  if (command === 'find') {
    const found = findCommands(args)
    return { groups: found.commands.map(form => ({ command: form, statement: '' })), unknownEval: false, unread: found.unread, rereads: found.commands.length > 0 }
  }
  if (command === 'eval') {
    // eval joins its words with spaces and runs the result as shell text; one leading `--` ends its options (slice 7b review W7B-2).
    const text = (args[0] === '--' ? args.slice(1) : args).join(' ')
    return { ...textCommands(text, budget), unknownEval: UNKNOWN_TEXT.test(text) || text.trim() === '', rereads: true }
  }
  if (!SHELL_COMMANDS.has(command)) return { groups: [], unknownEval: false, unread: false, rereads: false }
  return { ...textCommands(parseArgv(command, args).positionals.join('\n'), budget), unknownEval: false, rereads: true }
}

/** The commands of shell text, within the budget: each statement's form, beside the statement as written. */
function textCommands(text: string, budget: Budget): { groups: CommandGroup[]; unread: boolean } {
  budget.characters -= text.length
  if (budget.characters < 0) {
    budget.spent = true
    return { groups: [], unread: false }
  }
  const { statements, deep } = shellStatementList(text)
  const groups: CommandGroup[] = []
  for (const statement of statements) {
    const command = statementForm(statement, budget)
    if (command === null) break
    groups.push({ command, statement })
  }
  return { groups, unread: deep }
}

/**
 * Each `-exec`, `-execdir`, `-ok` or `-okdir` command, up to the `;` or the `{} +` that ends it, or to the end. A
 * primary's value is skipped, so `-name -exec` names a file; a command whose first word is itself a primary is not
 * one find would run as written, so it is called unread (slice 7b review W7B-6).
 */
function findCommands(args: readonly string[]): { commands: string[][]; unread: boolean } {
  const commands: string[][] = []
  let unread = false
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (FIND_VALUE_PRIMARIES.has(word) || FIND_NEWER.test(word)) {
      index++
      continue
    }
    if (!FIND_EXEC.has(word)) continue
    let end = index + 1
    while (end < args.length && args[end] !== ';' && !(args[end] === '+' && args[end - 1] === '{}')) end++
    if (end > index + 1) {
      if (FIND_PRIMARY.test(args[index + 1]!)) unread = true
      else commands.push(args.slice(index + 1, end))
    }
    index = end
  }
  return { commands, unread }
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

/**
 * What the first words run: past NAME=value assignments, a wrapper's options, a shell keyword, `function NAME` or
 * `coproc [NAME]` (slice 7b review W7B-3). Undefined when the first word is none of those, null when nothing runs.
 */
function unwrapped(words: readonly string[]): string[] | null | undefined {
  if (ASSIGNMENT.test(words[0] ?? '')) {
    const command = words.findIndex(word => !ASSIGNMENT.test(word))
    return command < 0 ? null : words.slice(command)
  }
  if (words[0] === 'function') return words.length > 2 ? words.slice(2) : null
  if (words[0] === 'coproc') return COMPOUND_START.has(words[2] ?? '') ? words.slice(2) : words.length > 1 ? words.slice(1) : null
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

/**
 * A statement's words without its redirections, so `make > /dev/null` is judged as `make`. Only an unquoted
 * operator redirects: `git clean -e '>' -f` hands git a `>` and keeps its `-f` (slice 7 review F2). Null when the
 * budget's words ran out before the statement was read whole.
 */
function statementForm(statement: string, budget: Budget): string[] | null {
  const { tokens, more } = shellTokensUpTo(statement, Math.max(0, budget.words))
  budget.words -= tokens.length
  if (more) {
    budget.spent = true
    return null
  }
  const kept: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const { raw, word } = tokens[index]!
    if (!REDIRECTION.test(raw)) kept.push(word)
    else if (BARE_REDIRECTION.test(raw)) index++
  }
  return kept
}
