import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isInside } from '../../domain/paths.js'
import { ToolInputError } from '../../domain/tool.js'
import { gitDirectory, readBounded, readRepositoryConfig } from './remote.js'

/** `[filter "name"]`, whose `clean`, `smudge` and `process` values are programs `git add` runs. */
const FILTER_SECTION_PATTERN = /^\s*\[\s*filter\b/i
/** A `filter=driver` attribute, which is what points a path at such a program. */
const FILTER_ATTRIBUTE_PATTERN = /(?:^|\s)filter=\S/
const MAX_ATTRIBUTES_BYTES = 262_144
/** Emptied rather than inherited, so curl cannot be handed a proxy through the environment. */
const PROXY_VARIABLES = ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']

export interface GitConfig {
  key: string
  value: string
}

/**
 * The system and global configs are made invisible and the terminal prompt is closed, so the
 * repository config is all that is left; its executable and routing knobs are overridden below.
 * `buildChildEnvironment` already drops every variable off its allowlist, and the proxy variables
 * are named again here so a later addition to that allowlist cannot re-route a push.
 */
export const ISOLATION_ENVIRONMENT: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  ...Object.fromEntries(PROXY_VARIABLES.map(name => [name, ''])),
}

/**
 * Git hands anything it runs its whole environment, credential included, and a workspace can
 * write `.git/hooks/pre-push`, a `credential.helper`, a proxy or a signing program with an
 * ordinary file write. Every forge git call therefore runs with hooks pointed at an empty
 * Buckle-owned directory and with every repository key that names a program or re-routes a
 * request overridden. Git reads this scope last, so a repository config cannot win it back.
 *
 * Deliberately not overridden, with the reason each is safe to leave:
 * - `http.sslBackend`, `credential.useHttpPath` — neither names a path to run: one picks a TLS
 *   library compiled into git, the other only changes how a helper keys its lookup, and the
 *   helper list is reset to empty here anyway.
 * - `merge.tool`, `diff.tool`, `difftool.*`, `mergetool.*` — only `git mergetool` and
 *   `git difftool` run them, and this pack invokes neither.
 * - `diff.<driver>.textconv` — only runs where a patch is generated, and every `git show` here
 *   passes `--no-patch` or `--name-only`.
 * - `core.sshCommand`, `core.gitProxy` — `classifyRemote` refuses an ssh or git:// origin, so
 *   neither transport is ever started.
 * - `filter.<name>.*` — a section rather than a key, so no override can reset it;
 *   `assertNoFilters` refuses the repository instead.
 * - `remote.<name>.receivepack` and `uploadpack` — git keeps the *first* value it reads, so this
 *   scope cannot reset them; `git_push` passes `--receive-pack=git-receive-pack` on the command
 *   line, which does win, and no forge tool fetches, so `uploadpack` is never consulted.
 * - `https.proxy` is reset below although git reads the `http` section for https URLs too; the
 *   cost is one entry and the cost of a curl-style spelling one day being honoured is the
 *   credential.
 */
export function isolationConfig(hooksDirectory: string): GitConfig[] {
  return [
    { key: 'core.hooksPath', value: hooksDirectory },
    // An empty value resets the helper list, so a repository's `!sh -c …` helper never runs.
    { key: 'credential.helper', value: '' },
    { key: 'core.fsmonitor', value: 'false' },
    // A proxy is handed the credential header in full, and an unverified certificate lets
    // whatever answers terminate the connection. Both are plain repository config.
    { key: 'http.proxy', value: '' },
    { key: 'https.proxy', value: '' },
    { key: 'remote.origin.proxy', value: '' },
    { key: 'http.sslVerify', value: 'true' },
    // Every key below names a program git would otherwise run.
    { key: 'core.askpass', value: '' },
    { key: 'commit.gpgSign', value: 'false' },
    { key: 'tag.gpgSign', value: 'false' },
    { key: 'gpg.program', value: '' },
    { key: 'gpg.format', value: '' },
    { key: 'core.editor', value: 'true' },
    { key: 'sequence.editor', value: 'true' },
    { key: 'core.pager', value: 'cat' },
    { key: 'diff.external', value: '' },
    { key: 'core.attributesFile', value: '/dev/null' },
  ]
}

/**
 * The same proxy and TLS resets again at the origin's own URL scope. Git matches a URL-scoped
 * `http.<url>.*` key ahead of the plain one whatever order the scopes are read in, so without
 * this a repository could route the push through its own proxy past the resets above.
 */
export function transportConfig(originUrl: string): GitConfig[] {
  return [
    { key: `http.${originUrl}.proxy`, value: '' },
    { key: `http.${originUrl}.sslVerify`, value: 'true' },
  ]
}

/** Config git reads after every file, so nothing the workspace wrote can override it. */
export function gitConfigEnvironment(entries: GitConfig[]): Record<string, string> {
  const environment: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) }
  entries.forEach((entry, index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = entry.key
    environment[`GIT_CONFIG_VALUE_${index}`] = entry.value
  })
  return environment
}

/**
 * A clean filter is a program the repository names and `git add` runs, before anything else this
 * pack does. `filter.<name>.*` is a config section rather than one key, so the override scope
 * cannot reset it; the repository is refused instead, the way an `include` is. The driver can
 * only be defined in the repository config — the other scopes are out of reach — so the
 * attributes files are checked as well but are not what closes this.
 */
export function assertNoFilters(input: { repository: string; paths: string[] }): void {
  const config = readRepositoryConfig(input.repository)
  if (config.split('\n').some(line => FILTER_SECTION_PATTERN.test(line))) {
    throw new ToolInputError(`${input.repository} has a git config defining a filter driver, whose clean program git runs while staging; the forge tools refuse the repository rather than running workspace code under the node's identity`, { code: 'PERMISSION_DENIED' })
  }
  for (const file of attributeFiles(input)) {
    const content = readBounded({ path: file, maxBytes: MAX_ATTRIBUTES_BYTES, subject: `${file} is not an attributes file the forge tools can read` })
    if (!FILTER_ATTRIBUTE_PATTERN.test(content)) continue
    throw new ToolInputError(`${file} gives a committed path a filter attribute, and a filter names a program git runs while staging; the forge tools refuse the commit rather than running it`, { code: 'PERMISSION_DENIED' })
  }
}

/** The attributes files git consults for the named paths: one per directory above each, plus `.git/info/attributes`. */
function attributeFiles(input: { repository: string; paths: string[] }): string[] {
  const files = new Set<string>([join(gitDirectory(input.repository), 'info', 'attributes')])
  for (const named of input.paths) {
    let directory = join(input.repository, named)
    while (isInside(input.repository, directory)) {
      files.add(join(directory, '.gitattributes'))
      if (directory === input.repository) break
      directory = dirname(directory)
    }
  }
  return [...files].filter(file => existsSync(file))
}
