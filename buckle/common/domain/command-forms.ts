import { baseCommand, INPUT_PATHS, MAX_DEPTH, MAX_SUBSTITUTIONS, parseArgv, SHELL_COMMANDS, shellScriptSource, shellStatementList, shellTokensUpTo, shellWords, sshInvocation, statementPieces, suInvocation } from './argv.js'

/**
 * What one reading of a call takes in across every nesting level before it stops and asks (slice 7b review W7B-1,
 * W7B-8): the characters of shell text it splits into statements, the words of those statements, and the commands
 * it keeps. A 1 MB request read at every level MAX_DEPTH allows fits; whatever runs past the budget is unread.
 */
export const READ_BUDGET = { characters: 8_000_000, words: 1_000_000, commands: 100_000 } as const

/**
 * Each limit a reading can stop at, as a reason names it, in the order a reason picks one when a call met several:
 * the destructive floor asks at any of them, and a command deny list refuses at any of them, since the part left
 * unread may hold a denied command (owner decision D7, defaults D30 and D33). The reason names the limit that stopped
 * the reading, so a substitution or a find primary is never called MAX_DEPTH (slice 7d review R7D-BD-1).
 */
export const READ_LIMITS = {
  depth: `Wrappers or shell bodies nest deeper than Buckle reads (MAX_DEPTH: ${MAX_DEPTH} levels)`,
  budget: `Shell text runs past what Buckle reads in one check (READ_BUDGET: ${READ_BUDGET.characters.toLocaleString('en-US')} characters, ${READ_BUDGET.words.toLocaleString('en-US')} words or ${READ_BUDGET.commands.toLocaleString('en-US')} commands across every level)`,
  substitutions: `Command substitutions inside double quotes nest deeper than Buckle splits into statements (MAX_SUBSTITUTIONS: ${MAX_SUBSTITUTIONS} levels)`,
  findPrimary: 'A find -exec command starts with a word find reads as a primary, which Buckle does not read as a command (find primary)',
  session: 'Opens an interactive session Buckle cannot read: ssh or su with no command, or a sudo or doas shell (interactive session)',
  scriptData: 'A shell takes its script from a pipe, a redirection, or xargs, so the script arrives as data, which Buckle cannot read (script as data)',
  interpreter: 'Runs code Buckle cannot read as shell, with an interpreter the policy does not allow (unknown interpreter)',
} as const

export type ReadLimit = keyof typeof READ_LIMITS
/**
 * A limit that leaves a command unread; the budget is kept apart, in `overBudget`, a script that arrives as data in
 * `scriptData`, and the interpreters a call runs code with in `interpreters`, which each policy judges by its own list.
 */
