import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { ForgeRepository } from '../../domain/forge.js'
import { ToolInputError } from '../../domain/tool.js'

const SECTION_PATTERN = /^\s*\[([^\]]+)\]\s*$/
const URL_PATTERN = /^\s*url\s*=\s*(.+?)\s*$/
/** `git@host:owner/repo.git`, the scp-like form git accepts without a scheme. */
const SCP_PATTERN = /^[^/]+@[^/:]+:/
/** `[include]` and `[includeIf "…"]`, which pull config in from anywhere on disk. */
const INCLUDE_LINE_PATTERN = /^\s*\[\s*include(if)?\b/i
const MAX_CONFIG_BYTES = 262_144
const MAX_POINTER_BYTES = 4_096
const DEFAULT_PORTS: Record<string, string> = { 'https:': '443', 'http:': '80' }

/**
 * Where a push goes: a forge reached over https, or a repository on this filesystem. `display`
 * drops any userinfo, because a remote configured with a credential in it would otherwise reach
 * the caller through the tool's own result.
 */
export type ForgeRemote =
  | { kind: 'https'; url: URL; host: string; display: string }
  | { kind: 'local'; path: string; display: string }

/**
 * Classifies an origin URL. ssh and git schemes are refused rather than pushed to: the forge
 * credential is an https bearer token, so an ssh push would silently use a key Buckle does not
 * hold and never judged.
 */
export function classifyRemote(raw: string): ForgeRemote {
  const value = raw.trim()
  if (!value) throw new ToolInputError('The repository has no origin remote URL', { code: 'FORGE_NO_REMOTE' })

  if (SCP_PATTERN.test(value) || /^(ssh|git):\/\//i.test(value)) {
    throw new ToolInputError(`origin is ${value}, which is ssh; the forge tools push over https so the owner's token is the only credential in play`, { code: 'PERMISSION_DENIED' })
  }

  if (/^https?:\/\//i.test(value)) {
    const url = parseUrl(value)
    const display = `${url.protocol}//${url.host}${url.pathname}`
    return { kind: 'https', url, host: url.hostname.toLowerCase(), display }
  }

  if (/^file:\/\//i.test(value)) {
    const path = parseUrl(value).pathname
    return { kind: 'local', path, display: path }
  }

  if (isAbsolute(value)) return { kind: 'local', path: value, display: value }
  throw new ToolInputError(`origin is ${value}, which is neither an https URL nor an absolute path`, { code: 'FORGE_NO_REMOTE' })
}

/**
 * Everything that decides which repository a push reaches: scheme, host, port and path. Two
 * remotes with the same subject are the same repository, so the `.git` suffix and a trailing
 * slash are normalised away rather than read as a different target.
 */
export function remoteSubject(remote: ForgeRemote): string {
  if (remote.kind !== 'https') return remote.path
  const port = remote.url.port || DEFAULT_PORTS[remote.url.protocol] || ''
  return `${remote.url.protocol}//${remote.host}:${port}${repositoryPath(remote.url.pathname)}`
}

/** `owner/name` from an https remote. A local remote has no forge behind it, so it is refused. */
export function repositoryOf(remote: ForgeRemote): ForgeRepository {
  if (remote.kind !== 'https') {
    throw new ToolInputError(`origin is ${remote.display}, which names no forge repository; pull-request tools need an https origin`, { code: 'FORGE_NO_REMOTE' })
  }
  const parts = repositoryPath(remote.url.pathname).replace(/^\/+/, '').split('/')
  const owner = parts.at(-2)
  const name = parts.at(-1)
  if (!owner || !name) throw new ToolInputError(`origin ${remote.display} does not name an owner and a repository`, { code: 'FORGE_NO_REMOTE' })
  return { owner, name }
}

/**
 * The origin URL read straight from the repository's config, because a tool declares its network
 * effect from parsed input before anything runs and a process cannot be spawned there. That read
 * happens before any permission rule has judged the path, so it is bounded, never follows an
 * `include`, and turns every failure into a refusal. The push itself re-reads the URL through
 * git, which is what settles any rewrite rule this parser cannot see.
 */
export function readOriginUrl(repository: string): string {
  const content = readRepositoryConfig(repository)

  let inOrigin = false
  for (const line of content.split('\n')) {
    const section = SECTION_PATTERN.exec(line)
    if (section) {
      inOrigin = normalizeSection(section[1] ?? '') === 'remote "origin"'
      continue
    }
    const url = inOrigin ? URL_PATTERN.exec(line) : null
    if (url?.[1]) return unquote(url[1])
  }
  throw new ToolInputError(`${repository} has no origin remote`, { code: 'FORGE_NO_REMOTE' })
}

/**
 * The repository config, bounded and with an `include` refused rather than followed, because it
 * is the last config scope the forge tools cannot replace and every guard reading it needs the
 * same guarantee that what it reads is all git will read.
 */
export function readRepositoryConfig(repository: string): string {
  const content = readBounded({
    path: join(gitDirectory(repository), 'config'),
    maxBytes: MAX_CONFIG_BYTES,
    subject: `${repository} is not a git repository this pack can read`,
  })
  assertNoInclude({ repository, content })
  return content
}

/**
 * An included file would hand git a different origin than this parser reads, and following it
 * would read a path nothing judged. The repository is refused instead.
 */
function assertNoInclude(input: { repository: string; content: string }): void {
  if (!input.content.split('\n').some(line => INCLUDE_LINE_PATTERN.test(line))) return
  throw new ToolInputError(`${input.repository} has a git config that includes another file, so its origin is not the one this config names; the forge tools refuse it rather than following the include`, { code: 'PERMISSION_DENIED' })
}

export function gitDirectory(repository: string): string {
  const dotGit = join(repository, '.git')
  let pointsToDirectory: boolean
  try {
    pointsToDirectory = statSync(dotGit).isDirectory()
  } catch {
    throw new ToolInputError(`${repository} is not a git repository`, { code: 'FORGE_NO_REMOTE' })
  }
  if (pointsToDirectory) return commonDirectory(dotGit)

  const pointer = readBounded({ path: dotGit, maxBytes: MAX_POINTER_BYTES, subject: `${repository} has an unreadable .git pointer` }).trim()
  if (!pointer.startsWith('gitdir:')) throw new ToolInputError(`${repository} has an unreadable .git pointer`, { code: 'FORGE_NO_REMOTE' })
  return commonDirectory(resolve(repository, pointer.slice('gitdir:'.length).trim()))
}

/** A linked worktree keeps its remotes in the main repository, named by `commondir`. */
function commonDirectory(gitDir: string): string {
  const marker = join(gitDir, 'commondir')
  if (!existsSync(marker)) return gitDir
  return resolve(gitDir, readBounded({ path: marker, maxBytes: MAX_POINTER_BYTES, subject: `${gitDir} has an unreadable commondir` }).trim())
}

/** Reads at most `maxBytes` of a regular file, so a named pipe or a huge file is a refusal. */
export function readBounded(input: { path: string; maxBytes: number; subject: string }): string {
  const refusal = new ToolInputError(input.subject, { code: 'FORGE_NO_REMOTE' })
  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(input.path)
  } catch {
    throw refusal
  }
  if (!stats.isFile()) throw refusal
  if (stats.size > input.maxBytes) {
    throw new ToolInputError(`${input.path} is larger than the ${input.maxBytes} bytes the forge tools read of a git config`, { code: 'FORGE_NO_REMOTE' })
  }

  let handle: number | null = null
  try {
    handle = openSync(input.path, 'r')
    const buffer = Buffer.alloc(input.maxBytes)
    const read = readSync(handle, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    throw refusal
  } finally {
    if (handle !== null) closeSync(handle)
  }
}

/** The value is a remote's own config line, so a parse failure is a refusal rather than a crash. */
function parseUrl(value: string): URL {
  try {
    return new URL(value)
  } catch {
    throw new ToolInputError('origin is not a URL git and Buckle can both read', { code: 'FORGE_NO_REMOTE' })
  }
}

/** The `.git` suffix and a trailing slash name the same repository. */
function repositoryPath(pathname: string): string {
  return pathname.replace(/\/+$/, '').replace(/\.git$/i, '')
}

function normalizeSection(raw: string): string {
  const [name = '', ...rest] = raw.trim().split(/\s+/)
  return [name.toLowerCase(), ...rest].join(' ')
}

function unquote(value: string): string {
  const withoutComment = value.replace(/\s+[#;].*$/, '')
  return withoutComment.replace(/^"(.*)"$/, '$1')
}
