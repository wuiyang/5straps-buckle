import { mkdirSync } from 'node:fs'
import { join } from 'pathe'
import { ToolExecutionError } from '../../domain/tool.js'

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

/** As much of a `git config --list` answer as the caller of `configuredKeyNames` needs. */
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
 *
 * `GIT_PAGER` is here rather than in the config scope because `pager.<cmd>` is a program named
 * per command, which no single config key resets, and it outranks the `core.pager` below. Git
 * reads this variable ahead of both, so one entry closes the whole section without enumerating
 * the commands. Git pages nothing when its output is a pipe, which is every call Buckle makes
 * today, so this is what a caller that ever hands git a terminal inherits.
 *
 * `GIT_NO_LAZY_FETCH` stops a partial clone fetching a missing object from its promisor remote, a transport
 * the repository config names (review H1 of the slice 5 re-review). Git keeps it for the git it starts in the
 * destination of a local push, which loses the config scope below.
 */
export const ISOLATION_ENVIRONMENT: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  // A read refreshes no index and takes no index.lock it can do without (git status), so a read tool writes nothing.
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_PAGER: 'cat',
  GIT_NO_LAZY_FETCH: '1',
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
 * - `http.sslBackend`, `credential.useHttpPath`: neither names a path to run: one picks a TLS
 *   library compiled into git, the other only changes how a helper keys its lookup, and the
 *   helper list is reset to empty here anyway.
 * - `merge.tool`, `diff.tool`, `difftool.*`, `mergetool.*`: only `git mergetool` and
 *   `git difftool` run them, and no pack invokes either.
 * - `core.sshCommand`, `core.gitProxy`: `classifyRemote` refuses an ssh or git:// origin, so
 *   neither transport is ever started, and the read-only git pack reaches no remote at all.
 * - `remote.<name>.receivepack` and `uploadpack`: git keeps the *first* value it reads, so this
 *   scope cannot reset them; `git_push` passes `--receive-pack` on the command line, which does
 *   win, and no forge tool fetches, so `uploadpack` is never consulted.
 * - `https.proxy` is reset below although git reads the `http` section for https URLs too; the
 *   cost is one entry and the cost of a curl-style spelling one day being honoured is the
 *   credential.
 *
 * Three holes this scope cannot close on its own:
 * - `diff.<driver>.command` and `diff.<driver>.textconv` run a program for a path its
 *   `.gitattributes` gives a `diff` attribute, and an empty `diff.external` does not stop
 *   either. A call that generates a patch passes `--no-ext-diff --no-textconv` instead; a call
 *   that generates none (`--no-patch`, `--name-only`, a plain `git log`) never consults them.
 * - `filter.<driver>.*` is a section rather than a key. `filterProgramOverrides` empties the
 *   ones a repository actually defines, which is what the read-only pack does; the forge pack
 *   refuses the repository instead, because emptying a clean filter while staging would commit
 *   content the repository means to convert.
 * - `blame.ignoreRevsFile` names a file `git blame` opens as a list of object ids, and quotes the first line that is
 *   none in its error, so the key can print a line of any file the node's user can read. It is a list that no later
 *   value empties (git keeps it sorted, so an empty entry comes first), and the config listing below would name it in
 *   every repository if this scope held it. `git_blame` passes `--no-ignore-revs-file`, which does clear the list,
 *   and refuses a repository whose config names the key (git pack recheck 4, held[1]).
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
    // `pager.<cmd>` outranks this one and is a section rather than a key; `GIT_PAGER` above is
    // what closes that, and git reads the variable ahead of both of these.
    { key: 'core.pager', value: 'cat' },
    { key: 'diff.external', value: '' },
    { key: 'core.attributesFile', value: '/dev/null' },
    // A file git diff and git status read as an order of paths, with no read of it judged: its lines ordered a diff's
    // files, and a missing one failed the call quoting the configured place. An empty file is git's own order.
    { key: 'diff.orderFile', value: '/dev/null' },
  ]
}

/** Protocols a git started in a destination could reach a remote with; `protocol.allow` covers any other. */
const TRANSPORTS = ['file', 'git', 'ssh', 'http', 'https', 'ftp', 'ftps', 'ext', 'fd']

