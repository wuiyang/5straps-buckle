import { join } from 'pathe'
import type { SandboxMount } from '../../domain/sandbox-mounts.js'
import type { ToolCapability, WorkspacePolicy } from '@5straps/protocol'
import { createPiCodemodeVm } from '../../adapters/script-vm/pi-codemode.js'
import { workspaceStateKey } from '../../domain/workspace-key.js'
import type { ScriptVm } from '../../types/ports/script-vm.js'
import { createCodePack } from './code/index.js'
import type { IsolatedShellOptions } from '../shell/isolated-shell.js'
import { createEnvironmentPack } from './environment/index.js'
import { hostEnvironment } from '../../domain/environment.js'
import { ownRoots, resolveProgram, programOrNull, type ProgramSearch, type ResolvedProgram, type UntrustedRoots } from '../../domain/executable.js'
import type { Pack } from '../../domain/pack.js'
import type { PathView } from '../../domain/path-view.js'
import { forgeGitHost } from '../../domain/forge.js'
import { createGitHubForgeClient } from '../../adapters/forge/github.js'
import type { UrlMatcher } from '../../domain/url-pattern.js'
import type { ProcessRunner } from '../../types/ports/process-runner.js'
import type { Sandbox } from '../../types/ports/sandbox.js'
import type { ApprovedList } from './browser/allowed-domains.js'
import { createBrowserPack } from './browser/index.js'
import { chooseBrowser } from './browser/mode.js'
import { createDevPack } from './dev/index.js'
import { createForgePack } from './forge/index.js'
import { createFsPack } from './fs/index.js'
import { createGitPack } from './git/index.js'
import { createShellPack } from './shell/index.js'
import { createWebPack } from './web/index.js'

export interface BuiltinPackOptions {
  sandboxMounts?: SandboxMount[]
  filesystemPolicy?: { policy: WorkspacePolicy; ceiling?: WorkspacePolicy | null }
  cwd: string
  paths: PathView
  runProcess: ProcessRunner
  sandbox: Sandbox
  writableRoots: string[]
  /** Host paths no command may see, Buckle's own state above all. */
  hiddenPaths: string[]
  /** Host directories a mounted command may still read. */
  mountReadOnlyPaths: string[]
  /** The owner's approved list, or null for the default egress rules. */
  approvedUrls: UrlMatcher | null
  /** Each approved list `approvedUrls` intersects, named, which the browser pack passes on. */
  approvedLists: ApprovedList[]
  braveSearchApiKey?: string
  /** The owner's forge credential and where it may be spent. */
  forge: { token?: string; apiUrl: string; author: { name: string; email: string } }
  /** Buckle's own state directory, which holds the empty hooks directory every git call runs with. */
  stateDirectory: string
  allowedHosts: string[]
  agentBrowserCommand: string
  /** Protected browser configuration and daemon identities for this workspace. */
  browserStateDirectory: string
  /** The longest a call may run, which bounds how long a browser transfer directory can be in use; the node's default when absent. */
  maxTimeoutMs?: number
  browserHeaded: boolean
  /** BUCKLE_BROWSER_CDP: the owner's own Chrome, which every browser command attaches to. */
  browserCdp?: string
  /** BUCKLE_BROWSER_PROFILE: the profile folder a launched browser keeps, judged where it lies (chooseBrowser). */
  browserProfile?: string
  /** BUCKLE_BROWSER_ARGS: Chromium arguments for a browser Buckle launches. */
  browserArgs?: string
  allowHostGit?: boolean
  allowHostLsp?: boolean
  enableShell: boolean
  /** BUCKLE_ALLOW_CODE: false withholds the code pack (owner decision D82). On when absent. */
  allowCode?: boolean
  /** What a script reaches: the workspace manifest's tools as they stand at each call, after tool policy. None when absent. */
  reachableTools?: () => ToolCapability[]
  /** BUCKLE_MAX_REQUEST_BYTES, which a script's calls are held to as direct ones are. */
  maxRequestBytes?: number
  /** The VM code mode runs scripts in; pi-codemode's when absent. */
  scriptVm?: ScriptVm
  shellNetwork?: boolean
  shellIsolation?: IsolatedShellOptions
  environmentValidator?: string
  /** Why commands cannot be sandboxed here, if they cannot. */
  sandboxUnavailableReason: string | null
  /** How the programs the packs run are looked up (resolveProgram): the host's PATH unless a test imitates another platform. */
  programSearch?: ProgramSearch
  /**
   * Where no program a pack runs may come from, read as each is resolved: every root the node knows (NodeRoots).
   * The workspace and its scratch roots when absent.
   */
  untrusted?: () => UntrustedRoots
}