type UnreadLimit = Exclude<ReadLimit, 'budget' | 'scriptData' | 'interpreter'>

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
  /** `env`'s and `sudo`'s NAME=value words before the command. */
  assignments?: true
  /** `env -`, which is `env -i`; for every other wrapper a lone `-` is the command word. */
  dashOption?: true
  /** Options that open an interactive session when no command follows (`sudo -i`, `sudo -s`, `doas -s`), which Buckle cannot read. */
  session?: { short: string; long: readonly string[] }
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
 * stdbuf; GNU time; findutils xargs; util-linux ionice, chrt, setsid and flock; sudo 1.9 and OpenDoas; the shell's
 * `command`, `exec` and `builtin`). `sudo git push` was read as `sudo` alone, so under the dangerously-allow switch its
 * ask became an allow past a deny glob on `git push *` (slice 7i residual, owner decision D7).
 *
 * Read the same way, though not in the table: a statement's leading NAME=value assignments (`A=1 git push
 * --force`); `eval`, whose words are read again as shell text, and asked about when that text holds an expansion
 * Buckle cannot know (`eval "$x"`; unknown structure asks); each command of `find -exec`, `-execdir`, `-ok` or
 * `-okdir`, up to its `;` or `{} +`; the shell `su -c` runs and the remote command `ssh` sends, each read as shell
 * text (sshInvocation, suInvocation). An ssh or su with no command, and `sudo -i`, `sudo -s` or `doas -s` with none,
 * opens an interactive session, an unread call (READ_LIMITS.session).
 *
 * Any other program that runs a command (`watch`, `parallel`) is judged by its own words only: the destructive floor
 * does not read past it, the deny list meets it by its leading words, and an allow list refuses it unless a glob
 * admits the call as typed. Nothing here changes what a policy means.
 */
const WRAPPERS: Readonly<Record<string, Wrapper>> = {
  env: { shortValues: 'aCSu', longValues: ['argv0', 'chdir', 'split-string', 'unset'], assignments: true, dashOption: true, split: { short: 'S', long: 'split-string' } },
  sudo: {
    shortValues: 'aCcDghpRrTtUu',
    longValues: ['auth-type', 'close-from', 'login-class', 'chdir', 'group', 'host', 'prompt', 'chroot', 'role', 'type', 'command-timeout', 'other-user', 'user'],
    assignments: true,
    session: { short: 'is', long: ['login', 'shell'] },
  },
  doas: { shortValues: 'aCu', session: { short: 's', long: [] } },
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
  /**
   * Why a command was left unread, or null: wrappers or shell bodies nested past MAX_DEPTH, substitutions nested past
   * MAX_SUBSTITUTIONS, a find -exec command that is a primary, or an interactive session; the first in READ_LIMITS order
   * when several were met.
   */
  unread: UnreadLimit | null
  /** An eval whose text holds an expansion (`eval "$x"`), or that statement splitting left empty, so what it runs is unknown. */
  unknownEval: boolean
  /** The read budget (READ_BUDGET) ran out, so the commands past it were left unread. */
  overBudget: boolean
  /** A shell or `source` the call runs takes its script as data, from its input or from xargs (scriptArrivesAsData). */
  scriptData: boolean
  /** The interpreters the call runs code with (interpreterRunningCode), by program name, each once. */
  interpreters: string[]
}

/**
 * Every command a call runs, as words a rule judges (each command word reduced to its basename): the call
 * itself, the command behind each wrapper prefix or assignment, and each statement of a shell body or of eval's
 * text and each find -exec command, recursively. Display and
 * identity never use these forms; a rule shows and binds the raw argv (owner decision D17).
 */
export function commandForms(command: string, args: readonly string[]): CommandForms {
  const { rereads: _rereads, ...forms } = formsOf([command, ...args], 0, { ...READ_BUDGET, spent: false }, CALL)
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

const NO_INTERPRETERS: ReadonlySet<string> = new Set()

/**
 * The limit a reading stopped at, the first in READ_LIMITS order, or null when the call was read whole. An interpreter
 * the policy allows (`allowed`) is an ordinary command, so only another one leaves the call unknown (owner decision D55).
 */
export function readLimitOf(forms: CommandForms, allowed: ReadonlySet<string> = NO_INTERPRETERS): ReadLimit | null {
  if (forms.unread === 'depth') return 'depth'
  if (forms.overBudget) return 'budget'
  if (forms.unread) return forms.unread
  if (forms.scriptData) return 'scriptData'
  return forms.interpreters.some(name => !allowed.has(name)) ? 'interpreter' : null
}

/** How a reason names a limit: as READ_LIMITS words it, and for an interpreter with the programs the policy does not allow. */
export function readLimitReason(limit: ReadLimit, forms: CommandForms, allowed: ReadonlySet<string> = NO_INTERPRETERS): string {
  if (limit !== 'interpreter') return READ_LIMITS[limit]
  return `${READ_LIMITS.interpreter}: ${forms.interpreters.filter(name => !allowed.has(name)).join(', ')}`
}

const UNREAD_ORDER = Object.keys(READ_LIMITS) as ReadLimit[]

/** Of two unread limits, the one READ_LIMITS lists first, so one reading names one limit whatever order it met them in. */
function firstLimit(known: UnreadLimit | null, met: UnreadLimit | null): UnreadLimit | null {
  if (known === null || met === null) return known ?? met
  return UNREAD_ORDER.indexOf(met) < UNREAD_ORDER.indexOf(known) ? met : known
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
 * Where the words being read stand: the call itself, whose input Buckle's exec leaves empty, or a statement of shell
 * text (a shell body, eval text, a find -exec command), whose input may be a pipe, a redirection or the input of a
 * pipeline around it; `heredoc` when a heredoc on that statement feeds its input, which Buckle reads.
 */
interface Place { statement: boolean; heredoc: boolean }
const CALL: Place = { statement: false, heredoc: false }

/**
 * `words` as written: the command word is reduced to its basename only after an assignment prefix is read. Each
 * statement of an inner text is read, and its pieces too unless the statement reads its own text again (eval, a
 * shell, find -exec), which covers them, so no text is read twice per level (slice 7b review W7B-1). A piece is a
 * split no shell makes, read only so a glob meets a command quoted for another program, so it marks no script as data.
 */
function formsOf(words: readonly string[], depth: number, budget: Budget, place: Place): Reading {
  const { chain, unread } = wrapperChain(words)
  const inner = innerCommands(chain.at(-1)!, budget)
  const interpreter = interpreterRunningCode(chain, place)
  const forms: Reading = { chain, nested: [], unread: firstLimit(unread, inner.unread), unknownEval: inner.unknownEval, overBudget: false, scriptData: scriptArrivesAsData(chain, place), interpreters: interpreter ? [interpreter] : [], rereads: inner.rereads }
  const read = (command: string[], at: Place, piece = false): Reading | null => {
    if (depth >= MAX_DEPTH) {
      forms.unread = 'depth'
      return null
    }
    const nested = formsOf(command, depth + 1, budget, at)
    keep(forms.nested, nested.chain, budget)
    keep(forms.nested, nested.nested, budget)
    forms.unread = firstLimit(forms.unread, nested.unread)
    forms.unknownEval ||= nested.unknownEval
    if (!piece) {
      forms.scriptData ||= nested.scriptData
      for (const name of nested.interpreters) if (!forms.interpreters.includes(name)) forms.interpreters.push(name)
    }
    return nested
  }
  for (const group of inner.groups) {
    if (budget.spent) break
    if (group.command.length > 0) {
      const nested = read(group.command, { statement: true, heredoc: group.heredoc })
      if (nested === null) break
      if (nested.rereads) continue
    }
    // Split and read only now: a statement that reads its own text again has covered its pieces.
    for (const piece of statementPieces(group.statement)) {
      const form = budget.spent ? null : statementForm(piece, budget)
      if (form === null) break
      if (form.words.length > 0) read(form.words, { statement: true, heredoc: form.heredoc }, true)
    }
  }
  forms.overBudget = budget.spent
  return forms
}

/**
 * Programs whose code Buckle cannot read as shell (owner decision D55): each name, alone or with a version
 * (`python3`, `python3.12`, `node22`, `perl5.36`). A policy names the ones it reads as ordinary commands.
 */
const INTERPRETER = /^(?:python|node|nodejs|deno|bun|perl|ruby|php)(?:\d+(?:\.\d+)*)?$/

/** Whether a program name is an interpreter Buckle reads as unknown unless a policy allows it. */
export function isInterpreter(name: string): boolean {
  return INTERPRETER.test(name)
}

/** The one argument with which each interpreter only prints its version or its help and runs no code. */
const INTERPRETER_INFO: Readonly<Record<string, ReadonlySet<string>>> = {
  python: new Set(['--version', '-V', '--help', '-h']),
  node: new Set(['--version', '-v', '--help', '-h']),
  nodejs: new Set(['--version', '-v', '--help', '-h']),
  deno: new Set(['--version', '-V', '--help', '-h']),
  bun: new Set(['--version', '-v', '--help', '-h']),
  perl: new Set(['--version', '-v', '--help', '-h']),
  ruby: new Set(['--version', '--help', '-h']),
  php: new Set(['--version', '-v', '--help', '-h']),
}

/**
 * The interpreter the command a chain ends in runs code with, or null (owner decision D55): any call of one with inline
 * code (`-c`, `-e`, `--eval`, `-r`, `-p`), a script, `-m`, or any other argument, and one behind xargs, whose items
 * become its code or its script. Its version or its help alone runs nothing; nor does a bare interpreter as the call
 * itself, whose input is empty. In shell text a bare interpreter reads code from its input, a pipe, a redirection,
 * or a heredoc Buckle cannot read as shell, so it runs code too.
 */
function interpreterRunningCode(chain: readonly string[][], place: Place): string | null {
  const [command = '', ...args] = chain.at(-1)!
  if (!INTERPRETER.test(command)) return null
  if (chain.some(form => form[0] === 'xargs')) return command
  if (args.length === 1 && INTERPRETER_INFO[command.replace(/[\d.]+$/, '')]?.has(args[0]!)) return null
  return args.length === 0 && !place.statement ? null : command
}

/** `source file` and `. file`, which run a script in the shell that reads them. */
const SOURCE_COMMANDS = new Set(['source', '.'])

/**
 * Whether the command a chain ends in runs a script that arrives as data, which no reading can see: a shell or `source`
 * behind xargs, which hands it the items it reads; a shell's `-c` with no command string; and, in shell text, a shell
 * that reads its script from its input (no script operand, `-s`, `-`, or /dev/stdin) or a `source` of its input or of
 * a process substitution, unless a heredoc on its own statement feeds that input. The input may be a pipe, a
 * redirection, or the input of a pipeline around the statement, so the place decides, not a `|` before it. The call
 * itself (`bash` with no operand) reads the input Buckle's exec leaves empty.
 */
function scriptArrivesAsData(chain: readonly string[][], place: Place): boolean {
  const [command = '', ...args] = chain.at(-1)!
  const fromInput = place.statement && !place.heredoc
  if (SHELL_COMMANDS.has(command)) {
    if (chain.some(form => form[0] === 'xargs')) return true
    const source = shellScriptSource(args)
    return source === 'missingCommand' || (source === 'input' && fromInput)
  }
  if (SOURCE_COMMANDS.has(command)) {
    if (chain.some(form => form[0] === 'xargs')) return true
    const file = args[0] === '--' ? args[1] : args[0]
    return fromInput && (file === undefined || INPUT_PATHS.has(file))
  }
  return false
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

/**
 * A command a statement runs, the statement as written, whose pieces are read too unless the command reads its own text
 * again, and whether a heredoc on the statement feeds the command's input.
 */
interface CommandGroup { command: string[]; statement: string; heredoc: boolean }

interface InnerCommands { groups: CommandGroup[]; unknownEval: boolean; unread: UnreadLimit | null; rereads: boolean }

/**
 * The commands a command runs inside itself: each statement of a shell's script body, of eval's text, of the remote
 * command ssh sends and of each command setting ssh runs here, each find -exec command, and the shell su runs.
 */
function innerCommands(runs: readonly string[], budget: Budget): InnerCommands {
  const [command = '', ...args] = runs
  if (command === 'ssh') return sshCommands(args, budget)
  if (command === 'su') return suCommands(args)
  if (command === 'find') {
    const found = findCommands(args)
    return { groups: found.commands.map(form => ({ command: form, statement: '', heredoc: false })), unknownEval: false, unread: found.primary ? 'findPrimary' : null, rereads: found.commands.length > 0 }
  }
  if (command === 'eval') {
    // eval joins its words with spaces and runs the result as shell text; one leading `--` ends its options (slice 7b review W7B-2).
    const text = (args[0] === '--' ? args.slice(1) : args).join(' ')
    return { ...textCommands(text, budget), unknownEval: UNKNOWN_TEXT.test(text) || text.trim() === '', rereads: true }
  }
  if (!SHELL_COMMANDS.has(command)) return { groups: [], unknownEval: false, unread: null, rereads: false }
  return { ...textCommands(parseArgv(command, args).positionals.join('\n'), budget), unknownEval: false, rereads: true }
}

/**
 * What an ssh call runs: the statements of its remote command, which the remote shell parses from the words after the
 * host joined with spaces, and of each ProxyCommand, LocalCommand or KnownHostsCommand it runs here; a host with no
 * command opens an interactive session, which is unread.
 */
function sshCommands(args: readonly string[], budget: Budget): InnerCommands {
  const ssh = sshInvocation(args)
  const groups: CommandGroup[] = []
  let unread: UnreadLimit | null = ssh.session ? 'session' : null
  for (const text of [...ssh.remote, ...ssh.local]) {
    const read = textCommands(text, budget)
    groups.push(...read.groups)
    unread = firstLimit(unread, read.unread)
  }
  return { groups, unknownEval: false, unread, rereads: true }
}

/**
 * What a su call runs: the shell (its -s value, or the user's login shell read as `sh`) with each -c string, or, with
 * none, with the words after the user; with neither it opens an interactive session, which is unread.
 */
function suCommands(args: readonly string[]): InnerCommands {
  const su = suInvocation(args)
  const shell = su.shell ?? 'sh'
  const commands = su.commands.length > 0 ? su.commands.map(text => [shell, '-c', text]) : su.operands.length > 0 ? [[shell, ...su.operands]] : []
  return { groups: commands.map(form => ({ command: form, statement: '', heredoc: false })), unknownEval: false, unread: su.session ? 'session' : null, rereads: true }
}

/** The commands of shell text, within the budget: each statement's form, beside the statement as written. */
function textCommands(text: string, budget: Budget): { groups: CommandGroup[]; unread: UnreadLimit | null } {
  budget.characters -= text.length
  if (budget.characters < 0) {
    budget.spent = true
    return { groups: [], unread: null }
  }
  const { statements, deep, overDepth } = shellStatementList(text)
  const groups: CommandGroup[] = []
  for (const statement of statements) {
    const form = statementForm(statement, budget)
    if (form === null) break
    groups.push({ command: form.words, statement, heredoc: form.heredoc })
  }
  return { groups, unread: overDepth ? 'depth' : deep ? 'substitutions' : null }
}

/**
 * Each `-exec`, `-execdir`, `-ok` or `-okdir` command, up to the `;` or the `{} +` that ends it, or to the end. A
 * primary's value is skipped, so `-name -exec` names a file; a command whose first word is itself a primary is not
 * one find would run as written, so it is called unread (slice 7b review W7B-6).
 */
function findCommands(args: readonly string[]): { commands: string[][]; primary: boolean } {
  const commands: string[][] = []
  let primary = false
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
      if (FIND_PRIMARY.test(args[index + 1]!)) primary = true
      else commands.push(args.slice(index + 1, end))
    }
    index = end
  }
  return { commands, primary }
}

function wrapperChain(words: readonly string[]): { chain: string[][]; unread: UnreadLimit | null } {
  const chain = [reduced(words)]
  let current = words
  for (let depth = 0; ; depth++) {
    const inner = unwrapped(current)
    if (inner === undefined) return { chain, unread: null }
    if (depth >= MAX_DEPTH) return { chain, unread: 'depth' }
    if (inner === 'session') return { chain, unread: 'session' }
    if (!inner?.[0]) return { chain, unread: null }
    current = inner
    chain.push(reduced(current))
  }
}

/**
 * What the first words run: past NAME=value assignments, a wrapper's options, a shell keyword, `function NAME` or
 * `coproc [NAME]` (slice 7b review W7B-3). Undefined when the first word is none of those, null when nothing runs,
 * 'session' when the wrapper opens an interactive session.
 */
function unwrapped(words: readonly string[]): string[] | null | undefined | 'session' {
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

/**
 * The command a wrapper runs, read past its options, assignments and operands; null when it runs none, and 'session'
 * when it runs none but an option opens an interactive session (`sudo -i`).
 */
function innerCommand(wrapper: Wrapper, args: readonly string[]): string[] | null | 'session' {
  const words = [...args]
  let index = 0
  let session = false
  while (index < words.length) {
    const word = words[index]!
    if (word === '--') {
      index++
      break
    }
    if (word === '-' && wrapper.dashOption) {
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
    session ||= option.session === true
    index = option.next
    if (option.split !== undefined) words.splice(index, 0, ...shellWords(option.split))
  }
  if (wrapper.assignments) while (index < words.length && words[index]!.includes('=')) index++
  index += wrapper.operands ?? 0
  if (wrapper.shellCommand?.includes(words[index] ?? '')) return index + 1 < words.length ? ['sh', '-c', words[index + 1]!] : null
  if (index < words.length) return words.slice(index)
  return session ? 'session' : null
}

interface ReadOption { next: number; runsNothing?: true; split?: string; session?: true }

/**
 * A long option as getopt_long matches it: a name typed whole is that option (`sudo --login` opens a session, though
 * `login-class` takes a value), and any other typed name the option it begins.
 */
function readLong(wrapper: Wrapper, words: readonly string[], index: number): ReadOption {
  const word = words[index]!
  const separator = word.indexOf('=')
  const typed = separator === -1 ? word.slice(2) : word.slice(2, separator)
  const begins = (name: string) => typed.length > 0 && name.startsWith(typed)
  if (wrapper.runsNothing?.long.includes(typed)) return { next: index + 1, runsNothing: true }
  if (wrapper.session?.long.includes(typed)) return { next: index + 1, session: true }
  const exact = wrapper.longValues?.includes(typed) ? typed : undefined
  if (exact === undefined && wrapper.runsNothing?.long.some(begins)) return { next: index + 1, runsNothing: true }
  const name = exact ?? wrapper.longValues?.find(begins)
  if (name === undefined) return wrapper.session?.long.some(begins) ? { next: index + 1, session: true } : { next: index + 1 }
  const value = separator === -1 ? words[index + 1] : word.slice(separator + 1)
  const next = separator === -1 ? index + 2 : index + 1
  return name === wrapper.split?.long && value !== undefined ? { next, split: value } : { next }
}

function readShort(wrapper: Wrapper, words: readonly string[], index: number): ReadOption {
  const word = words[index]!
  let session = false
  for (let offset = 1; offset < word.length; offset++) {
    const character = word.charAt(offset)
    if (wrapper.runsNothing?.short.includes(character)) return { next: index + 1, runsNothing: true }
    session ||= wrapper.session?.short.includes(character) === true
    if (wrapper.shortOptional?.includes(character)) return { next: index + 1, ...(session ? { session: true } : {}) }
    if (!wrapper.shortValues?.includes(character)) continue
    const attached = word.slice(offset + 1)
    const value = attached.length > 0 ? attached : words[index + 1]
    const next = attached.length > 0 ? index + 1 : index + 2
    if (character === wrapper.split?.short && value !== undefined) return { next, split: value }
    return { next, ...(session ? { session: true } : {}) }
  }
  return { next: index + 1, ...(session ? { session: true } : {}) }
}

/** A redirection of a statement's input (`<file`, `0<<<text`, `<&3`); STDIN_HEREDOC when it is a heredoc. */
const STDIN_REDIRECTION = /^0?</
const STDIN_HEREDOC = /^0?<<(?!<)/

/**
 * A statement's words without its redirections, so `make > /dev/null` is judged as `make`. Only an unquoted
 * operator redirects: `git clean -e '>' -f` hands git a `>` and keeps its `-f` (slice 7 review F2). `heredoc` says
 * the last redirection of its input is a heredoc, which Buckle reads. Null when the budget's words ran out before the
 * statement was read whole.
 */
function statementForm(statement: string, budget: Budget): { words: string[]; heredoc: boolean } | null {
  const { tokens, more } = shellTokensUpTo(statement, Math.max(0, budget.words))
  budget.words -= tokens.length
  if (more) {
    budget.spent = true
    return null
  }
  const words: string[] = []
  let heredoc = false
  for (let index = 0; index < tokens.length; index++) {
    const { raw, word } = tokens[index]!
    if (!REDIRECTION.test(raw)) {
      words.push(word)
      continue
    }
    if (STDIN_REDIRECTION.test(raw)) heredoc = STDIN_HEREDOC.test(raw)
    if (BARE_REDIRECTION.test(raw)) index++
  }
  return { words, heredoc }
}
