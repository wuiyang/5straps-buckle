import { baseCommand, parseArgv, shellStatements, shellWords } from './argv.js'

/** How many wrappers, or shell bodies inside shell bodies, are read before the rest is called unread. */
const MAX_DEPTH = 8

/**
 * A program that runs the command named after its own options and operands. Only the options that take a
 * value are listed: getopt reads every other one as a flag, and each of these stops at its first operand.
 */
interface Wrapper {
  /** Short options taking a value: the rest of the cluster, or else the next word. */
  shortValues?: string
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
}

/**
 * The prefixes that run another command (the continuation review, "Seen outside this range": `env git push
 * --force` passed the destructive floor and the command policy). Their option tables follow each program's
 * getopt string (coreutils env, nice, nohup, timeout and stdbuf; GNU time; util-linux ionice and chrt; the
 * shell's `command` and `exec`).
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
}

/** Words a shell reads before the command of a statement (`if git push -f; then`), none taking an option. */
const SHELL_KEYWORDS = new Set(['!', '{', 'if', 'then', 'else', 'elif', 'do', 'while', 'until'])
const KEYWORD: Wrapper = {}

/** A redirection word: optional descriptor digits, then `<` or `>`; a bare operator's target is the next word. */
const REDIRECTION = /^\d*[<>]/
const BARE_REDIRECTION = /^\d*(?:<<?<?|>>?|>\||<>)$/

export interface CommandForms {
  /** The call as typed, then the command behind each wrapper prefix in turn: the last one is what runs. */
  chain: string[][]
  /** Every command a shell body in the chain runs, each with its own chain and bodies, flattened. */
  nested: string[][]
  /** Wrappers or shell bodies nested deeper than Buckle reads, so a command was left unread. */
  unread: boolean
}

/**
 * Every command a call runs, as words a rule judges (each command word reduced to its basename): the call
 * itself, the command behind each wrapper prefix, and each statement of a shell body, recursively. Display and
 * identity never use these forms; a rule shows and binds the raw argv (owner decision D17).
 */
export function commandForms(command: string, args: readonly string[]): CommandForms {
  return formsOf([baseCommand(command), ...args], 0)
}

/** Every form, in the order a rule should meet them: the call as typed first. */
export function allForms(forms: CommandForms): string[][] {
  return [...forms.chain, ...forms.nested]
}

function formsOf(words: string[], depth: number): CommandForms {
  const { chain, unread } = wrapperChain(words)
  const runs = chain.at(-1) ?? words
  const nested: string[][] = []
  let deeper = unread
  for (const statement of shellStatements(parseArgv(runs[0] ?? '', runs.slice(1)))) {
    const form = statementForm(statement)
    if (form.length === 0) continue
    if (depth >= MAX_DEPTH) return { chain, nested, unread: true }
    const inner = formsOf(form, depth + 1)
    nested.push(...inner.chain, ...inner.nested)
    deeper ||= inner.unread
  }
  return { chain, nested, unread: deeper }
}

function wrapperChain(words: string[]): { chain: string[][]; unread: boolean } {
  const chain = [words]
  let current = words
  for (let depth = 0; ; depth++) {
    const command = current[0] ?? ''
    const wrapper = WRAPPERS[command] ?? (SHELL_KEYWORDS.has(command) ? KEYWORD : undefined)
    if (!wrapper) return { chain, unread: false }
    if (depth >= MAX_DEPTH) return { chain, unread: true }
    const inner = innerCommand(wrapper, current.slice(1))
    if (!inner?.[0]) return { chain, unread: false }
    current = [baseCommand(inner[0]), ...inner.slice(1)]
    chain.push(current)
  }
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
    if (!wrapper.shortValues?.includes(character)) continue
    const attached = word.slice(offset + 1)
    const value = attached.length > 0 ? attached : words[index + 1]
    const next = attached.length > 0 ? index + 1 : index + 2
    return character === wrapper.split?.short && value !== undefined ? { next, split: value } : { next }
  }
  return { next: index + 1 }
}

/** A statement's words without its redirections, so `make > /dev/null` is judged as `make`, its command word reduced like any other. */
function statementForm(statement: string): string[] {
  const words = shellWords(statement)
  const kept: string[] = []
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!
    if (!REDIRECTION.test(word)) {
      kept.push(word)
      continue
    }
    if (BARE_REDIRECTION.test(word)) index++
  }
  const [command, ...rest] = kept
  return command === undefined ? [] : [baseCommand(command), ...rest]
}