/**
 * The built-in packs by id, in manifest order, for `buckle init` and `buckle settings`, which
 * name them without building any. A test keeps this list and `createBuiltinPacks` in step.
 */
export const BUILTIN_PACKS: ReadonlyArray<{ id: string; summary: string }> = [
  { id: 'fs', summary: 'read, write and search files' },
  { id: 'web', summary: 'fetch URLs and search the web' },
  { id: 'git', summary: 'read the repository: status, diff, log, blame, branches (needs host Git on)' },
  { id: 'forge', summary: 'commit, push and open pull requests (needs host Git on and a forge token)' },
  { id: 'dev', summary: 'language-server navigation and diagnostics' },
  { id: 'browser', summary: 'drive a browser through agent-browser, fresh for each session by default' },
  { id: 'shell', summary: 'run commands in the sandbox (needs the shell on)' },
  { id: 'code', summary: 'run a script that calls the other tools, each call judged as a direct one' },
  { id: 'environment', summary: 'validate environment configuration (needs BUCKLE_ENV_VALIDATOR_COMMAND)' },
]

/**
 * Why a built-in pack cannot be built from this configuration, or null when it can. `createBuiltinPacks`
 * builds by this check and `buckle settings` and `buckle init` refuse by it, so a pack the node would
 * call unknown at start is never written to `BUCKLE_PACKS`.
 */
export function unmetPackPrerequisite(id: string, options: Pick<BuiltinPackOptions, 'environmentValidator'>): string | null {
  if (id === 'environment' && !options.environmentValidator) return 'BUCKLE_ENV_VALIDATOR_COMMAND is not set'
  // The code pack is always built: BUCKLE_ALLOW_CODE=false withholds it with a reason, as BUCKLE_ALLOW_SHELL does the shell.
  return null
}

