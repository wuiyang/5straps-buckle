import { baseCommand, envSplitWords, holdsExpansion, MAX_DEPTH, MAX_SUBSTITUTIONS, parseArgv, readsAsItself, scriptOperandKind, SHELL_COMMANDS, shellScriptOperand, shellStatementList, shellTokensUpTo, shellWords, sshInvocation, statementPieces, suInvocation } from './argv.js'

/**
 * What one reading of a call takes in across every nesting level before it stops and asks (slice 7b review W7B-1,
 * W7B-8): the characters of shell text it passes over, each re-reading of a line, a heredoc body, or a backtick body
 * counted again (slice 7l), the words of the statements it splits, and the commands it keeps. A 1 MB request read
 * as a few passes at a few levels fits; whatever runs past the budget is unread.
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
  comment: 'A # follows a ) that a case pattern or an extended glob may have closed, so Buckle cannot tell whether the rest of the line is a comment (comment)',
  session: 'Opens an interactive session Buckle cannot read: ssh or su with no command, or a sudo or doas shell (interactive session)',
  expansion: 'Runs shell text an expansion supplies, which exists only once the shell has run (eval "$x", bash -c "$(...)"), so Buckle cannot read it (expansion)',
  ownParsing: 'A program reads an argument by rules of its own that Buckle does not read as shell words: an env -S escape, an ssh % token, or a sudo -s or -i command for a shell Buckle does not know (own parsing)',
  scriptData: 'A shell takes its script from a pipe, a redirection, a descriptor, xargs, or find, so the script arrives as data, which Buckle cannot read (script as data)',
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
  /** An option whose value is split into words and read in its place (`env -S 'git push --force'`), as splitValue reads it. */
  split?: { short: string; long: string }
  /**
   * With a command, a session option hands it to a shell as one string, each character but a letter, a digit, `_`, `-`,
   * and `$` escaped with a backslash (sudo -s and -i, as the sudo manual says), as shellSessionCommand reads it.
   */
  sessionShell?: true
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
    sessionShell: true,
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
   * MAX_SUBSTITUTIONS, a find -exec command that is a primary, a `#` Buckle cannot place, an interactive session, or
   * shell text an expansion supplies; the first in READ_LIMITS order when several were met.
   */
  unread: UnreadLimit | null
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
 * pipeline around it; `heredoc` when a heredoc on that statement feeds its input, which Buckle reads. `expanded` holds
 * the words of the statement that an expansion supplies (holdsExpansion), whose value Buckle cannot know, and `found`
 * says find runs the words, putting a file name in place of each `{}`.
 */
interface Place { statement: boolean; heredoc: boolean; expanded: ReadonlySet<string>; found: boolean }
const NO_WORDS: ReadonlySet<string> = new Set()
const CALL: Place = { statement: false, heredoc: false, expanded: NO_WORDS, found: false }

/**
 * `words` as written: the command word is reduced to its basename only after an assignment prefix is read. Each
 * statement of an inner text is read, and its pieces too unless the statement reads its own text again (eval, a
 * shell, find -exec), which covers them, so no text is read twice per level (slice 7b review W7B-1). A piece is a
 * split no shell makes, read only so a glob meets a command quoted for another program, so it marks no script as data.
 */
