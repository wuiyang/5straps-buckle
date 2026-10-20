import { baseCommand, envSplitWords, expansionShape, type ExpansionShape, holdsExpansion, type LeadingWord, MAX_DEPTH, MAX_SUBSTITUTIONS, parseArgv, readsAsItself, scriptOperandKind, SHELL_COMMANDS, shellLeadingWords, shellScriptOperand, shellStartupFiles, shellStatementList, type ShellToken, shellTokens, shellTokensUpTo, shellWords, sshInvocation, statementPieces, suInvocation } from './argv.js'

/**
 * What one reading of a call takes in across every nesting level before it stops and asks (slice 7b review W7B-1,
 * W7B-8): the characters of shell text it passes over, each re-reading of a line, a heredoc body, or a backtick body
 * counted again, so nested bodies cannot multiply the work unseen, the words of the statements it splits, and the commands it keeps. A 1 MB request read
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
  expansion: 'Runs a command word or shell text an expansion supplies, or a command an expansion among a wrapper\'s own words may move, which exists only once the shell has run ($cmd args, eval "$x", bash -c "$(...)", timeout $t cmd), so Buckle cannot read it (expansion)',
  ownParsing: 'A program reads an argument by rules of its own that Buckle does not read as shell words: an env -S escape, an ssh % token, or a sudo -s or -i command for a shell Buckle does not know (own parsing)',
  scriptData: 'A shell takes its script, or a startup file it runs first, from a pipe, a redirection, a descriptor, an expansion, xargs, or find, so the script arrives as data, which Buckle cannot read (script as data)',
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
  /**
   * The operand is a number that may be left out, so a word that is no number is the command: chrt from util-linux 2.41
   * runs `chrt -o cmd` with the policy's default priority (an older chrt refuses it, so reading cmd there reads more).
   */
  numericOperand?: true
  /**
   * A multi-call binary (busybox, toybox) that runs the applet its first operand names with the words after it; a shell
   * applet is an interpreter Buckle does not read as bash (MULTICALL_SHELLS), so the chain ends at the binary.
   */
  applets?: true
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
  /** Short options whose value is a string replaced in the command's words (`xargs -I X`), so it changes what runs. */
  replaces?: string
}

/**
 * The prefixes that run another command, a finite table (the continuation review, "Seen outside this range": `env
 * git push --force` passed the destructive floor and the command policy; slice 7 review F1; owner decision D25,
 * default (a)). Their option tables follow each program's getopt string (coreutils env, nice, nohup, timeout and
 * stdbuf; GNU time; findutils xargs; util-linux ionice, chrt, setsid and flock; sudo 1.9 and OpenDoas; the shell's
 * `command`, `exec` and `builtin`; and the multi-call busybox and toybox, which run the applet they are given). `sudo git push` was read as `sudo` alone, so under the dangerously-allow switch its
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
  chrt: { shortValues: 'TPD', longValues: ['sched-runtime', 'sched-period', 'sched-deadline'], operands: 1, numericOperand: true, runsNothing: { short: 'pm', long: ['pid', 'max'] } },
  command: { runsNothing: { short: 'vV', long: [] } },
  exec: { shortValues: 'a' },
  builtin: {},
  setsid: {},
  flock: { shortValues: 'wE', longValues: ['timeout', 'wait', 'conflict-exit-code'], operands: 1, shellCommand: ['-c', '--command'] },
  xargs: { shortValues: 'aEILnsPd', shortOptional: 'eil', longValues: ['arg-file', 'delimiter', 'max-args', 'max-procs', 'max-chars', 'process-slot-var'], replaces: 'Ii' },
  busybox: { applets: true, runsNothing: { short: '', long: ['help', 'list', 'list-full', 'install', 'show'] } },
  toybox: { applets: true, runsNothing: { short: '', long: ['help', 'version', 'long'] } },
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

/**
 * A redirection word, shared with the judge gate's reading (call-forms.ts): optional descriptor digits or a bash named
 * descriptor (`{fd}`), then `<`, `>`, or `&>` (fix brief 6, A4).
 */
export const REDIRECTION = /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:[<>]|&>)/
/**
 * A word that is only a redirection operator, whose target is the next word (`<<- EOF`, `>& out`, `{fd}> out`): bash's
 * `<`, `<<`, `<<-`, `<<<`, `<>`, `<&`, `>`, `>>`, `>&`, `>|`, `&>`, and `&>>`, zsh's forms of the output ones ending in
 * `|` or `!` (`>!`, `>>|`, `>&|`, `>>&`, `&>|`), and ksh93's `>;` and `<>;` (fix brief 6, A5), with optional descriptor
 * digits or a named descriptor before it.
 */
export const BARE_REDIRECTION = /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:<<-|<<<|<<|<>;?|<&|<|>;|(?:>>?&?|&>>?)[|!]?)$/
/**
 * A bare operator ending in `!` (`>!`, `>>!`, `>&!`): zsh's clobber forms, whose target is the next word, while bash, dash,
 * and ksh read `>` (or `>>`, `>&`) onto a file named `!` and the next word as a word of the command (a probe under bash
 * 5.2: `>! echo x` ran echo). A statement holding one is read both ways (redirectionReadings).
 */
const SHELL_DEPENDENT_REDIRECTION = /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:>>?&?|&>>?)!$/
const ONE_READING: readonly boolean[] = [true]
const BOTH_READINGS: readonly boolean[] = [true, false]

/**
 * How a statement's redirections are read: as zsh reads a bare operator ending in `!` (true) and, where one stands in the
 * statement, also as bash, dash, and ksh read it (false), so a rule meets the command either shell runs (fix brief 6, A4).
 */
export function redirectionReadings(tokens: readonly { raw: string }[]): readonly boolean[] {
  return tokens.some(token => SHELL_DEPENDENT_REDIRECTION.test(token.raw)) ? BOTH_READINGS : ONE_READING
}

/** Whether a redirection word takes the next word as its target, in the reading `clobber` names (redirectionReadings). */
export function takesNextWord(raw: string, clobber: boolean): boolean {
  return BARE_REDIRECTION.test(raw) && (clobber || !SHELL_DEPENDENT_REDIRECTION.test(raw))
}
/** A word's typed basename: a slash, then a name, as a tilde path ends (`~/bin/tool`, `~user/bin/x`). */
const TYPED_BASENAME = /\/[^/]+$/

export interface CommandForms {
  /** The call as typed, then the command behind each wrapper prefix in turn: the last one is what runs. */
  chain: string[][]
  /** Every command the last of the chain runs inside itself (a shell body's statements, eval's text, a find -exec command), each with its own chain and bodies, flattened. */
  nested: string[][]
  /**
   * The forms of `nested` read only from a statement piece (statementPieces), a split no shell makes, by identity, so the
   * code reader can tell one from a statement a shell runs (fix brief 6, B5).
   */
  pieces: string[][]
  /**
   * Why a command was left unread, or null: wrappers or shell bodies nested past MAX_DEPTH, substitutions nested past
   * MAX_SUBSTITUTIONS, a find -exec command that is a primary, a `#` Buckle cannot place, an interactive session, or
   * shell text an expansion supplies; the first in READ_LIMITS order when several were met.
   */
  unread: UnreadLimit | null
  /** The read budget (READ_BUDGET) ran out, so the commands past it were left unread. */
  overBudget: boolean
  /**
   * A shell or `source` the call runs takes its script as data, from its input or from xargs (scriptArrivesAsData), or a
   * shell it starts runs a startup file whose text the call supplies (startupOf).
   */
  scriptData: boolean
  /** The interpreters the call runs code with (interpreterRunningCode), by program name, each once. */
  interpreters: string[]
  /**
   * The whole-command reading: each command a substitution cut, read whole with each body as `$()` (a head), as the
   * command behind each wrapper in turn, wherever it surely runs (textCommands), and again with each word that is only a
   * substitution left out, since one may expand to no word (`git $(echo) push`). The destructive floor and the deny list
   * read it beside the forms (judgedForms), so `rm>$(true) -rf x` meets the floor as `rm -rf x`; the allow list never
   * reads it, so a head can only add an ask or a refusal (fix brief 7, A3b).
   */
  heads: string[][]
}

