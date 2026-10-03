import { redactCredentials } from '@5straps/runtime'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import { printable } from './approval-instruction.js'
import { shownCommand } from './argv.js'

/** Longest fact a description quotes whole: a command, a URL, a pattern; paths get more room. */
const FACT_LENGTH = 200
const PATH_LENGTH = 1_024
/** How many paths a batch names before it counts the rest. */
const LISTED_PATHS = 5
/**
 * The longest description, suffix included: below the 4,096 characters a signed challenge holds, so a
 * batch of long paths is cut rather than failing every challenge (review M3 of the second
 * proof-of-possession re-review). The description is a summary beside the whole arguments (owner
 * decisions D9 and D17), never in place of them, so a cut one says so in its own words and sets no flag.
 */
export const MAX_DESCRIPTION_LENGTH = 4_000
/** What a cut description keeps, leaving room for the suffix that counts what was cut. */
const KEPT_DESCRIPTION_LENGTH = 3_880
/** What a description with a cut fact ends with: the arguments a person reads below it are whole. */
export const SUMMARY_CUT = '[summary cut; the arguments below are complete]'

/**
 * What a call does, in words Buckle writes for the person who approves it (owner decision D9): built
 * from the tool, the directory the call runs in and facts its arguments state (a path, a size, a
 * command, a URL, a count), never from text the agent chose to explain itself (a commit message, a
 * pull request's title or body, a file's content). Each fact is one value, hidden where owner ruling B
 * hides one (redactCredentials), quoted as a JSON string, so no byte an agent sent can
 * close its quote and pose as Buckle's words, and escaped by printable(), so what a terminal shows is what the arguments hold
 * (review M2 and L6 of the second re-review). A fact or a description cut to fit says how long it was,
 * outside any quote, and that the arguments shown with it are complete. It rides inside the node-signed
 * challenge, where a relay that rewrites it breaks the signature.
 */
export function describeCall(input: { tool: string; args: JsonObject; cwd: string }): string {
  const cut = { truncated: false }
  const facts = factsOf(cut)
  return capped(`${describeAction(input.tool, input.args, facts)} in ${facts.fact(input.cwd, PATH_LENGTH)}`, cut)
}

interface Facts {
  fact(value: string, limit?: number): string
  command(command: string, args: string[]): string
  paths(values: string[]): string
  names(prefix: string, value: JsonValue | undefined): string
}

function describeAction(tool: string, args: JsonObject, facts: Facts): string {
  const { fact, paths, names } = facts
  const path = (key = 'path') => fact(text(args[key]) ?? '.', PATH_LENGTH)
  switch (tool) {
    case 'fs_read': return `Read ${path()}`
    case 'fs_read_batch': return `Read ${count(strings(args.paths).length, 'file')}: ${paths(strings(args.paths))}`
    case 'fs_write': return `Write ${bytes(args.content, args.encoding)} to ${path()}`
    case 'fs_write_batch': {
      const files = records(args.files)
      const total = files.reduce((sum, file) => sum + byteCount(file.content, file.encoding), 0)
      return `Write ${count(files.length, 'file')}, ${total} bytes in all: ${paths(files.map(file => text(file.path) ?? ''))}`
    }
    case 'fs_patch': return `Replace text in ${path()} (${count(records(args.edits).length, 'edit')})`
    case 'fs_list': return `List ${path()}`
    case 'fs_find_names': return `Find names matching ${fact(text(args.pattern) ?? '')} under ${path()}`
    case 'fs_search_content': return `Search file contents for ${fact(text(args.pattern) ?? '')} under ${path()}`
    case 'shell_exec': return `Run ${facts.command(text(args.command) ?? '', strings(args.args))}${shellExtras(args, facts)}`
    case 'script_run': return `Run a ${fact(text(args.runtime) ?? 'shell')} script of ${bytes(args.script)}${shellExtras(args, facts)}`
    case 'web_fetch': return `Send ${fact(text(args.method) ?? 'GET')} to ${fact(text(args.url) ?? '')}${args.body === undefined ? '' : ` with a body of ${bytes(args.body)}`}${names(' with headers', args.headers)}`
    case 'web_search': return `Search the web for ${fact(text(args.query) ?? '')}`
    case 'browser_command': return `Run the browser command ${facts.command(text(args.command) ?? '', strings(args.args))}`
    case 'git_commit': return `Commit ${count(strings(args.paths).length, 'path')} in ${path('repo')}: ${paths(strings(args.paths))}`
    case 'git_push': return `Push branch ${fact(text(args.branch) ?? '')} of ${path('repo')}${args.force === true ? ', forced' : ''}${args.setUpstream === true ? ', setting its upstream' : ''}`
    case 'pr_open': return `Open a pull request from ${fact(text(args.head) ?? '')} into ${fact(text(args.base) ?? '')} for ${path('repo')}`
    case 'pr_read': return `Read pull request ${fact(String(args.number ?? ''))} of ${path('repo')}`
    case 'git_status': case 'git_diff': case 'git_log': case 'git_branch': return `Read the git ${tool.slice(4)} of ${path('repo')}`
    case 'git_blame': return `Read the git blame of ${path()} in ${path('repo')}`
    case 'lsp_rename': return `Rename the symbol at ${path()} line ${fact(String(args.line ?? ''))} to ${fact(text(args.newName) ?? '')}`
    default: return `Call ${fact(tool)}${text(args.path) === undefined ? '' : ` on ${path()}`}`
  }
}