function formsOf(words: readonly string[], depth: number, budget: Budget, place: Place): Reading {
  const { chain, unread } = wrapperChain(words, place.expanded)
  const inner = innerCommands(chain.at(-1)!, budget, place)
  const interpreter = interpreterRunningCode(chain, place)
  const forms: Reading = { chain, nested: [], unread: firstLimit(unread, inner.unread), overBudget: false, scriptData: scriptArrivesAsData(chain, place), interpreters: interpreter ? [interpreter] : [], rereads: inner.rereads }
  const read = (command: string[], at: Place, piece = false): Reading | null => {
    if (depth >= MAX_DEPTH) {
      forms.unread = 'depth'
      return null
    }
    const nested = formsOf(command, depth + 1, budget, at)
    keep(forms.nested, nested.chain, budget)
    keep(forms.nested, nested.nested, budget)
    forms.unread = firstLimit(forms.unread, nested.unread)
    if (!piece) {
      forms.scriptData ||= nested.scriptData
      for (const name of nested.interpreters) if (!forms.interpreters.includes(name)) forms.interpreters.push(name)
    }
    return nested
  }
  for (const group of inner.groups) {
    if (budget.spent) break
    if (group.command.length > 0) {
      const nested = read(group.command, { statement: true, heredoc: group.heredoc, expanded: group.expanded, found: group.found })
      if (nested === null) break
      if (nested.rereads) continue
    }
    // Split and read only now: a statement that reads its own text again has covered its pieces.
    for (const piece of statementPieces(group.statement)) {
      const form = budget.spent ? null : statementForm(piece, budget)
      if (form === null) break
      if (form.words.length > 0) read(form.words, { statement: true, heredoc: form.heredoc, expanded: form.expanded, found: false }, true)
    }
  }
  forms.overBudget = budget.spent
  return forms
}

/** CPython and PyPy, whose names may carry a build suffix (PYTHON_BUILD). */
const PYTHONS: readonly string[] = ['python', 'pypy']

/**
 * Programs whose code Buckle cannot read as shell (owner decision D55): each name, alone or with a version
 * (`python3`, `python3.12`, `node22`, `perl5.36`, `lua5.4`). A policy names the ones it reads as ordinary commands.
 * awk and its variants, lua, PowerShell, and the TypeScript runners joined in slice 7j (default D57); the package
 * runners npx, pnpx, and bunx stay ordinary commands until the owner rules on them (D57 open). Slice 7l adds PyPy, the
 * C shells, whose syntax is not the POSIX shell's, and busybox, whose shell applet may be ash or hush.
 */
const INTERPRETERS = [...PYTHONS, 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'awk', 'gawk', 'mawk', 'nawk', 'lua', 'luajit', 'pwsh', 'powershell', 'tsx', 'ts-node', 'tcsh', 'csh', 'busybox'] as const
/**
 * The CPython builds' names carry a build suffix after the version: `t` for the free-threaded build (python3.13t), `d`
 * for a debug build, and Debian's `-dbg`; PyPy installs as pypy and pypy3.
 */
const PYTHON_BUILD = '(?:t|d|td)?(?:-dbg)?'
const INTERPRETER = new RegExp(`^(?:(${PYTHONS.join('|')})(?:\\d+(?:\\.\\d+)*)?${PYTHON_BUILD}|(${INTERPRETERS.filter(name => !PYTHONS.includes(name)).join('|')})(?:\\d+(?:\\.\\d+)*)?)$`)

/** The interpreter names as a refusal of an unknown one lists them, wherever a name is checked. */
export const INTERPRETER_NAMES = `${INTERPRETERS.slice(0, -1).join(', ')}, or ${INTERPRETERS.at(-1)}, with a version where the program has one (python3.12), and for python a build suffix (python3.13t, python3-dbg)`

/** Whether a program name is an interpreter Buckle reads as unknown unless a policy allows it. */
export function isInterpreter(name: string): boolean {
  return INTERPRETER.test(name)
}

/** The program an interpreter name runs, its version and build suffix dropped (`python3.13t` is python), or null for none. */
function interpreterProgram(name: string): string | null {
  const match = INTERPRETER.exec(name)
  return match ? match[1] ?? match[2]! : null
}

/** The busybox applets that are a shell: a call of one runs shell text in busybox's own shell, which Buckle does not read. */
const BUSYBOX_SHELLS = new Set(['sh', 'ash', 'hush', 'bash'])

/** awk's version and help calls across gawk, mawk (`-W version`), and the one true awk (`-version`). */
const AWK_INFO: ReadonlySet<string> = new Set(['--version', '-V', '-version', '-Wversion', '-Wv', '-W version', '--help', '-h', '--usage', '-Wusage', '-W usage'])
/** PowerShell's, matched without case, as PowerShell reads its parameters. */
const POWERSHELL_INFO: ReadonlySet<string> = new Set(['-version', '-v', '--version', '-help', '-h', '-?', '/?', '--help'])
const CASELESS_INFO = new Set(['pwsh', 'powershell'])