/**
 * Every form the destructive floor and the deny list read: every form (allForms), then every head (CommandForms.heads),
 * the command a substitution cut, read whole, which no piece shows (fix brief 7, A3b). The allow list matches the call as
 * typed alone, so no head admits a call.
 */
export function judgedForms(forms: CommandForms): string[][] {
  return forms.heads.length === 0 ? allForms(forms) : [...allForms(forms), ...forms.heads]
}

/**
 * Every command a call runs, as words a rule judges (each command word reduced to its basename): the call
 * itself, the command behind each wrapper prefix or assignment, and each statement of a shell body or of eval's
 * text and each find -exec command, recursively. Display and
 * identity never use these forms; a rule shows and binds the raw argv (owner decision D17).
 */
export function commandForms(command: string, args: readonly string[]): CommandForms {
  const { rereads: _rereads, startup, aliases, ...forms } = formsOf([command, ...args], 0, { ...READ_BUDGET, spent: false }, CALL)
  // A startup file set anywhere in the call, exported or before a command, reaches the shells the call starts.
  if (runsStartupText(startup)) forms.scriptData = true
  // An alias defined anywhere in the call reaches text the same shell parses later, which no reading follows it into.
  if (aliases.defined && aliases.later) forms.unread = firstLimit(forms.unread, 'expansion')
  return forms
}

const formsByEffect = new WeakMap<object, CommandForms>()

/**
 * The forms of one exec effect, read once and shared by every rule that judges it,
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
 * the policy allows (`allowed`) is an ordinary command, so only another one leaves the call unknown
 * (docs/dev/architecture.md, Interpreters).
 */
export function readLimitOf(forms: CommandForms, allowed: ReadonlySet<string> = NO_INTERPRETERS): ReadLimit | null {
  if (forms.unread === 'depth') return 'depth'
  if (forms.overBudget) return 'budget'
  if (forms.unread) return forms.unread
  if (forms.scriptData) return 'scriptData'
  return forms.interpreters.some(name => !allowed.has(name)) ? 'interpreter' : null
}

/**
 * How a reason names a limit: as READ_LIMITS words it, and for an interpreter with the programs the policy does not
 * allow and how to allow one in the workspace's policy.
 */
