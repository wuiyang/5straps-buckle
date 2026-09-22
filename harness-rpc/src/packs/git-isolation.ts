import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ToolExecutionError } from '../domain/tool.js'

/** Empty, Buckle-owned, and where `core.hooksPath` points, so no hook the workspace wrote runs. */
const HOOKS_DIRECTORY = 'git-hooks'
/** `filter.<driver>.clean`, `.smudge` and `.process`: programs git runs to convert a worktree file. */
const FILTER_PROGRAM_KEY = /^filter\..+\.(clean|smudge|process)$/
/** Emptied rather than inherited, so curl cannot be handed a proxy through the environment. */
const PROXY_VARIABLES = ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']

export interface GitConfig {
  key: string
  value: string
}

/** As much of a `git config --list` answer as the caller of `configuredFilterPrograms` needs. */
export interface ConfigListing {
  exitCode: number | null
  stdout: string
  truncated: boolean
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
 * write `.git/hooks/pre-push`, a `core.fsmonitor` hook, a `credential.helper`, a proxy or a
 * signing program with an ordinary file write. Every git call Buckle makes therefore runs with
 * hooks pointed at an empty Buckle-owned directory and with every repository key that names a
 * program or re-routes a request overridden. Git reads this scope last, so a repository config
 * cannot win it back.
 *
 * Deliberately not overridden, with the reason each is safe to leave:
 * - `http.sslBackend`, `credential.useHttpPath` — neither names a path to run: one picks a TLS
 *   library compiled into git, the other only changes how a helper keys its lookup, and the
 *   helper list is reset to empty here anyway.
 * - `merge.tool`, `diff.tool`, `difftool.*`, `mergetool.*` — only `git mergetool` and
 *   `git difftool` run them, and no pack invokes either.
 * - `core.sshCommand`, `core.gitProxy` — `classifyRemote` refuses an ssh or git:// origin, so
 *   neither transport is ever started, and the read-only git pack reaches no remote at all.
 * - `remote.<name>.receivepack` and `uploadpack` — git keeps the *first* value it reads, so this
 *   scope cannot reset them; `git_push` passes `--receive-pack=git-receive-pack` on the command
 *   line, which does win, and no forge tool fetches, so `uploadpack` is never consulted.
 * - `https.proxy` is reset below although git reads the `http` section for https URLs too; the
 *   cost is one entry and the cost of a curl-style spelling one day being honoured is the
 *   credential.
 *
 * Two holes this scope cannot close on its own, because neither is one key:
 * - `diff.<driver>.command` and `diff.<driver>.textconv` run a program for a path its
 *   `.gitattributes` gives a `diff` attribute, and an empty `diff.external` does not stop
 *   either. A call that generates a patch passes `--no-ext-diff --no-textconv` instead; a call
 *   that generates none (`--no-patch`, `--name-only`, a plain `git log`) never consults them.
 * - `filter.<driver>.*` is a section rather than a key. `filterProgramOverrides` empties the
 *   ones a repository actually defines, which is what the read-only pack does; the forge pack
 *   refuses the repository instead, because emptying a clean filter while staging would commit
 *   content the repository means to convert.
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

/**
 * Empties every filter program the repository defines, named one key at a time because the
 * driver names are the repository's to choose. The keys come from git itself rather than from
 * a parse of `.git/config`, so a driver pulled in by an `include` is covered too. An emptied
 * driver leaves a read tool showing the bytes on disk rather than the converted form, which is
 * the trade this pack takes over running a workspace program.
 */
export function filterProgramOverrides(configuredKeys: string[]): GitConfig[] {
  return configuredKeys.filter(key => FILTER_PROGRAM_KEY.test(key)).map(key => ({ key, value: '' }))
}

/**
 * Which filter programs this repository defines, asked of git under the isolation scope rather
 * than parsed out of `.git/config`: git resolves an `include` and the `.git/config.worktree` that
 * `extensions.worktreeConfig` turns on, and neither is named in the text of the file a parser
 * reads. The system and global scopes are hidden by `ISOLATION_ENVIRONMENT`, so an operator's own
 * git-lfs configuration is not one of these keys.
 *
 * `spawn` runs git with that scope in force and no repository program in reach. Exit 1 is git
 * saying nothing is configured, which is an answer; a listing that did not complete is a refusal,
 * because an unread key is a program that would run.
 */
export async function configuredFilterPrograms<Listing extends ConfigListing>(input: {
  spawn: (args: string[]) => Promise<Listing>
  describeFailure: (result: Listing) => string
}): Promise<string[]> {
  const result = await input.spawn(['config', '--list', '--name-only', '--null'])
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new ToolExecutionError(input.describeFailure(result), { code: 'GIT_FAILED' })
  }
  if (result.truncated) {
    throw new ToolExecutionError('This repository has more git config than Buckle reads in one pass, so the tools cannot prove no filter program is defined; the repository is refused rather than one being run', { code: 'GIT_ISOLATION_UNAVAILABLE' })
  }
  return result.stdout.split('\0').filter(key => FILTER_PROGRAM_KEY.test(key))
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

/** Without it there is nothing to point git's hooks at, so git is not run at all. */
export function ensureHooksDirectory(stateDirectory: string): string {
  const directory = join(stateDirectory, HOOKS_DIRECTORY)
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  } catch {
    throw new ToolExecutionError(`Buckle could not create its empty hooks directory at ${directory}; git is not run with the workspace's hooks in reach`, { code: 'GIT_ISOLATION_UNAVAILABLE' })
  }
  return directory
}