/**
 * The arguments, one word or mawk's two (`-W version`), with which each interpreter only prints its version or its help
 * and runs no code. lua and luajit print their version with -v and run nothing after it, not even their input.
 */
const INTERPRETER_INFO: Readonly<Record<string, ReadonlySet<string>>> = {
  python: new Set(['--version', '-V', '--help', '-h']),
  pypy: new Set(['--version', '-V', '--help', '-h']),
  node: new Set(['--version', '-v', '--help', '-h']),
  nodejs: new Set(['--version', '-v', '--help', '-h']),
  deno: new Set(['--version', '-V', '--help', '-h']),
  bun: new Set(['--version', '-v', '--help', '-h']),
  perl: new Set(['--version', '-v', '--help', '-h']),
  ruby: new Set(['--version', '--help', '-h']),
  php: new Set(['--version', '-v', '--help', '-h']),
  awk: AWK_INFO,
  gawk: AWK_INFO,
  mawk: AWK_INFO,
  nawk: AWK_INFO,
  lua: new Set(['-v']),
  luajit: new Set(['-v']),
  pwsh: POWERSHELL_INFO,
  powershell: POWERSHELL_INFO,
  tsx: new Set(['--version', '-v', '--help', '-h']),
  'ts-node': new Set(['--version', '-v', '--help', '-h']),
  tcsh: new Set(['--version', '--help']),
  csh: new Set(),
  busybox: new Set(['--help', '--list', '--list-full']),
}

/** Whether these arguments only print the interpreter's version or its help. */
function printsInfo(command: string, args: readonly string[]): boolean {
  const program = interpreterProgram(command) ?? command
  const typed = args.join(' ')
  return args.length > 0 && args.length <= 2 && INTERPRETER_INFO[program]?.has(CASELESS_INFO.has(program) ? typed.toLowerCase() : typed) === true
}

/**
 * The interpreter the command a chain ends in runs code with, or null (owner decision D55): any call of one with inline
 * code (`-c`, `-e`, `--eval`, `-r`, `-p`, pwsh's `-Command`), a script, `-m`, awk's program or `-f`, or any other
 * argument, and one behind xargs, whose items become its code or its script. Its version or its help alone runs
 * nothing; nor does a bare interpreter as the call itself, whose input is empty. In shell text a bare interpreter
 * reads code from its input, a pipe, a redirection, or a heredoc Buckle cannot read as shell, so it runs code too.
 */
function interpreterRunningCode(chain: readonly string[][], place: Place): string | null {
  const [command = '', ...args] = chain.at(-1)!
  if (!INTERPRETER.test(command)) return null
  if (chain.some(form => form[0] === 'xargs')) return command
  if (printsInfo(command, args)) return null
  // busybox runs code Buckle cannot read only through a shell applet; its other applets are judged by their own words.
  if (command === 'busybox') return BUSYBOX_SHELLS.has(baseCommand(args[0] ?? '')) ? command : null
  return args.length === 0 && !place.statement ? null : command
}

/** `source file` and `. file`, which run a script in the shell that reads them. */
const SOURCE_COMMANDS = new Set(['source', '.'])

/**
 * Whether the command a chain ends in runs a script that arrives as data, which no reading can see: a shell or `source`
 * behind xargs, which hands it the items it reads; a shell's `-c` with no command string; a shell or `source` whose
 * script operand names another descriptor or a device (`/dev/fd/3`, `/proc/self/fd/3`), however the path is spelled
 * (scriptOperandKind); one find runs whose script string or operand holds `{}`, which find replaces with a file name;
 * and, in shell text, a shell that reads its script from its input (no script operand, `-s`, `-`, or a path naming its
 * own input such as `//dev/stdin` or /proc/thread-self/fd/0) or a `source` of its input or of a process substitution,
 * unless a heredoc on its own statement feeds that input. The input may be a pipe, a redirection, or the input of a
 * pipeline around the statement, so the place decides, not a `|` before it. The call itself (`bash` with no operand)
 * reads the input Buckle's exec leaves empty.
 */
