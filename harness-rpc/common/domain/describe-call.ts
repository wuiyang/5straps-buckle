import type { JsonObject, JsonValue } from '@5straps/protocol'
import { printable } from './approval-instruction.js'

/** Longest fact a description quotes whole: a command, a URL, a pattern; paths get more room. */
const FACT_LENGTH = 200
const PATH_LENGTH = 1_024
/** How many paths a batch names before it counts the rest. */
const LISTED_PATHS = 5

/**
 * What a call does, in words Buckle writes for the person who approves it (owner decision D9): built
 * from the tool, the directory the call runs in and facts its arguments state (a path, a size, a
 * command, a URL, a count), never from text the agent chose to explain itself (a commit message, a
 * pull request's title or body, a file's content). Every fact passes through printable(), so what a
 * terminal shows is what the arguments hold. It rides inside the node-signed challenge, where a
 * relay that rewrites it breaks the signature.
 */
export function describeCall(input: { tool: string; args: JsonObject; cwd: string }): string {
  return `${describeAction(input.tool, input.args)} in ${fact(input.cwd, PATH_LENGTH)}`
}

function describeAction(tool: string, args: JsonObject): string {
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
    case 'fs_find_names': return `Find names matching ${quoted(args.pattern)} under ${path()}`
    case 'fs_search_content': return `Search file contents for ${quoted(args.pattern)} under ${path()}`
    case 'shell_exec': return `Run ${quoted([text(args.command) ?? '', ...strings(args.args)].join(' '))}${shellExtras(args)}`
    case 'script_run': return `Run a ${fact(text(args.runtime) ?? 'shell')} script of ${bytes(args.script)}${shellExtras(args)}`
    case 'web_fetch': return `Send ${fact(text(args.method) ?? 'GET')} to ${fact(text(args.url) ?? '')}${args.body === undefined ? '' : ` with a body of ${bytes(args.body)}`}${names(' with headers', args.headers)}`
    case 'web_search': return `Search the web for ${quoted(args.query)}`
    case 'browser_command': return `Run the browser command ${quoted([text(args.command) ?? '', ...strings(args.args)].join(' '))}`
    case 'git_commit': return `Commit ${count(strings(args.paths).length, 'path')} in ${path('repo')}: ${paths(strings(args.paths))}`
    case 'git_push': return `Push branch ${fact(text(args.branch) ?? '')} of ${path('repo')}${args.force === true ? ', forced' : ''}${args.setUpstream === true ? ', setting its upstream' : ''}`
    case 'pr_open': return `Open a pull request from ${fact(text(args.head) ?? '')} into ${fact(text(args.base) ?? '')} for ${path('repo')}`
    case 'pr_read': return `Read pull request ${fact(String(args.number ?? ''))} of ${path('repo')}`
    case 'git_status': case 'git_diff': case 'git_log': case 'git_branch': return `Read the git ${tool.slice(4)} of ${path('repo')}`
    case 'git_blame': return `Read the git blame of ${path()} in ${path('repo')}`
    case 'lsp_rename': return `Rename the symbol at ${path()} line ${fact(String(args.line ?? ''))} to ${quoted(args.newName)}`
    default: return `Call ${fact(tool)}${text(args.path) === undefined ? '' : ` on ${path()}`}`
  }
}

/** What else a shell call reaches: its own working directory, the network, variables it sets and credential files it reads. */
function shellExtras(args: JsonObject): string {
  const cwd = text(args.cwd)
  return `${cwd === undefined || cwd === '.' ? '' : ` from ${fact(cwd, PATH_LENGTH)}`}${args.allowNetwork === true ? ', with network access' : ''}${names(', setting', args.env)}${strings(args.sensitiveFiles).length > 0 ? `, reading ${paths(strings(args.sensitiveFiles))}` : ''}`
}

/** The names a record sets (never their values), as `prefix A, B`. */
function names(prefix: string, value: JsonValue | undefined): string {
  const keys = value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : []
  return keys.length === 0 ? '' : `${prefix} ${keys.slice(0, LISTED_PATHS).map(key => fact(key)).join(', ')}${keys.length > LISTED_PATHS ? ` and ${keys.length - LISTED_PATHS} more` : ''}`
}

function paths(values: string[]): string {
  const listed = values.slice(0, LISTED_PATHS).map(value => fact(value, PATH_LENGTH)).join(', ')
  return values.length > LISTED_PATHS ? `${listed} and ${values.length - LISTED_PATHS} more` : listed
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

function quoted(value: JsonValue | undefined): string {
  return `\`${fact(text(value) ?? '')}\``
}

/** One fact as a person reads it: every unprintable character escaped, and a long one cut with its length named. */
function fact(value: string, limit = FACT_LENGTH): string {
  const shown = printable(value)
  return shown.length > limit ? `${shown.slice(0, limit)}... (${value.length} characters)` : shown
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