/** The only place built-in packs are constructed. Plugins are appended by the plugin loader. */
export function createBuiltinPacks(options: BuiltinPackOptions): Pack[] {
  // Each program a pack runs is resolved once, here, and spawned by that path; one found where an agent writes is refused.
  const untrusted = options.untrusted ?? (() => ownRoots(options.paths))
  const program = (name: string): ResolvedProgram => resolveProgram(name, { ...untrusted(), ...options.programSearch })
  // And each runs with a PATH that leads to no program an agent wrote, as a script it runs looks its interpreter up there.
  const environment = hostEnvironment(untrusted, options.programSearch?.platform)
  const git = program('git')
  const packs: Pack[] = [
    createFsPack({ paths: options.paths, runProcess: options.runProcess, ripgrep: programOrNull(program('rg')), protectedRoots: options.hiddenPaths, environment }),
    createWebPack({ braveSearchApiKey: options.braveSearchApiKey, allowedHosts: options.allowedHosts, approved: options.approvedUrls }),
    createGitPack({ paths: options.paths, runProcess: options.runProcess, stateDirectory: options.stateDirectory, git, environment, ...(options.programSearch?.platform ? { platform: options.programSearch.platform } : {}) }),
    createForgePack({
      paths: options.paths,
      runProcess: options.runProcess,
      git,
      environment,
      stateDirectory: options.stateDirectory,
      forge: {
        client: options.forge.token ? createGitHubForgeClient({ token: options.forge.token, apiUrl: options.forge.apiUrl }) : null,
        apiUrl: options.forge.apiUrl,
        gitHost: forgeGitHost(new URL(options.forge.apiUrl)),
        token: options.forge.token ?? '',
      },
      author: options.forge.author,
      approved: options.approvedUrls,
      unavailableReason: forgeUnavailableReason(options, git),
    }),
    createDevPack({ cwd: options.cwd, paths: options.paths, runProcess: options.runProcess, allowHostLsp: options.allowHostLsp, resolveProgram: program, environment }),
    createBrowserPack({
      cwd: options.cwd,
      paths: options.paths,
      runProcess: options.runProcess,
      agentBrowserCommand: options.agentBrowserCommand,
      sessionDirectory: options.browserStateDirectory,
      headed: options.browserHeaded,
      // A profile folder is judged as the agent-browser program is, against every root an agent can write, and Buckle's state.
      browser: chooseBrowser({ cdp: options.browserCdp, profile: options.browserProfile, args: options.browserArgs, untrusted: untrusted(), protectedRoots: options.hiddenPaths, ...(options.programSearch?.platform ? { platform: options.programSearch.platform } : {}) }),
      ...(options.browserArgs ? { launchArgs: options.browserArgs } : {}),
      agentBrowser: program(options.agentBrowserCommand),
      environment,
      approvedLists: options.approvedLists,
      protectedRoots: options.hiddenPaths,
      ...(options.maxTimeoutMs === undefined ? {} : { maxTimeoutMs: options.maxTimeoutMs }),
    }),
  ]

  // Always present, so `buckle manifest` explains an absent shell rather than silently omitting it.
  packs.push(createShellPack({
    paths: options.paths,
    runProcess: options.runProcess,
    sandbox: options.sandbox,
    writableRoots: options.writableRoots,
    hiddenPaths: options.hiddenPaths,
    readOnlyPaths: options.mountReadOnlyPaths,
    mounts: options.sandboxMounts,
    unavailableReason: shellUnavailableReason(options),
    isolation: options.shellIsolation,
    filesystemPolicy: options.filesystemPolicy,
    allowNetwork: options.shellNetwork === true && !options.approvedUrls && options.allowedHosts.length === 0,
    untrusted,
    ...(options.programSearch ? { programSearch: options.programSearch } : {}),
  }))

  // Built whether or not it may run, so `buckle manifest` explains a withheld one. Never withheld for want of an
  // operating-system sandbox: its VM has no files, network, processes, timers, or modules (owner decision D82).
  packs.push(createCodePack({
    vm: options.scriptVm ?? createPiCodemodeVm({ workspace: workspaceStateKey(options.cwd) }),
    reachableTools: options.reachableTools ?? (() => []),
    ...(options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes }),
    journalDirectory: join(options.stateDirectory, 'code-journal', workspaceStateKey(options.cwd)),
    unavailableReason: options.allowCode === false ? CODE_OFF : null,
  }))

  const validator = options.environmentValidator
  if (validator !== undefined && unmetPackPrerequisite('environment', options) === null) {
    // Named by its setting in a refusal the agent reads, never by its path, which may lie outside the workspace.
    const resolved = resolveProgram(validator, { ...untrusted(), ...options.programSearch, shownAs: 'The validator BUCKLE_ENV_VALIDATOR_COMMAND names' })
    packs.push(createEnvironmentPack({ command: validator, validator: resolved, cwd: options.cwd, runProcess: options.runProcess, environment }))
  }
  if (!options.allowHostGit) for (const pack of packs) {
    if (pack.id === 'git' || pack.id === 'forge') pack.unavailableReason = 'Host Git can read repository data outside per-file approval checks; BUCKLE_ALLOW_HOST_GIT=true explicitly trusts repository access outside the shell sandbox'
  }
  const restricted = [options.filesystemPolicy?.policy, options.filesystemPolicy?.ceiling]
    .some(policy => policy?.filesystem?.rules.some(rule => rule.read === 'deny' || rule.read === 'ask' || rule.write === 'deny' || rule.write === 'ask'))
  if (restricted) for (const pack of packs) {
    if (pack.id === 'git' || pack.id === 'dev' || pack.id === 'forge') pack.unavailableReason = 'Host Git and language-server tools do not enforce per-path policy; use the sandboxed shell or filesystem tools'
  }
  return packs
}

const CODE_OFF = 'Code mode is turned off by BUCKLE_ALLOW_CODE=false'

function forgeUnavailableReason(options: BuiltinPackOptions, git: ResolvedProgram): string | null {
  if (!options.forge.token) return 'BUCKLE_FORGE_GITHUB_TOKEN is not set, so this node holds no forge credential and cannot commit, push or open a pull request'
  return git.path === null ? git.reason : null
}

function shellUnavailableReason(options: BuiltinPackOptions): string | null {
  // Where no sandbox could be had, such as a bwrap refused where an agent writes, that is the reason, not the mounts.
  if (options.sandboxMounts?.length && options.sandbox.mode !== 'bubblewrap') return options.sandboxUnavailableReason ?? 'Explicit mounts require bubblewrap'
  if (!options.enableShell) return 'Shell tools are turned off by BUCKLE_ALLOW_SHELL=false'
  if (options.shellIsolation && options.sandbox.mode !== 'bubblewrap') return 'Isolated shell execution requires bubblewrap; BUCKLE_SHELL_ISOLATION=false opts into shared-workspace checkpoints'
  if (options.sandboxUnavailableReason) return options.sandboxUnavailableReason
  if (options.paths.mount && !options.sandbox.supportsMount) {
    return `The workspace is mounted at ${options.paths.mount}, which needs bubblewrap; shell tools are withheld under the ${options.sandbox.mode} sandbox rather than shown a different view`
  }
  return null
}