function scriptArrivesAsData(chain: readonly string[][], place: Place): boolean {
  const [command = '', ...args] = chain.at(-1)!
  const fromInput = place.statement && !place.heredoc
  if (SHELL_COMMANDS.has(command)) {
    if (chain.some(form => form[0] === 'xargs')) return true
    const { source, operand } = shellScriptOperand(args)
    if (place.found && operand?.includes('{}')) return true
    return source === 'missingCommand' || source === 'descriptor' || (source === 'input' && fromInput)
  }
  if (SOURCE_COMMANDS.has(command)) {
    if (chain.some(form => form[0] === 'xargs')) return true
    const file = args[0] === '--' ? args[1] : args[0]
    if (file === undefined) return fromInput
    if (place.found && file.includes('{}')) return true
    const kind = scriptOperandKind(file)
    return kind === 'descriptor' || (kind === 'input' && fromInput)
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
 * again, whether a heredoc on the statement feeds the command's input, the words an expansion supplies (Place), and
 * whether find runs the command.
 */
interface CommandGroup { command: string[]; statement: string; heredoc: boolean; expanded: ReadonlySet<string>; found: boolean }

interface InnerCommands { groups: CommandGroup[]; unread: UnreadLimit | null; rereads: boolean }

/** Commands a command runs whose words come from the statement around it (find -exec, su), keeping what the place knows of them. */
const groupsOf = (commands: readonly string[][], place: Place, found: boolean): CommandGroup[] =>
  commands.map(command => ({ command: [...command], statement: '', heredoc: false, expanded: place.expanded, found }))

/**
 * The commands a command runs inside itself: each statement of a shell's script body, of eval's text, of the remote
 * command ssh sends and of each command setting ssh runs here, each find -exec command, and the shell su runs. Text an
 * expansion supplies, eval's when it holds a `$` or a backtick (`eval "$x"`) or is empty, a shell's -c string that is an
 * expansion (`bash -c "$(...)"`, `sh -c "$x"`), or a remote command word ssh sends that is one, only exists once the
 * shell has run, so the call is unread (READ_LIMITS.expansion).
 */
function innerCommands(runs: readonly string[], budget: Budget, place: Place): InnerCommands {
  const [command = '', ...args] = runs
  if (command === 'ssh') return sshCommands(args, budget, place)
  if (command === 'su') return suCommands(args, place)
  if (command === 'find') {
    const found = findCommands(args)
    return { groups: groupsOf(found.commands, place, true), unread: found.primary ? 'findPrimary' : null, rereads: found.commands.length > 0 }
  }
  if (command === 'eval') {
    // eval joins its words with spaces and runs the result as shell text; one leading `--` ends its options (slice 7b review W7B-2).
    const text = (args[0] === '--' ? args.slice(1) : args).join(' ')
    const read = textCommands(text, budget)
    return { groups: read.groups, unread: UNKNOWN_TEXT.test(text) || text.trim() === '' ? firstLimit(read.unread, 'expansion') : read.unread, rereads: true }
  }
  if (!SHELL_COMMANDS.has(command)) return { groups: [], unread: null, rereads: false }
  const read = textCommands(parseArgv(command, args).positionals.join('\n'), budget)
  const { source, operand } = shellScriptOperand(args)
  const expanded = source === 'command' && operand !== undefined && place.expanded.has(operand)
  return { groups: read.groups, unread: expanded ? firstLimit(read.unread, 'expansion') : read.unread, rereads: true }
}

/**
 * What an ssh call runs: the statements of its remote command, which the remote shell parses from the words after the
 * host joined with spaces, and of each ProxyCommand, LocalCommand or KnownHostsCommand it runs here; a host with no
 * command opens an interactive session, which is unread, and so is a remote command word an expansion supplies.
 */
function sshCommands(args: readonly string[], budget: Budget, place: Place): InnerCommands {
  const ssh = sshInvocation(args)
  const groups: CommandGroup[] = []
  let unread: UnreadLimit | null = ssh.session ? 'session' : null
  if ([...ssh.words, ...ssh.settings].some(word => place.expanded.has(word))) unread = firstLimit(unread, 'expansion')
  if (ssh.tokens) unread = firstLimit(unread, 'ownParsing')
  for (const text of [...ssh.remote, ...ssh.local]) {
    const read = textCommands(text, budget)
    groups.push(...read.groups)
    unread = firstLimit(unread, read.unread)
  }
  return { groups, unread, rereads: true }
}

/**
 * What a su call runs: the shell (its -s value, or the user's login shell read as `sh`) with each -c string, or, with
 * none, with the words after the user; with neither it opens an interactive session, which is unread.
 */
function suCommands(args: readonly string[], place: Place): InnerCommands {
  const su = suInvocation(args)
  const shell = su.shell ?? 'sh'
  const commands = su.commands.length > 0 ? su.commands.map(text => [shell, '-c', text]) : su.operands.length > 0 ? [[shell, ...su.operands]] : []
  return { groups: groupsOf(commands, place, place.found), unread: su.session ? 'session' : null, rereads: true }
}

/**
 * The commands of shell text, within the budget: each statement's form, beside the statement as written. Every pass the
 * splitter makes over the text and the bodies in it is charged to the budget's characters (shellStatementList), and
 * past it the text is unread.
 */
function textCommands(text: string, budget: Budget): { groups: CommandGroup[]; unread: UnreadLimit | null } {
  if (budget.characters < text.length) {
    budget.characters -= text.length
    budget.spent = true
    return { groups: [], unread: null }
  }
  const meter = { characters: budget.characters }
  const { statements, deep, overDepth, unsureComment, overBudget } = shellStatementList(text, meter)
  budget.characters = meter.characters
  const groups: CommandGroup[] = []
  // Past the budget no form is read (formsOf stops at a spent budget), so the statements are not split into words.
  if (overBudget) {
    budget.spent = true
    return { groups, unread: null }
  }
  for (const statement of statements) {
    const form = statementForm(statement, budget)
    if (form === null) break
    groups.push({ command: form.words, statement, heredoc: form.heredoc, expanded: form.expanded, found: false })
  }
  return { groups, unread: overDepth ? 'depth' : deep ? 'substitutions' : unsureComment ? 'comment' : null }
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

/** The words `expanded` names are those an expansion supplies (Place), whose value Buckle cannot know. */
function wrapperChain(words: readonly string[], expanded: ReadonlySet<string>): { chain: string[][]; unread: UnreadLimit | null } {
  const chain = [reduced(words)]
  let current = words
  let unread: UnreadLimit | null = null
  for (let depth = 0; ; depth++) {
    const inner = unwrapped(current, expanded)
    if (inner === undefined) return { chain, unread }
    if (depth >= MAX_DEPTH) return { chain, unread: 'depth' }
    unread = firstLimit(unread, inner.unread)
    if (inner.command === 'session') return { chain, unread: firstLimit(unread, 'session') }
    if (!inner.command?.[0]) return { chain, unread }
    current = inner.command
    chain.push(reduced(current))
  }
}

/** What a prefix runs (null for nothing, 'session' for an interactive session) and why part of it was left unread. */
interface Unwrapped { command: string[] | null | 'session'; unread: UnreadLimit | null }

/**
 * What the first words run: past NAME=value assignments, a wrapper's options, a shell keyword, `function NAME` or
 * `coproc [NAME]` (slice 7b review W7B-3). Undefined when the first word is none of those.
 */
function unwrapped(words: readonly string[], expanded: ReadonlySet<string>): Unwrapped | undefined {
  const runs = (command: string[] | null): Unwrapped => ({ command, unread: null })
  if (ASSIGNMENT.test(words[0] ?? '')) {
    const command = words.findIndex(word => !ASSIGNMENT.test(word))
    return runs(command < 0 ? null : words.slice(command))
  }
  if (words[0] === 'function') return runs(words.length > 2 ? words.slice(2) : null)
  if (words[0] === 'coproc') return runs(COMPOUND_START.has(words[2] ?? '') ? words.slice(2) : words.length > 1 ? words.slice(1) : null)
  const wrapper = wrapperOf(baseCommand(words[0] ?? ''))
  return wrapper === undefined ? undefined : innerCommand(wrapper, words.slice(1), expanded)
}

/**
 * An env -S value as words. With no backslash and no `${`, GNU env splits it as envSplitWords reads it, exactly. A
 * backslash starts one of env's own escapes (`\_` separates words, `\c` ends the string) and `${` expands a variable,
 * so such a value is unread (own parsing), and so is one an expansion supplies; either is still split as shell words,
 * so a deny glob may yet name what it meets.
 */
function splitValue(value: string, expanded: ReadonlySet<string>): { words: string[]; unread: UnreadLimit | null } {
  if (value.includes('\\') || value.includes('${')) return { words: shellWords(value), unread: 'ownParsing' }
  if (expanded.has(value)) return { words: shellWords(value), unread: 'expansion' }
  return { words: envSplitWords(value), unread: null }
}

/**
 * The command sudo -s or -i hands the target shell: sudo escapes every character of each word but a letter, a digit,
 * `_`, `-`, and `$`, and joins the words with spaces, so an empty word is no word and each other word stays whole. That
 * shell is whatever $SHELL or the password database names, which Buckle cannot know, and a newline becomes a
 * continuation in a POSIX shell and a blank in a C shell, while a `$` expands. A command whose words all read as
 * themselves in any shell (readsAsItself) is read as those words; any other is unread (own parsing), and still read.
 */
function shellSessionCommand(words: readonly string[]): Unwrapped {
  const command = words.filter(word => word !== '')
  if (command.length === 0) return { command: null, unread: null }
  return { command, unread: command.every(readsAsItself) ? null : 'ownParsing' }
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
function innerCommand(wrapper: Wrapper, args: readonly string[], expanded: ReadonlySet<string>): Unwrapped {
  const words = [...args]
  let index = 0
  let session = false
  let unread: UnreadLimit | null = null
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
    if (option.runsNothing) return { command: null, unread }
    session ||= option.session === true
    index = option.next
    if (option.split !== undefined) {
      const split = splitValue(option.split, expanded)
      words.splice(index, 0, ...split.words)
      unread = firstLimit(unread, split.unread)
    }
  }
  if (wrapper.assignments) while (index < words.length && words[index]!.includes('=')) index++
  index += wrapper.operands ?? 0
  if (wrapper.shellCommand?.includes(words[index] ?? '')) return { command: index + 1 < words.length ? ['sh', '-c', words[index + 1]!] : null, unread }
  if (index < words.length && session && wrapper.sessionShell) {
    const shell = shellSessionCommand(words.slice(index))
    return { command: shell.command, unread: firstLimit(unread, shell.unread) }
  }
  if (index < words.length) return { command: words.slice(index), unread }
  return { command: session ? 'session' : null, unread }
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
function statementForm(statement: string, budget: Budget): { words: string[]; heredoc: boolean; expanded: ReadonlySet<string> } | null {
  const { tokens, more } = shellTokensUpTo(statement, Math.max(0, budget.words))
  budget.words -= tokens.length
  if (more) {
    budget.spent = true
    return null
  }
  const words: string[] = []
  let heredoc = false
  let expanded: Set<string> | null = null
  for (let index = 0; index < tokens.length; index++) {
    const { raw, word } = tokens[index]!
    if (!REDIRECTION.test(raw)) {
      words.push(word)
      if (holdsExpansion(raw)) (expanded ??= new Set()).add(word)
      continue
    }
    if (STDIN_REDIRECTION.test(raw)) heredoc = STDIN_HEREDOC.test(raw)
    if (BARE_REDIRECTION.test(raw)) index++
  }
  return { words, heredoc, expanded: expanded ?? NO_WORDS }
}