/** What else a shell call reaches: its own working directory, the network, variables it sets and credential files it reads. */
function shellExtras(args: JsonObject, facts: Facts): string {
  const cwd = text(args.cwd)
  return `${cwd === undefined || cwd === '.' ? '' : ` from ${facts.fact(cwd, PATH_LENGTH)}`}${args.allowNetwork === true ? ', with network access' : ''}${facts.names(', setting', args.env)}${strings(args.sensitiveFiles).length > 0 ? `, reading ${facts.paths(strings(args.sensitiveFiles))}` : ''}`
}

/** The fact quoting of one description, which records whether it cut any fact. */
function factsOf(cut: { truncated: boolean }): Facts {
  /** Shown text quoted and escaped, and when cut, its length named outside the quote. */
  const show = (shown: string, length: number, limit: number): string => {
    if (shown.length <= limit) return quote(shown)
    cut.truncated = true
    return `${quote(wholeCharacters(shown, limit))} (cut from ${length} characters)`
  }
  /** One fact as a person reads it: read as one value, quoted, escaped, and when cut, its length named outside the quote. */
  const fact = (value: string, limit = FACT_LENGTH): string => show(redactCredentials(value, 'value'), value.length, limit)
  return {
    fact,
    /**
     * A command as shownCommand shows it, each word read in its own place and quoted for a shell. It is not read
     * again as one value: a shell body in it stays as written.
     */
    command(command, args) {
      const shown = shownCommand(command, args)
      return show(shown, shown.length, FACT_LENGTH)
    },
    paths(values) {
      const listed = values.slice(0, LISTED_PATHS).map(value => fact(value, PATH_LENGTH)).join(', ')
      return values.length > LISTED_PATHS ? `${listed} and ${values.length - LISTED_PATHS} more` : listed
    },
    /** The names a record sets (never their values), as `prefix A, B`. */
    names(prefix, value) {
      const keys = value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : []
      return keys.length === 0 ? '' : `${prefix} ${keys.slice(0, LISTED_PATHS).map(key => fact(key)).join(', ')}${keys.length > LISTED_PATHS ? ` and ${keys.length - LISTED_PATHS} more` : ''}`
    },
  }
}

function quote(value: string): string {
  return printable(JSON.stringify(value))
}

/**
 * A description over MAX_DESCRIPTION_LENGTH, cut to KEPT_DESCRIPTION_LENGTH with a closing quote where the
 * cut fell inside one, and a suffix that counts what was kept; one with a cut fact ends with SUMMARY_CUT.
 * Either says in its own words that the arguments shown beside it are the whole call (owner decision D17).
 */
function capped(text: string, cut: { truncated: boolean }): string {
  const summary = cut.truncated ? `${text} ${SUMMARY_CUT}` : text
  if (summary.length <= MAX_DESCRIPTION_LENGTH) return summary
  const kept = closeQuote(wholeCharacters(text, KEPT_DESCRIPTION_LENGTH))
  return `${kept} [summary cut: ${KEPT_DESCRIPTION_LENGTH} of ${text.length} characters shown; the arguments below are complete]`
}

/** Text cut inside a quoted fact, closed: a dangling escape dropped, then the quote closed, so the suffix reads as Buckle's. */
function closeQuote(text: string): string {
  let quoted = false
  let escaped = false
  for (const character of text) {
    if (escaped) escaped = false
    else if (quoted && character === '\\') escaped = true
    else if (character === '"') quoted = !quoted
  }
  if (!quoted) return text
  return `${escaped ? text.slice(0, -1) : text}"`
}

/** The first `length` UTF-16 units, one fewer where the cut would split a surrogate pair. */
function wholeCharacters(text: string, length: number): string {
  const end = /[\uD800-\uDBFF]/.test(text.charAt(length - 1)) ? length - 1 : length
  return text.slice(0, end)
}

function bytes(value: JsonValue | undefined, encoding?: JsonValue): string {
  return count(byteCount(value, encoding), 'byte')
}

function byteCount(value: JsonValue | undefined, encoding?: JsonValue): number {
  return typeof value === 'string' ? Buffer.byteLength(value, encoding === 'base64' ? 'base64' : 'utf8') : 0
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function strings(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function records(value: JsonValue | undefined): JsonObject[] {
  return Array.isArray(value) ? value.filter((item): item is JsonObject => item !== null && typeof item === 'object' && !Array.isArray(item)) : []
}
