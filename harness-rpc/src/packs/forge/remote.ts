import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { ForgeRepository } from '../../domain/forge.js'
import { ToolInputError } from '../../domain/tool.js'

const SECTION_PATTERN = /^\s*\[([^\]]+)\]\s*$/
const URL_PATTERN = /^\s*url\s*=\s*(.+?)\s*$/
/** `git@host:owner/repo.git`, the scp-like form git accepts without a scheme. */
const SCP_PATTERN = /^[^/]+@[^/:]+:/

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
    const url = new URL(value)
    const display = `${url.protocol}//${url.host}${url.pathname}`
    return { kind: 'https', url, host: url.hostname.toLowerCase(), display }
  }

  if (/^file:\/\//i.test(value)) {
    const path = new URL(value).pathname
    return { kind: 'local', path, display: path }
  }

  if (isAbsolute(value)) return { kind: 'local', path: value, display: value }
  throw new ToolInputError(`origin is ${value}, which is neither an https URL nor an absolute path`, { code: 'FORGE_NO_REMOTE' })
}

/** `owner/name` from an https remote. A local remote has no forge behind it, so it is refused. */
export function repositoryOf(remote: ForgeRemote): ForgeRepository {
  if (remote.kind !== 'https') {
    throw new ToolInputError(`origin is ${remote.display}, which names no forge repository; pull-request tools need an https origin`, { code: 'FORGE_NO_REMOTE' })
  }
  const parts = remote.url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/')
  const owner = parts.at(-2)
  const name = parts.at(-1)
  if (!owner || !name) throw new ToolInputError(`origin ${remote.display} does not name an owner and a repository`, { code: 'FORGE_NO_REMOTE' })
  return { owner, name }
}

/**
 * The origin URL read straight from the repository's config, because a tool declares its network
 * effect from parsed input before anything runs and a process cannot be spawned there. The push
 * itself re-reads the URL through git, which is what settles any rewrite rule this parser cannot
 * see.
 */
export function readOriginUrl(repository: string): string {
  const configPath = join(gitDirectory(repository), 'config')
  let content: string
  try {
    content = readFileSync(configPath, 'utf8')
  } catch {
    throw new ToolInputError(`${repository} is not a git repository`, { code: 'FORGE_NO_REMOTE' })
  }

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

function gitDirectory(repository: string): string {
  const dotGit = join(repository, '.git')
  let pointsToDirectory: boolean
  try {
    pointsToDirectory = statSync(dotGit).isDirectory()
  } catch {
    throw new ToolInputError(`${repository} is not a git repository`, { code: 'FORGE_NO_REMOTE' })
  }
  if (pointsToDirectory) return commonDirectory(dotGit)

  const pointer = readFileSync(dotGit, 'utf8').trim()
  if (!pointer.startsWith('gitdir:')) throw new ToolInputError(`${repository} has an unreadable .git pointer`, { code: 'FORGE_NO_REMOTE' })
  return commonDirectory(resolve(repository, pointer.slice('gitdir:'.length).trim()))
}

/** A linked worktree keeps its remotes in the main repository, named by `commondir`. */
function commonDirectory(gitDir: string): string {
  const marker = join(gitDir, 'commondir')
  if (!existsSync(marker)) return gitDir
  return resolve(gitDir, readFileSync(marker, 'utf8').trim())
}

function normalizeSection(raw: string): string {
  const [name = '', ...rest] = raw.trim().split(/\s+/)
  return [name.toLowerCase(), ...rest].join(' ')
}

function unquote(value: string): string {
  const withoutComment = value.replace(/\s+[#;].*$/, '')
  return withoutComment.replace(/^"(.*)"$/, '$1')
}