export function readLimitReason(limit: ReadLimit, forms: CommandForms, allowed: ReadonlySet<string> = NO_INTERPRETERS): string {
  if (limit !== 'interpreter') return READ_LIMITS[limit]
  const names = forms.interpreters.filter(name => !allowed.has(name))
  const fix = names.length === 1 ? `allow it with buckle policy allow-interpreter ${names[0]}` : 'allow each with buckle policy allow-interpreter <name>'
  return `${READ_LIMITS.interpreter}: ${names.join(', ')} (${fix})`
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

/**
 * The forms, whether the last of the chain reads its own text again as shell text (eval, a shell, find -exec), and the
 * startup files the reading met with the shells it starts below the command itself (Startup).
 */
interface Reading extends CommandForms { rereads: boolean; startup: Startup; aliases: AliasReach }

/**
 * Whether a reading defines an alias (an `alias NAME=value` that surely runs), and whether it hands the shell running it
 * text that shell parses later (parsesLater), where bash expands an alias defined anywhere before, in that text or out of
 * it (probes under bash 5.2 and dash 0.5: `alias x=...; eval x`, `trap x EXIT`, `mapfile -C x`, `source /dev/stdin`, and
 * `eval "alias x=..."` then `x` each ran the alias's value). A child shell (`bash -c`, `bash <<EOF`) has no aliases.
 */
interface AliasReach { defined: boolean; later: boolean }

/**
 * The words of a statement an expansion supplies (holdsExpansion), whose value Buckle cannot know, each mapped to what the
 * expansion may make of it (Expansion).
 */
type Expanded = ReadonlyMap<string, Expansion>
const NO_WORDS: Expanded = new Map()

/**
 * What an expansion may make of a word: `command` says it may change the command the word names, false for a word whose
 * only expansion is a leading tilde before a typed basename, so a command word keeps that basename (`~/bin/tool`); and
 * the shape (expansionShape) says whether it may become several words, and what text before it is the word's own.
 */
interface Expansion extends ExpansionShape { command: boolean }

/**
 * Where the words being read stand: the call itself, whose input Buckle's exec leaves empty, or a statement of shell
 * text (a shell body, eval text, a find -exec command), whose input may be a pipe, a redirection or the input of a
 * pipeline around it; `heredoc` when a heredoc on that statement feeds its input, which Buckle reads. `expanded` holds
 * the words an expansion supplies, and `found` says find runs the words, putting a file name in place of each `{}`.
 * `sure` says the words run whenever the call does, so a command word an expansion supplies leaves the call unread:
 * false for a statement piece (a split no shell makes), for a heredoc body read as shell text when no shell is fed one,
 * and for whatever either holds. `whole` says the words are a whole simple command, so their command word is judged
 * here; a piece of a command a substitution cut is judged on the command whole (a head, textCommands). `fed` says the
 * input of the words, on some descriptor, may come from the call's own text (a pipe from a command in it, a heredoc, a
 * here-string, or a process substitution, on the statement or on a pipeline or compound command around it).
 */
interface Place { statement: boolean; heredoc: boolean; expanded: Expanded; found: boolean; sure: boolean; whole: boolean; fed: boolean }
const CALL: Place = { statement: false, heredoc: false, expanded: NO_WORDS, found: false, sure: true, whole: true, fed: false }

/**
 * `words` as written: the command word is reduced to its basename only after an assignment prefix is read. Each
 * statement of an inner text is read, and its pieces too unless the statement reads its own text again (eval, a
 * shell, find -exec), which covers them, so no text is read twice per level (slice 7b review W7B-1). A piece is a
 * split no shell makes, read only so a glob meets a command quoted for another program, so it marks no script as data.
 */
function formsOf(words: readonly string[], depth: number, budget: Budget, place: Place): Reading {
  const { chain, unread } = wrapperChain(words, place.expanded, place.sure && place.whole ? (place.found ? JUDGED_FOUND : JUDGED) : null)
  const inner = innerCommands(chain.at(-1)!, budget, place)
  const interpreter = interpreterRunningCode(chain, place)
  const own = startupOf(words, chain, place)
  const forms: Reading = { chain, nested: [], pieces: [], unread: firstLimit(unread, inner.unread), overBudget: false, scriptData: inner.scriptData || scriptArrivesAsData(chain, place) || runsStartupText(own), interpreters: interpreter ? [interpreter] : [], heads: inner.heads ?? [], rereads: inner.rereads, startup: { ...own, shell: false, fed: false }, aliases: { defined: place.sure && definesAlias(chain.at(-1)!), later: place.sure && parsesLater(chain.at(-1)!) } }
  addStartup(forms.startup, inner.startup)
  for (const group of inner.groups) {
    if (budget.spent) break
    if (group.command.length > 0) {
      const nested = readNested(forms, group.command, depth, budget, { statement: true, heredoc: group.heredoc, expanded: group.expanded, found: group.found, sure: group.sure, whole: group.whole, fed: group.fed }, false)
      if (nested === null) break
      if (nested.rereads) continue
    }
    // Split and read only now: a statement that reads its own text again has covered its pieces.
    for (const piece of statementPieces(group.statement)) {
      const form = budget.spent ? null : statementForm(piece, budget)
      if (form === null) break
      for (const words of readingsOf(form)) if (words.length > 0) readNested(forms, words, depth, budget, { statement: true, heredoc: form.heredoc, expanded: form.expanded, found: false, sure: false, whole: false, fed: false }, true)
    }
  }
  forms.overBudget = budget.spent
  return forms
}

/**
 * Reads a command `forms` runs inside itself one level down and adds what that reading met to `forms`; a piece adds its
 * forms and its limits only. Null past MAX_DEPTH, where `forms` is left unread.
 */
function readNested(forms: Reading, command: string[], depth: number, budget: Budget, at: Place, piece: boolean): Reading | null {
  if (depth >= MAX_DEPTH) {
    forms.unread = 'depth'
    return null
  }
  const nested = formsOf(command, depth + 1, budget, at)
  const before = forms.nested.length
  keep(forms.nested, nested.chain, budget)
  keep(forms.nested, nested.nested, budget)
  // Every form a piece holds is a piece; a statement passes up the pieces read below it.
  const inner = new Set(nested.pieces)
  for (const form of forms.nested.slice(before)) if (piece || inner.has(form)) forms.pieces.push(form)
  for (const head of nested.heads) forms.heads.push(head)
  forms.unread = firstLimit(forms.unread, nested.unread)
  if (!piece) {
    forms.scriptData ||= nested.scriptData
    for (const name of nested.interpreters) if (!forms.interpreters.includes(name)) forms.interpreters.push(name)
    addStartup(forms.startup, nested.startup)
    forms.aliases.defined ||= nested.aliases.defined
    forms.aliases.later ||= nested.aliases.later
    if (SHELL_COMMANDS.has(nested.chain.at(-1)![0] ?? '')) {
      forms.startup.shell = true
      forms.startup.fed ||= at.fed
    }
  }
  return nested
}

/** CPython and PyPy, whose names may carry a build suffix (PYTHON_BUILD). */
const PYTHONS: readonly string[] = ['python', 'pypy']

/**
 * Programs whose code Buckle cannot read as shell (docs/dev/architecture.md, Interpreters): each name, alone or with a
 * version (`python3`, `python3.12`, `node22`, `perl5.36`, `lua5.4`). A policy names the ones it reads as ordinary
 * commands. awk and its variants, lua, PowerShell, and the TypeScript runners are listed; so are the package runners
 * npx, pnpx, and bunx (D86 (4)), which fetch and run a package's code Buckle never reads, so a command allow alone never
 * lets one through. So are PyPy, the C shells, whose syntax is not the POSIX shell's, and busybox, whose shell applet
 * may be ash or hush; toybox, whose shell applet is its own toysh, is one too.
 */
const INTERPRETERS = [...PYTHONS, 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'awk', 'gawk', 'mawk', 'nawk', 'lua', 'luajit', 'pwsh', 'powershell', 'tsx', 'ts-node', 'npx', 'pnpx', 'bunx', 'tcsh', 'csh', 'busybox', 'toybox'] as const
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

/**
 * The busybox and toybox applets that are a shell: a call of one runs shell text in the binary's own shell (ash or
 * hush, toysh), which Buckle does not read as bash.
 */
const MULTICALL_SHELLS: ReadonlySet<string> = new Set(['sh', 'ash', 'hush', 'bash', 'toysh'])

/** awk's version and help calls across gawk, mawk (`-W version`), and the one true awk (`-version`). */
const AWK_INFO: ReadonlySet<string> = new Set(['--version', '-V', '-version', '-Wversion', '-Wv', '-W version', '--help', '-h', '--usage', '-Wusage', '-W usage'])
/** PowerShell's, matched without case, as PowerShell reads its parameters. */
const POWERSHELL_INFO: ReadonlySet<string> = new Set(['-version', '-v', '--version', '-help', '-h', '-?', '/?', '--help'])
const CASELESS_INFO = new Set(['pwsh', 'powershell'])

/**
 * The arguments, one word or mawk's two (`-W version`), with which each interpreter only prints its version or its help
 * and runs no code. lua and luajit print their version with -v and run nothing after it, not even their input; so do
 * ruby with -v alone, which prints its version and quits when no script or other option follows, perl with -V, which
 * prints its build configuration, and python with -VV, which prints its version and build (python 3.12 and perl 5.38
 * read no code from their input with these). deno takes -v as -V.
 */
const INTERPRETER_INFO: Readonly<Record<string, ReadonlySet<string>>> = {
  python: new Set(['--version', '-V', '-VV', '--help', '-h']),
  pypy: new Set(['--version', '-V', '-VV', '--help', '-h']),
  node: new Set(['--version', '-v', '--help', '-h']),
  nodejs: new Set(['--version', '-v', '--help', '-h']),
  deno: new Set(['--version', '-V', '-v', '--help', '-h']),
  bun: new Set(['--version', '-v', '--help', '-h']),
  perl: new Set(['--version', '-v', '-V', '--help', '-h']),
  ruby: new Set(['--version', '-v', '--help', '-h']),
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
  npx: new Set(['--version', '-v', '--help', '-h']),
  pnpx: new Set(['--version', '-v', '--help', '-h']),
  bunx: new Set(['--version', '-v', '--help', '-h']),
  tcsh: new Set(['--version', '--help']),
  csh: new Set(),
  busybox: new Set(['--help', '--list', '--list-full']),
  toybox: new Set(['--help', '--version', '--long']),
}

/** Whether these arguments only print the interpreter's version or its help. */
function printsInfo(command: string, args: readonly string[]): boolean {
  const program = interpreterProgram(command) ?? command
  const typed = args.join(' ')
  return args.length > 0 && args.length <= 2 && INTERPRETER_INFO[program]?.has(CASELESS_INFO.has(program) ? typed.toLowerCase() : typed) === true
}

/**
 * The interpreter the command a chain ends in runs code with, or null (docs/dev/architecture.md, Interpreters): any
 * call of one with inline code (`-c`, `-e`, `--eval`, `-r`, `-p`, pwsh's `-Command`), a script, `-m`, awk's program or
 * `-f`, or any other argument, and one behind xargs, whose items become its code or its script. Its version or its
 * help alone runs nothing; nor does a bare interpreter as the call itself, whose input is empty. In shell text a bare
 * interpreter reads code from its input, a pipe, a redirection, or a heredoc Buckle cannot read as shell, so it runs
 * code too.
 */
function interpreterRunningCode(chain: readonly string[][], place: Place): string | null {
  const [command = '', ...args] = chain.at(-1)!
  if (!INTERPRETER.test(command)) return null
  if (chain.some(form => form[0] === 'xargs')) return command
  if (printsInfo(command, args)) return null
  // busybox and toybox run code Buckle cannot read only through a shell applet; another applet is read as the command
  // it names (wrapperChain), so the chain ends at the binary only with a shell applet, or with no applet at all.
  if (command === 'busybox' || command === 'toybox') return MULTICALL_SHELLS.has(baseCommand(args[0] ?? '')) ? command : null
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
 * reads the input Buckle's exec leaves empty. A shell or `source` given a script file, too, while the call's own text
 * feeds its input on some descriptor (Place `fed`): Buckle cannot prove the operand is no link to that input (`ln -s
 * /dev/stdin l; echo ... | bash l`, `cd /dev; bash stdin`, `bash "$x"`). With no such feed it stays a script file
 * (`source "$NVM_DIR/nvm.sh"`, `bash build.sh < input`).
 */
function scriptArrivesAsData(chain: readonly string[][], place: Place): boolean {
  if (place.fed && place.sure && place.whole && runsScriptFile(chain)) return true
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

/**
 * The variables naming a file a starting shell runs before its script: BASH_ENV, which a non-interactive bash reads (a
 * -c string or a script), and ENV, which sh, and bash in POSIX mode, read when interactive. Each shell expands the value
 * first, a command substitution in it included (probes under bash 5.2 and dash 0.5).
 */
const STARTUP_VARIABLE = /^(?:BASH_ENV|ENV)=/

/**
 * What a reading met of the files a starting shell runs first (startupOf): `text` when one holds text the call itself
 * supplies, which no reading sees; `expansion` when an expansion supplies one's name, so it may hold such text; `shell`
 * when the reading starts a shell, and `fed` when the call's own text feeds that shell's input.
 */
interface Startup { text: boolean; expansion: boolean; shell: boolean; fed: boolean }

const noStartup = (): Startup => ({ text: false, expansion: false, shell: false, fed: false })

function addStartup(into: Startup, from: Startup | undefined): void {
  if (from === undefined) return
  into.text ||= from.text
  into.expansion ||= from.expansion
  into.shell ||= from.shell
  into.fed ||= from.fed
}

/** Whether a shell started runs a startup file whose text the call supplies: one it names, or one an expansion names while the call feeds it. */
const runsStartupText = (startup: Startup): boolean => (startup.text && startup.shell) || (startup.expansion && startup.fed)

/** The builtins whose operands assign variables, which `-x` or `export` itself exports. */
const DECLARING = new Set(['export', 'declare', 'typeset', 'local', 'readonly'])

/**
 * What one command's words say of a startup file: each word that assigns BASH_ENV or ENV (STARTUP_VARIABLE) before the
 * command or through a wrapper in front of it (the words before the command the chain ends in), in a statement of
 * assignments alone, or as an operand of export or declare, since an exported one reaches every shell the call starts
 * after it, a function's included; each file a shell's own `--rcfile` or `--init-file` names; and whether the command is
 * a shell, fed or not. Only words that surely run are judged (Place `sure`). A file on disk is not read, as a script file
 * is not.
 */
function startupOf(words: readonly string[], chain: readonly string[][], place: Place): Startup {
  const [command = '', ...args] = chain.at(-1)!
  const shell = SHELL_COMMANDS.has(command)
  const startup: Startup = { text: false, expansion: false, shell, fed: shell && place.fed }
  if (!place.sure) return startup
  const judge = (word: string, file: string) => {
    const source = startupFile(word, file, place)
    if (source === 'text') startup.text = true
    if (source === 'expansion') startup.expansion = true
  }
  // The chain's last command is the words' end; its word as written, since a chain reduces it to a basename.
  const at = Math.max(0, words.length - args.length - 1)
  const assigning = ASSIGNMENT.test(words[at] ?? '') || DECLARING.has(command) ? words : words.slice(0, at)
  for (const word of assigning) if (STARTUP_VARIABLE.test(word)) judge(word, word.slice(word.indexOf('=') + 1))
  if (shell) for (const file of shellStartupFiles(args)) judge(file, file)
  return startup
}

/**
 * Where a startup file's text comes from, by its name (word, the word that gives it): `text` from the call itself, a
 * process substitution (which a head shows as `<$()` or `>$()`), another descriptor, the shell's own input in shell text
 * no heredoc feeds, or a command substitution the starting shell runs as it expands the name; `expansion` when an
 * expansion supplies the name; null for a file on disk, and for /dev/null, which holds nothing.
 */
function startupFile(word: string, file: string, place: Place): 'text' | 'expansion' | null {
  if (file.startsWith('<$()') || file.startsWith('>$()')) return 'text'
  if (place.expanded.has(word)) return 'expansion'
  if (file.includes('$(') || file.includes('`')) return 'text'
  if (file === '/dev/null') return null
  const kind = scriptOperandKind(file)
  return kind === 'descriptor' || (kind === 'input' && place.statement && !place.heredoc) ? 'text' : null
}

/** Whether the command a chain ends in is a shell or `source` given a script file. */
function runsScriptFile(chain: readonly string[][]): boolean {
  const [command = '', ...args] = chain.at(-1)!
  if (SHELL_COMMANDS.has(command)) return shellScriptOperand(args).source === 'file'
  if (!SOURCE_COMMANDS.has(command)) return false
  const file = args[0] === '--' ? args[1] : args[0]
  return file !== undefined && scriptOperandKind(file) === 'file'
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
 * again, whether a heredoc on the statement feeds the command's input, the words an expansion supplies, whether find runs
 * the command, and whether it surely runs and is whole (Place).
 */
interface CommandGroup { command: string[]; statement: string; heredoc: boolean; expanded: Expanded; found: boolean; sure: boolean; whole: boolean; fed: boolean }

/**
 * The commands a command runs inside itself, why part of them was left unread, whether a script there arrives as data,
 * whether the command reads its own text again, and the whole-command reading of its text (CommandForms `heads`).
 */
interface InnerCommands { groups: CommandGroup[]; unread: UnreadLimit | null; scriptData?: boolean; rereads: boolean; heads?: string[][]; startup?: Startup }

/** Commands a command runs whose words come from the statement around it (find -exec, su), keeping what the place knows of them. */
const groupsOf = (commands: readonly string[][], place: Place, found: boolean): CommandGroup[] =>
  commands.map(command => ({ command: [...command], statement: '', heredoc: false, expanded: place.expanded, found, sure: place.sure, whole: true, fed: place.fed }))

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
    const read = textCommands(text, budget, place)
    return { groups: read.groups, unread: UNKNOWN_TEXT.test(text) || text.trim() === '' ? firstLimit(read.unread, 'expansion') : read.unread, scriptData: read.scriptData, rereads: true, heads: read.heads, startup: read.startup }
  }
  if (command === 'trap') return heldCommands(trapAction(args), budget, place)
  if (command === 'alias') return heldCommands(aliasValues(args), budget, place)
  if (command === 'mapfile' || command === 'readarray') return heldCommands(mapfileCallbacks(args), budget, place)
  if (!SHELL_COMMANDS.has(command)) return { groups: [], unread: null, rereads: false }
  const { source, operand } = shellScriptOperand(args)
  // Only a -c string is shell text the shell runs. A script file's name, and the words after a -c string ($0, $1), are
  // read as text too, only so a glob meets them, and no command word in them is judged (`bash "$script"`, `sh -c '...' _ "$@"`).
  const positionals = parseArgv(command, args).positionals
  const script = source === 'command' && operand !== undefined ? positionals.indexOf(operand) : -1
  const read = textCommands(script < 0 ? '' : positionals[script]!, budget, place)
  const rest = textCommands(positionals.filter((_, index) => index !== script).join('\n'), budget, { sure: false, fed: place.fed })
  const expanded = source === 'command' && operand !== undefined && place.expanded.has(operand)
  const unread = firstLimit(expanded ? firstLimit(read.unread, 'expansion') : read.unread, rest.unread)
  addStartup(read.startup, rest.startup)
  return { groups: [...read.groups, ...rest.groups], unread, scriptData: read.scriptData || rest.scriptData, rereads: true, heads: [...read.heads, ...rest.heads], startup: read.startup }
}

/** Shell text a builtin keeps for the shell to run later: the word of the call that carries it, and the text. */
interface HeldText { word: string; text: string }

/**
 * The commands of shell text a builtin keeps to run later (a trap's action, an alias's value, a mapfile callback), each
 * read as shell text, as bash runs it; one an expansion supplies exists only once the shell has run, so the call is
 * unread (expansion).
 */
function heldCommands(held: readonly HeldText[], budget: Budget, place: Place): InnerCommands {
  const groups: CommandGroup[] = []
  const heads: string[][] = []
  const startup = noStartup()
  let unread: UnreadLimit | null = null
  let scriptData = false
  for (const { word, text } of held) {
    if (place.expanded.has(word)) unread = firstLimit(unread, 'expansion')
    const read = textCommands(text, budget, place)
    groups.push(...read.groups)
    for (const head of read.heads) heads.push(head)
    addStartup(startup, read.startup)
    unread = firstLimit(unread, read.unread)
    scriptData ||= read.scriptData
  }
  return { groups, unread, scriptData, rereads: held.length > 0, heads, startup }
}

/**
 * The action `trap` sets: its first operand when a signal follows, unless that is `-`, which resets the signals; `-l`
 * and `-p` only print. bash runs the action as shell text when the signal or the exit comes.
 */
function trapAction(args: readonly string[]): HeldText[] {
  let index = 0
  for (; index < args.length && args[index]!.startsWith('-') && args[index] !== '-'; index++) {
    if (args[index] === '--') {
      index++
      break
    }
    if (/[lp]/.test(args[index]!)) return []
  }
  const action = args[index]
  return action !== undefined && action !== '-' && index + 1 < args.length ? [{ word: action, text: action }] : []
}

/** The value of each `name=value` operand of `alias`, which the shell reads as shell text where the name begins a command. */
function aliasValues(args: readonly string[]): HeldText[] {
  return args.filter(word => !word.startsWith('-') && word.indexOf('=') > 0).map(word => ({ word, text: word.slice(word.indexOf('=') + 1) }))
}

/** The options of mapfile and readarray that take a value (bash's -C callback, -c quantum, -d, -n, -O, -s, -u). */
const MAPFILE_VALUES = 'CcdnOsu'

/**
 * The callback mapfile or readarray runs as shell text every quantum of lines (`-C callback`, attached or not), with
 * the index and the line after it as words; it is read whatever the quantum.
 */
function mapfileCallbacks(args: readonly string[]): HeldText[] {
  const held: HeldText[] = []
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (word === '--' || !word.startsWith('-') || word === '-') break
    for (let offset = 1; offset < word.length; offset++) {
      const flag = word[offset]!
      if (!MAPFILE_VALUES.includes(flag)) continue
      const attached = word.slice(offset + 1)
      const value = attached !== '' ? attached : args[++index]
      if (flag === 'C' && value !== undefined) held.push({ word: attached !== '' ? word : value, text: value })
      break
    }
  }
  return held
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
  let scriptData = false
  if ([...ssh.words, ...ssh.settings].some(word => place.expanded.has(word))) unread = firstLimit(unread, 'expansion')
  if (ssh.tokens) unread = firstLimit(unread, 'ownParsing')
  const heads: string[][] = []
  const startup = noStartup()
  for (const text of [...ssh.remote, ...ssh.local]) {
    const read = textCommands(text, budget, place)
    groups.push(...read.groups)
    for (const head of read.heads) heads.push(head)
    addStartup(startup, read.startup)
    unread = firstLimit(unread, read.unread)
    scriptData ||= read.scriptData
  }
  return { groups, unread, scriptData, rereads: true, heads, startup }
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
 * past it the text is unread. When the text runs whenever the call does (`sure`), a command word an expansion supplies
 * leaves the call unread: each whole statement's is judged where it is read (formsOf), and each command a substitution
 * cut is judged here on its head, whose words the cut pieces do not show. What only a safety net read is not judged: a
 * heredoc body read whole is judged only when the command owning it may feed it to a shell (feedsShell), so a Makefile
 * line `$(CC) -o x` or a script line `"$PYTHON" x.py` in a body fed to `cat` is read as before, and a body's lines read
 * one at a time or joined, which no shell runs as such, are never judged. Whether a statement's input comes from the
 * call's own text is what the splitter saw, or what `around` says of the command whose text this is; a command a
 * substitution cut is judged on its head for a script file it is given while so fed (scriptArrivesAsData).
 */
function textCommands(text: string, budget: Budget, around: Pick<Place, 'sure' | 'fed'>): { groups: CommandGroup[]; unread: UnreadLimit | null; scriptData: boolean; heads: string[][]; startup: Startup } {
  const { sure } = around
  const startup = noStartup()
  if (budget.characters < text.length) {
    budget.characters -= text.length
    budget.spent = true
    return { groups: [], unread: null, scriptData: false, heads: [], startup }
  }
  const meter = { characters: budget.characters }
  const { statements, seen, heads, deep, overDepth, unsureComment, overBudget } = shellStatementList(text, meter, feedsShell)
  budget.characters = meter.characters
  const groups: CommandGroup[] = []
  const judged: string[][] = []
  // Past the budget no form is read (formsOf stops at a spent budget), so the statements are not split into words.
  if (overBudget) {
    budget.spent = true
    return { groups, unread: null, scriptData: false, heads: judged, startup }
  }
  let unread: UnreadLimit | null = overDepth ? 'depth' : deep ? 'substitutions' : unsureComment ? 'comment' : null
  let scriptData = false
  for (const statement of statements) {
    const form = statementForm(statement, budget)
    if (form === null) break
    const known = seen.get(statement)!
    const group: CommandGroup = { command: form.words, statement, heredoc: form.heredoc, expanded: form.expanded, found: false, sure: sure && !known.net, whole: known.whole, fed: around.fed || known.fed }
    groups.push(group)
    // The other reading of a redirection whose meaning depends on the shell; the statement's pieces are read once.
    if (form.other !== null) groups.push({ ...group, command: form.other, statement: '' })
  }
  for (const [head, known] of heads) {
    if (!sure || known.net) continue
    const form = budget.spent ? null : statementForm(head, budget)
    if (form === null) break
    // A word that is only a substitution may expand to no word, so the head is also read without it (fix brief 7, A3b).
    const readings = form.bare.length === 0 ? readingsOf(form) : [...readingsOf(form), form.words.filter((_, at) => !form.bare.includes(at))]
    for (const words of readings) {
      const { chain, unread: limit } = wrapperChain(words, form.expanded, JUDGED)
      if (limit === 'expansion') unread = firstLimit(unread, 'expansion')
      scriptData ||= (around.fed || known.fed) && runsScriptFile(chain)
      for (const step of chain) judged.push(step)
      // A head is the only reading of a command a process substitution cut whole (`BASH_ENV=<(...) bash`).
      addStartup(startup, startupOf(words, chain, { ...CALL, statement: true, heredoc: form.heredoc, expanded: form.expanded, fed: around.fed || known.fed }))
    }
  }
  for (const use of aliasUses(groups, budget)) groups.push(use)
  return { groups, unread, scriptData, heads: judged, startup }
}

/**
 * Each statement of shell text whose command word is an alias a statement of the same text defines, read again with the
 * alias's value in place of its name and the words after the name joined on (`alias g='git push'; g --force`), so a
 * glob meets them together. bash looks for an alias at a command's word (commandWordAt), past the reserved words before
 * it, so in a function's body too; again at the value's first word, but not for an alias it is expanding already; and
 * at the word after a value that ends in a blank (`alias s='sudo '`). An alias reaching text the same shell parses later
 * (eval, a trap's action) leaves the call unread instead (AliasReach).
 */
function aliasUses(groups: readonly CommandGroup[], budget: Budget): CommandGroup[] {
  const aliases = new Map<string, string>()
  for (const group of groups) {
    if (group.command[0] !== 'alias') continue
    for (const { word, text } of aliasValues(group.command.slice(1))) if (!group.expanded.has(word)) aliases.set(word.slice(0, word.indexOf('=')), text)
  }
  if (aliases.size === 0) return []
  const uses: CommandGroup[] = []
  for (const group of groups) {
    let words = group.command
    let expanded = group.expanded
    const used = new Set<string>()
    for (let at = commandWordAt(words); at >= 0 && at < words.length;) {
      const name = words[at]!
      if (!aliases.has(name) || used.has(name)) break
      used.add(name)
      const text = aliases.get(name)!
      const value = budget.spent ? null : statementForm(text, budget)
      if (value === null) break
      words = [...words.slice(0, at), ...value.words, ...words.slice(at + 1)]
      expanded = new Map([...expanded, ...value.expanded])
      const first = value.words[0]
      if (first !== undefined && aliases.has(first) && !used.has(first)) continue
      if (!/[ \t]$/.test(text)) break
      at += value.words.length
    }
    if (used.size > 0) uses.push({ ...group, command: words, statement: '', expanded })
  }
  return uses
}

/**
 * Where a statement's command word is, as bash looks for an alias there: past its NAME=value assignments and the reserved
 * words before a command (SHELL_KEYWORDS, `time` and its `-p`, `coproc` and the name before a compound command, and
 * `function NAME`); -1 when no word is left.
 */
function commandWordAt(words: readonly string[]): number {
  let index = 0
  while (index < words.length) {
    const word = words[index]!
    if (ASSIGNMENT.test(word) || SHELL_KEYWORDS.has(word)) index++
    else if (word === 'time') {
      index++
      while (words[index] === '-p' || words[index] === '--') index++
    } else if (word === 'coproc') index += COMPOUND_START.has(words[index + 2] ?? '') ? 2 : 1
    else if (word === 'function') index += 2
    else return index
  }
  return -1
}

/** Whether a command is `alias` defining one (an operand NAME=value). */
function definesAlias(runs: readonly string[]): boolean {
  return runs[0] === 'alias' && aliasValues(runs.slice(1)).length > 0
}

/**
 * Whether a command hands the shell running it text that shell parses later: eval's words, a trap's action, a mapfile
 * callback, and what `source` or `.` reads from the shell's input or a descriptor. A script file on disk is not read.
 */
function parsesLater(runs: readonly string[]): boolean {
  const [command = '', ...args] = runs
  if (command === 'eval') return true
  if (command === 'trap') return trapAction(args).length > 0
  if (command === 'mapfile' || command === 'readarray') return mapfileCallbacks(args).length > 0
  if (!SOURCE_COMMANDS.has(command)) return false
  const file = args[0] === '--' ? args[1] : args[0]
  return file !== undefined && scriptOperandKind(file) !== 'file'
}

/** Programs that run what a heredoc feeds them as shell text: the shells, `source`, and ssh and su, which hand it to one. */
const BODY_RUNNERS: ReadonlySet<string> = new Set([...SHELL_COMMANDS, 'source', '.', 'ssh', 'su', 'tcsh', 'csh', 'busybox'])

/**
 * Whether the command owning a heredoc (its statement, or its head when a substitution cut it) may feed the body to a
 * shell: its command, or one behind a wrapper prefix, runs its input as shell text, or opens an interactive session
 * (`sudo -s`); a command whose words a cut left out (`$(...) <<EOF`) may too.
 */
function feedsShell(owner: string): boolean {
  return shellWordsWithoutRedirections(owner).some((words) => {
    if (words.length === 0) return true
    const { chain, unread } = wrapperChain(words, NO_WORDS, null)
    return unread === 'session' || chain.some(([command = '']) => BODY_RUNNERS.has(command))
  })
}

/**
 * A command's words as statementForm reads them, its redirections dropped, with no budget: an owner is one command. One
 * list per reading of its redirections (redirectionReadings).
 */
function shellWordsWithoutRedirections(text: string): string[][] {
  const tokens = shellTokens(text)
  return redirectionReadings(tokens).map((clobber) => {
    const words: string[] = []
    for (let index = 0; index < tokens.length; index++) {
      const { raw, word } = tokens[index]!
      if (!REDIRECTION.test(raw)) words.push(word)
      else if (takesNextWord(raw, clobber)) index++
    }
    return words
  })
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

/** How a chain's command words are judged: `found` when find runs the words, putting a file name in place of each `{}`. */
interface Judged { found: boolean }
const JUDGED: Judged = { found: false }
const JUDGED_FOUND: Judged = { found: true }

/**
 * The call as written, then the command behind each wrapper prefix in turn. The words `expanded` names are those an
 * expansion supplies (Place), whose value Buckle cannot know. With `judged`, a command word whose value something other
 * than the text supplies leaves the call unread (expansion), at every step of the chain: an expansion (`$cmd`, `"$(...)"`,
 * a glob, a brace expansion; a leading tilde before a typed basename keeps it), the `{}` find replaces, the replace string of an
 * xargs before it (`xargs -I X env X`), and the items xargs hands a wrapper that names no command (`xargs env`). So does
 * an expansion among the words a program reads before the command it runs, where it may be an option, an option's
 * value, or several words, and so move that command: a wrapper's (innerCommand) and, at the chain's end, find's,
 * ssh's, su's, or a shell's before its script (unsureLeadingWords). Words after the command's own word are its arguments.
 */
function wrapperChain(words: readonly string[], expanded: Expanded, judged: Judged | null): { chain: string[][]; unread: UnreadLimit | null } {
  const chain = [reduced(words)]
  let current = words
  let unread: UnreadLimit | null = null
  // What an xargs earlier in the chain hands on: its items, and the string it replaces with one.
  let xargs: { replace: string | null } | null = null
  for (let depth = 0; ; depth++) {
    if (judged && suppliedCommand(current[0], expanded, judged, xargs?.replace ?? null)) unread = firstLimit(unread, 'expansion')
    const inner = unwrapped(current, expanded)
    if (inner === undefined) return { chain, unread: judged && unsureLeadingWords(current, expanded, xargs !== null) ? firstLimit(unread, 'expansion') : unread }
    if (depth >= MAX_DEPTH) return { chain, unread: 'depth' }
    unread = firstLimit(unread, inner.unread)
    if (judged && inner.unsure) unread = firstLimit(unread, 'expansion')
    if (inner.command === 'session') return { chain, unread: firstLimit(unread, 'session') }
    if (!inner.command?.[0]) return { chain, unread: judged && inner.open && xargs ? firstLimit(unread, 'expansion') : unread }
    if (baseCommand(current[0]!) === 'xargs') xargs = { replace: xargsReplace(current.slice(1, current.length - inner.command.length)) }
    const execs = execsItsCommand(current)
    current = inner.command
    chain.push(reduced(current))
    // A NAME=value word such a wrapper runs is a program path (`nice FOO=/bin/rm x` runs a file in a folder named FOO=),
    // read by its basename beside the word as typed, which names the variable for the code-loading check; the reading as
    // an assignment follows both, since bash's `time` keyword applies one (fix brief 6, A7).
    if (execs && ASSIGNMENT.test(current[0]!) && /[\\/]/.test(current[0]!)) chain.push([baseCommand(current[0]!), ...current.slice(1)])
  }
}

/**
 * Whether a prefix is a program in WRAPPERS that execs the command after its own words as a path: every one but env and
 * sudo, which apply the NAME=value words before that command themselves. A shell keyword, `function`, and `coproc` are
 * read by the shell, which applies an assignment after them (fix brief 6, A7).
 */
function execsItsCommand(words: readonly string[]): boolean {
  const word = words[0] ?? ''
  if (!Object.hasOwn(WRAPPERS, baseCommand(word)) || ASSIGNMENT.test(word)) return false
  return WRAPPERS[baseCommand(word)]!.assignments !== true
}

/** Whether something other than the text supplies a command word: see wrapperChain. An assignment word is no command word. */
function suppliedCommand(word: string | undefined, expanded: Expanded, judged: Judged, replace: string | null): boolean {
  if (word === undefined || ASSIGNMENT.test(word)) return false
  if (expanded.get(word)?.command === true) return true
  if (judged.found && word.includes('{}')) return true
  return replace !== null && replace !== '' && word.includes(replace)
}

/**
 * Whether an expansion leaves a word one word that no option parser reads as an option: its own text starts it, with a
 * character other than `-` (or `+`, for a shell), so the expansion cannot make it one.
 */
const surelyOperand = (expansion: Expansion, signs = '-'): boolean => !expansion.splits && expansion.prefix !== '' && !signs.includes(expansion.prefix[0]!)

/**
 * Whether an expansion in an option word leaves the options as written: the word stays one word, and the expansion
 * starts inside a value attached to a typed option that takes one, which names nothing that runs. After a long option's
 * `=` the value stays attached even when empty (`--signal="$s"`). After a short option's letter it must follow typed
 * value text (`-n1"$v"`): an empty value leaves the letter alone, and it takes the next word (`v=; nice -n"$v" 5 cmd`).
 */
const attachedValue = (expansion: Expansion, valueAt: number | null, runs: boolean): boolean =>
  valueAt !== null && !runs && !expansion.splits
  && (expansion.prefix.length > valueAt || (expansion.prefix.length === valueAt && expansion.prefix[valueAt - 1] === '='))

/**
 * Whether an expansion among the words before what a program runs (LeadingWord) may move it: in an option word, unless
 * it is a value attached to a typed option that takes one (attachedValue); in an option's value, if it may be several
 * words or names what runs; and in an operand, unless the word's own text starts it with no `-` (`user@"$HOST"`).
 */
function unsureWords(leading: readonly LeadingWord[], expanded: Expanded, signs = '-'): boolean {
  return leading.some(item => {
    const expansion = expanded.get(item.word)
    if (expansion === undefined) return false
    if (item.role === 'operand') return !surelyOperand(expansion, signs)
    if (item.role === 'value') return expansion.splits || item.runs === true
    return !attachedValue(expansion, item.valueAt, item.runs === true)
  })
}

/**
 * Whether an expansion among the words that find, ssh, su, or a shell reads before the command it runs may move that
 * command, the last step of a chain (wrapperChain). ssh and su: as unsureWords reads their options, values, and host or
 * user, every word before a `--` for su, whose getopt_long permutes. A shell: its options and their values, and a
 * script operand that may be an option, unless no word follows it, since the word after one may be its `-c` string
 * (`bash "$v" 'git push'`); a `-c` string an expansion supplies is unread already (innerCommands). find: unsureFind.
 * Items xargs hands find, ssh, or su become such words (`xargs find .`), so behind xargs each is unsure.
 */
function unsureLeadingWords(words: readonly string[], expanded: Expanded, fromXargs: boolean): boolean {
  const [command = '', ...args] = words
  const name = baseCommand(command)
  if (name === 'find') return fromXargs || unsureFind(args, expanded)
  if (name === 'ssh') return fromXargs || unsureWords(sshInvocation(args).leading, expanded)
  if (name === 'su') return fromXargs || unsureWords(suInvocation(args).leading, expanded)
  if (!SHELL_COMMANDS.has(name)) return false
  const { leading, operand, command: commandString } = shellLeadingWords(args)
  if (unsureWords(leading, expanded, '-+')) return true
  const expansion = expanded.get(args[operand] ?? '')
  if (expansion === undefined || commandString || surelyOperand(expansion, '-+')) return false
  return expansion.splits || operand + 1 < args.length
}

/**
 * Whether an expansion among find's words may change what it runs: one that may be several words may be `-exec` and a
 * command; one word may still be `-exec`, `-ok`, or a terminator, so it is unsure while a `;` or `+` is typed after it or
 * another expansion follows that may be one. A word right after a primary that takes a value, outside any -exec command,
 * is that value whatever it holds (`-name "$pattern"`).
 */
function unsureFind(args: readonly string[], expanded: Expanded): boolean {
  let last = -1
  for (let index = 0; index < args.length; index++) if (args[index] === ';' || args[index] === '+' || expanded.has(args[index]!)) last = index
  let exec = false
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    const expansion = expanded.get(word)
    if (expansion !== undefined && (expansion.splits || last > index)) return true
    if (exec) {
      exec = !(word === ';' || (word === '+' && args[index - 1] === '{}'))
      continue
    }
    if (FIND_VALUE_PRIMARIES.has(word) || FIND_NEWER.test(word)) {
      if (expanded.get(args[index + 1] ?? '')?.splits === true) return true
      index++
    } else exec = FIND_EXEC.has(word)
  }
  return false
}

/**
 * The string xargs replaces with each item in the words after it, from its options as findutils reads them: `-I R`,
 * `-iR` or `-i` (`{}`), `--replace=R` or `--replace` (`{}`), a long name it begins counting; null with none.
 */
function xargsReplace(options: readonly string[]): string | null {
  let replace: string | null = null
  for (let index = 0; index < options.length; index++) {
    const word = options[index]!
    if (word.startsWith('--')) {
      const separator = word.indexOf('=')
      const typed = separator < 0 ? word.slice(2) : word.slice(2, separator)
      if (typed !== '' && 'replace'.startsWith(typed)) replace = separator < 0 ? '{}' : word.slice(separator + 1)
      else if (separator < 0 && WRAPPERS.xargs!.longValues!.some(name => typed !== '' && name.startsWith(typed))) index++
      continue
    }
    for (let offset = 1; offset < word.length; offset++) {
      const flag = word[offset]!
      if (flag === 'i') {
        replace = word.slice(offset + 1) || '{}'
        break
      }
      if (!WRAPPERS.xargs!.shortValues!.includes(flag)) continue
      const value = offset + 1 < word.length ? word.slice(offset + 1) : options[++index]
      if (flag === 'I' && value !== undefined) replace = value
      break
    }
  }
  return replace
}

/**
 * What a prefix runs (null for nothing, 'session' for an interactive session) and why part of it was left unread; `open`
 * when a wrapper names no command but would run one from more words it is handed (`env`, `timeout 5`), as from xargs;
 * `unsure` when an expansion among the words the wrapper reads before that command may move it (innerCommand).
 */
interface Unwrapped { command: string[] | null | 'session'; unread: UnreadLimit | null; open?: true; unsure?: true }

/** A prefix that runs `command`, all of it read. */
const prefixRuns = (command: string[] | null): Unwrapped => ({ command, unread: null })

/**
 * What the first words run: past NAME=value assignments, a wrapper's options, a shell keyword, `function NAME` or
 * `coproc [NAME]` (slice 7b review W7B-3). Undefined when the first word is none of those.
 */
function unwrapped(words: readonly string[], expanded: Expanded): Unwrapped | undefined {
  if (ASSIGNMENT.test(words[0] ?? '')) {
    const command = words.findIndex(word => !ASSIGNMENT.test(word))
    return prefixRuns(command < 0 ? null : words.slice(command))
  }
  if (words[0] === 'function') return prefixRuns(words.length > 2 ? words.slice(2) : null)
  if (words[0] === 'coproc') return prefixRuns(COMPOUND_START.has(words[2] ?? '') ? words.slice(2) : words.length > 1 ? words.slice(1) : null)
  const wrapper = wrapperOf(baseCommand(words[0] ?? ''))
  if (wrapper === undefined) return undefined
  const inner = innerCommand(wrapper, words.slice(1), expanded)
  if (wrapper.applets && Array.isArray(inner.command) && MULTICALL_SHELLS.has(baseCommand(inner.command[0] ?? ''))) return undefined
  return inner
}

/**
 * An env -S value as words. With no backslash and no `${`, GNU env splits it as envSplitWords reads it, exactly. A
 * backslash starts one of env's own escapes (`\_` separates words, `\c` ends the string) and `${` expands a variable,
 * so such a value is unread (own parsing), and so is one an expansion supplies; either is still split as shell words,
 * so a deny glob may yet name what it meets.
 */
function splitValue(value: string, expanded: Expanded): { words: string[]; unread: UnreadLimit | null } {
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

/** A command as a rule compares it: the command word reduced to its basename. A leading NAME=value assignment is no
 * command path, so it keeps its case (it reaches the code-loading check by name; fix brief 5, D1). */
function reduced(words: readonly string[]): string[] {
  const [command = '', ...args] = words
  return [ASSIGNMENT.test(command) ? command : baseCommand(command), ...args]
}

/** A wrapper's reading, marked `unsure` when an expansion among its words may move the command it runs. */
const marked = (unsure: boolean, inner: Unwrapped): Unwrapped => (unsure ? { ...inner, unsure: true } : inner)

/**
 * The command a wrapper runs, read past its options, assignments and operands; null when it runs none, and 'session'
 * when it runs none but an option opens an interactive session (`sudo -i`). Bash splits an unquoted expansion and a
 * pattern into words, and an expansion may be an option, so one among these words may supply the command or move it
 * (`v="1 git"; timeout $v push`): such a word marks the reading `unsure`. It is sure only as an option's value that stays
 * one word and names nothing that runs (`nice -n "$v"`, `sudo -u "$USER"`, `--signal="$s"`, `-n1"$v"`), as an assignment
 * whose name and `=` are typed and whose value stays one word (`env FOO="$BAR"`), or as an operand that stays one word
 * with typed text before the expansion that is no option (`flock ./"$lock"`). A `NAME=$v` before a command, with no
 * wrapper, is an assignment bash does not split, and is not read here.
 */
function innerCommand(wrapper: Wrapper, args: readonly string[], expanded: Expanded): Unwrapped {
  const words = [...args]
  let index = 0
  let session = false
  let unread: UnreadLimit | null = null
  let unsure = false
  while (index < words.length) {
    const word = words[index]!
    const expansion = expanded.get(words[index] ?? '')
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
      unsure ||= expansion !== undefined
      index++
      continue
    }
    const option = word.startsWith('--') ? readLong(wrapper, words, index) : readShort(wrapper, words, index)
    const value = option.value
    unsure ||= expansion !== undefined && !attachedValue(expansion, value?.at ?? null, value?.runs === true)
    if (value !== undefined && value.at === null) {
      const given = expanded.get(words[index + 1] ?? '')
      unsure ||= given !== undefined && (given.splits || value.runs)
    }
    if (option.runsNothing) return marked(unsure, { command: null, unread })
    session ||= option.session === true
    index = option.next
    if (option.split !== undefined) {
      const split = splitValue(option.split, expanded)
      words.splice(index, 0, ...split.words)
      unread = firstLimit(unread, split.unread)
    }
  }
  for (; wrapper.assignments && index < words.length && words[index]!.includes('='); index++) {
    const expansion = expanded.get(words[index] ?? '')
    unsure ||= expansion !== undefined && (expansion.splits || !ASSIGNMENT.test(expansion.prefix))
  }
  const operands = !wrapper.numericOperand || /^\d+$/.test(words[index] ?? '') ? wrapper.operands ?? 0 : 0
  for (let at = index; at < Math.min(index + operands, words.length); at++) {
    const expansion = expanded.get(words[at] ?? '')
    unsure ||= expansion !== undefined && !surelyOperand(expansion)
  }
  index += operands
  if (wrapper.shellCommand?.includes(words[index] ?? '')) return marked(unsure, index + 1 < words.length ? { command: ['sh', '-c', words[index + 1]!], unread } : { command: null, unread, open: true })
  if (index < words.length && session && wrapper.sessionShell) {
    const shell = shellSessionCommand(words.slice(index))
    return marked(unsure, { command: shell.command, unread: firstLimit(unread, shell.unread) })
  }
  if (index < words.length) return marked(unsure, { command: words.slice(index), unread })
  return marked(unsure, session ? { command: 'session', unread } : { command: null, unread, open: true })
}

/**
 * An option as a wrapper reads it: where the reading goes on, whether nothing runs past it, the value it splits into
 * words (env -S), whether it opens a session, and, for one that takes a value, where that value is (`at`, the offset in
 * the option's word where an attached value starts, or null for the next word) and whether it changes what runs (env -S,
 * xargs -I).
 */
interface ReadOption { next: number; runsNothing?: true; split?: string; session?: true; value?: { at: number | null; runs: boolean } }

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
  const read = { at: separator === -1 ? null : separator + 1, runs: name === wrapper.split?.long }
  return name === wrapper.split?.long && value !== undefined ? { next, split: value, value: read } : { next, value: read }
}

function readShort(wrapper: Wrapper, words: readonly string[], index: number): ReadOption {
  const word = words[index]!
  let session = false
  for (let offset = 1; offset < word.length; offset++) {
    const character = word.charAt(offset)
    if (wrapper.runsNothing?.short.includes(character)) return { next: index + 1, runsNothing: true }
    session ||= wrapper.session?.short.includes(character) === true
    const runs = character === wrapper.split?.short || wrapper.replaces?.includes(character) === true
    // An optional value is only ever the rest of the cluster.
    if (wrapper.shortOptional?.includes(character)) return { next: index + 1, value: { at: offset + 1, runs }, ...(session ? { session: true } : {}) }
    if (!wrapper.shortValues?.includes(character)) continue
    const attached = word.slice(offset + 1)
    const value = attached.length > 0 ? attached : words[index + 1]
    const next = attached.length > 0 ? index + 1 : index + 2
    const read = { at: attached.length > 0 ? offset + 1 : null, runs }
    if (character === wrapper.split?.short && value !== undefined) return { next, split: value, value: read }
    return { next, value: read, ...(session ? { session: true } : {}) }
  }
  return { next: index + 1, ...(session ? { session: true } : {}) }
}

/** A redirection of a statement's input (`<file`, `0<<<text`, `<&3`); STDIN_HEREDOC when it is a heredoc. */
const STDIN_REDIRECTION = /^0?</
const STDIN_HEREDOC = /^0?<<(?!<)/

/**
 * A statement's words (statementForm), and `other`, its words as the other shells read a bare operator ending in `!`, or
 * null; `bare`, the index in `words` of each word that is only a substitution a head cut (`$$()`), unquoted, which may
 * expand to no word.
 */
interface StatementForm { words: string[]; heredoc: boolean; expanded: Expanded; other: string[] | null; bare: number[] }

/** An unquoted word that is only the bodies a head cut, each written `$$()`, which may expand to no word at all. */
const BARE_SUBSTITUTION = /^(?:\$\$\(\))+$/

/** Each reading of a statement's words: one, or two where a redirection's meaning depends on the shell. */
const readingsOf = (form: StatementForm): string[][] => (form.other === null ? [form.words] : [form.words, form.other])

/**
 * A statement's words without its redirections, so `make > /dev/null` is judged as `make`. Only an unquoted
 * operator redirects: `git clean -e '>' -f` hands git a `>` and keeps its `-f` (slice 7 review F2). `heredoc` says
 * the last redirection of its input is a heredoc, which Buckle reads. Where a bare operator ends in `!`, `other` reads
 * it as bash does, its target `!` and the next word one of the command's (redirectionReadings), `expanded` holding the
 * words of both. Null when the budget's words ran out before the statement was read whole.
 */
function statementForm(statement: string, budget: Budget): StatementForm | null {
  const { tokens, more } = shellTokensUpTo(statement, Math.max(0, budget.words))
  budget.words -= tokens.length
  if (more) {
    budget.spent = true
    return null
  }
  const readings = redirectionReadings(tokens)
  const first = statementWords(tokens, readings[0]!)
  if (readings.length === 1) return { ...first, other: null }
  const second = statementWords(tokens, readings[1]!)
  const expanded = new Map(first.expanded)
  for (const [word, met] of second.expanded) expanded.set(word, mergedExpansion(expanded.get(word), met))
  return { words: first.words, heredoc: first.heredoc && second.heredoc, expanded, other: second.words, bare: first.bare }
}

/** A word seen two ways may do what either does: name a command, split, or start with only the text both share. */
const mergedExpansion = (known: Expansion | undefined, met: Expansion): Expansion =>
  known === undefined ? met : { command: known.command || met.command, splits: known.splits || met.splits, prefix: sharedStart(known.prefix, met.prefix) }

/** A statement's words in one reading of its redirections (statementForm). */
function statementWords(tokens: readonly ShellToken[], clobber: boolean): { words: string[]; heredoc: boolean; expanded: Expanded; bare: number[] } {
  const words: string[] = []
  const bare: number[] = []
  let heredoc = false
  let expanded: Map<string, Expansion> | null = null
  for (let index = 0; index < tokens.length; index++) {
    const { raw, word } = tokens[index]!
    if (!REDIRECTION.test(raw)) {
      if (BARE_SUBSTITUTION.test(raw)) bare.push(words.length)
      words.push(word)
      if (holdsExpansion(raw)) {
        expanded ??= new Map()
        // A word that expands more than a leading tilde before a typed basename may name another command: a lone `~`,
        // `~+`, `~-`, `~2`, or `~user` is the whole name, which HOME, PWD, OLDPWD, the directory stack, or a home holds,
        // and the call may set the first three; a word seen two ways may do what either does (mergedExpansion).
        const met: Expansion = { command: !raw.startsWith('~') || holdsExpansion(raw.slice(1)) || !TYPED_BASENAME.test(word), ...expansionShape(raw) }
        expanded.set(word, mergedExpansion(expanded.get(word), met))
      }
      continue
    }
    if (STDIN_REDIRECTION.test(raw)) heredoc = STDIN_HEREDOC.test(raw)
    if (takesNextWord(raw, clobber)) index++
  }
  return { words, heredoc, expanded: expanded ?? NO_WORDS, bare }
}

/** The text two strings start with. */
function sharedStart(one: string, other: string): string {
  let length = 0
  while (length < one.length && length < other.length && one[length] === other[length]) length++
  return one.slice(0, length)
}