/**
 * What the receiving git of a push to a repository on this filesystem is started with (review H1 of the slice 5
 * re-review). Git starts `git-receive-pack` in the destination with GIT_CONFIG_COUNT and GIT_CONFIG_PARAMETERS
 * removed, so the scope `gitConfigEnvironment` carries never reaches it, and the destination's own hooks and
 * program keys would run on the host. The receiving git reads these from its own command line instead
 * (`receivePackCommand`), last, so the destination's config cannot win them back, and hands them on through
 * GIT_CONFIG_PARAMETERS to every git it starts (unpack-objects, index-pack, rev-list, gc).
 *
 * `hooksDirectory` is the only place the receiving git finds hooks: a push names Buckle's own guard directory there
 * (forge/receive-pack-guard.ts), so none of the destination's hooks runs.
 *
 * Everything `isolationConfig` resets, then what receive-pack itself honours:
 * - `core.alternateRefsCommand` lists an alternate's refs; `true` lists none, so none is advertised.
 * - `receive.autogc`, `gc.auto` and `maintenance.auto`: no gc or maintenance runs in the destination afterwards.
 * - `receive.denyCurrentBranch=refuse`, git's default: `updateInstead` would check the pushed branch out into the
 *   destination's worktree, running its filter programs and fsmonitor, so a push to its checked-out branch is refused.
 * - `protocol.allow` and each built-in transport's `protocol.<name>.allow` set to never, beside GIT_NO_LAZY_FETCH in
 *   the environment: a partial clone's lazy fetch would start a transport the destination's config names.
 * - `gpg.<format>.program` verify a signed push's certificate; Buckle never signs one, and they are emptied anyway.
 * - `core.sshCommand=false`: no ssh transport is allowed above; a program it names would not run either.
 *
 * Deliberately not reset, with the reason: `uploadpack.*` (receive-pack never runs upload-pack, and
 * `uploadpack.packObjectsHook` is read only from the system, global and command-line scopes, the first two
 * hidden); `filter.*` and `merge.<driver>.driver` (sections, which no single key resets: receive-pack checks
 * nothing out once `updateInstead` is refused, and merges nothing); `receive.procReceiveRefs` (a list no later
 * value empties: the proc-receive hook it names is out of reach with the hooks, so such a ref is refused).
 */
export function receivingIsolationConfig(hooksDirectory: string): GitConfig[] {
  return [
    ...isolationConfig(hooksDirectory),
    { key: 'core.alternateRefsCommand', value: 'true' },
    { key: 'receive.autogc', value: 'false' },
    { key: 'gc.auto', value: '0' },
    { key: 'maintenance.auto', value: 'false' },
    { key: 'receive.denyCurrentBranch', value: 'refuse' },
    { key: 'protocol.allow', value: 'never' },
    ...TRANSPORTS.map(name => ({ key: `protocol.${name}.allow`, value: 'never' })),
    { key: 'gpg.openpgp.program', value: '' },
    { key: 'gpg.x509.program', value: '' },
    { key: 'gpg.ssh.program', value: '' },
    { key: 'core.sshCommand', value: 'false' },
  ]
}

/**
 * The receive-pack a push to a repository on this filesystem starts: git itself, handed the receiving isolation as
 * `-c` options. Git runs its `--receive-pack` through a shell, so every word is single-quoted for one; the forge pack
 * runs this only once Buckle's guard can run (receive-pack-guard.ts, guardedReceivePackCommand).
 */
export function receivePackCommand(hooksDirectory: string): string {
  const words = ['git', ...receivingIsolationConfig(hooksDirectory).flatMap(entry => ['-c', `${entry.key}=${entry.value}`]), 'receive-pack']
  return words.map(word => `'${word.replaceAll("'", `'\\''`)}'`).join(' ')
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
 * Which keys this repository's config holds, asked of git under the isolation scope rather than parsed out of
 * `.git/config`: git resolves an `include` and the `.git/config.worktree` that `extensions.worktreeConfig` turns on,
 * and neither is named in the text of the file a parser reads. The section and the key are lowercase, as git lists
 * them. The system and global scopes are hidden by `ISOLATION_ENVIRONMENT`, so an operator's own git-lfs configuration
 * is not one of these keys. The pack's own command-line scope is listed too, so a key a caller refuses is never set in it.
 *
 * `spawn` runs git with that scope in force and no repository program in reach. Exit 1 is git saying nothing is
 * configured, which is an answer; a listing that did not complete is a refusal, because an unread key is a program that
 * would run.
 */
export async function configuredKeyNames<Listing extends ConfigListing>(input: {
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
  return result.stdout.split('\0').filter(Boolean)
}

/** `merge.<driver>.driver`: a program git runs to merge a path whose attributes name that driver, as a revert merges. */
const MERGE_DRIVER_KEY = /^merge\..+\.driver$/

/** The merge drivers among a repository's config keys (configuredKeyNames), each a program a revert would run. */
export function mergeDriverKeys(configuredKeys: readonly string[]): string[] {
  return configuredKeys.filter(key => MERGE_DRIVER_KEY.test(key))
}

/** The filter programs among a repository's config keys (configuredKeyNames). */
export function filterProgramKeys(configuredKeys: readonly string[]): string[] {
  return configuredKeys.filter(key => FILTER_PROGRAM_KEY.test(key))
}

/** The filter programs this repository defines: the keys `filterProgramOverrides` empties. */
export async function configuredFilterPrograms<Listing extends ConfigListing>(input: {
  spawn: (args: string[]) => Promise<Listing>
  describeFailure: (result: Listing) => string
}): Promise<string[]> {
  return filterProgramKeys(await configuredKeyNames(input))
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
