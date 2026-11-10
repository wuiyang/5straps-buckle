import type { ToolCapability, WorkspacePolicy } from '@5straps/protocol'
import { createPiCodemodeVm } from '../../adapters/script-vm/pi-codemode.js'
import { workspaceStateKey } from '../../domain/workspace-key.js'
import type { ScriptVm } from '../../types/ports/script-vm.js'
import { createCodePack } from './code/index.js'
import { journalDirectory } from './code/journal.js'
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
import type { Sandbox, SandboxBind } from '../../types/ports/sandbox.js'
import type { ApprovedList } from './browser/allowed-domains.js'
import { createBrowserPack } from './browser/index.js'
import { chooseBrowser } from './browser/mode.js'
import type { BrowserSettingNames } from '../../runtime/config.js'
import { createDevPack } from './dev/index.js'
import { createForgePack } from './forge/index.js'
import { createFsPack } from './fs/index.js'
import { createGitPack } from './git/index.js'
import { createHistoryPack } from './history/index.js'
import type { ChangeHistory } from '../history/journal.js'
import { createShellPack } from './shell/index.js'
import { createWebPack } from './web/index.js'
import type { AddressRange, NodeListener } from '../../domain/ip.js'
import { BUILTIN_PACKS, unmetPackPrerequisite, type BuiltinPackId } from './catalogue.js'

export interface BuiltinPackOptions {
  /** The workspace's mounts as the shell binds them (sandboxBinds). */
  sandboxMounts?: SandboxBind[]
  filesystemPolicy?: { policy: WorkspacePolicy }
  cwd: string
  paths: PathView
  runProcess: ProcessRunner
  sandbox: Sandbox
  writableRoots: string[]
  /** Host paths no command may see, Buckle's own state above all. */
  hiddenPaths: string[]
  /** Those of the hidden paths that are the node's settings files, there or not (protectedSettingsFiles). */
  settingsFiles: string[]
  /** Host directories a mounted command may still read. */
  mountReadOnlyPaths: string[]
  /** The owner's approved list, or null for the default egress rules. */
  approvedUrls: UrlMatcher | null
  /** The owner's CIDR ranges web_fetch reaches on private addresses without asking (network.privateRanges). */
  privateRanges: readonly AddressRange[]
  /** The node's own serve listener, which no range clears. */
  listener?: NodeListener
  /** Each approved list `approvedUrls` intersects, named, which the browser pack passes on. */
  approvedLists: ApprovedList[]
  braveSearchApiKey?: string
  /** The owner's forge credential and where it may be spent. */
  forge: { token?: string; apiUrl: string; author: { name: string; email: string } }
  /** Buckle's own state directory, which holds the empty hooks directory every git call runs with. */
  stateDirectory: string
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
  /** browser.idleTimeoutMs: how long an idle browser lives; five minutes when absent. */
  browserIdleTimeoutMs?: number
  /** How a refusal of the browser settings names each: the workspace's own by its key, the node's by its variable. */
  browserSettingNames?: BrowserSettingNames | undefined
  /** Which other workspace holds the profile folder or the attached Chrome, read at each browser call (Q10). */
  browserHeldBy?: () => string | null
  /** The runtime that writes the browser's sessions, beside the process's pid (Slice F4, item 4); the process's own when absent. */
  browserInstance?: string
  /** The workspace's name, which the browser's refusals name in the owner's buckle browser close (Slice F4, item 7). */
  workspaceName?: () => string
  /** Whether a service runs this node, for the browser's restart hint. */
  serviceInstalled?: () => boolean
  allowHostGit?: boolean
  allowHostLsp?: boolean
  enableShell: boolean
  /** The workspace's own variables for its shell commands (Q13), under each call's `env`. None when absent. */
  commandEnvironment?: Readonly<Record<string, string>>
  /** The workspace setting packs.code: false withholds the code pack (owner decision D82). On when absent. */
  allowCode?: boolean
  /** What a script reaches: the workspace manifest's tools as they stand at each call, after tool policy. None when absent. */
  reachableTools?: () => ToolCapability[]
  /** BUCKLE_MAX_REQUEST_BYTES, which a script's calls are held to as direct ones are. */
  maxRequestBytes?: number
  /** BUCKLE_MAX_TRANSFER_BYTES: the largest file one `buckle cp` moves through fs_receive or fs_send. */
  maxTransferBytes?: number
  /** The workspace's change history, which the history pack reads and restores; the pack is withheld where absent. */
  history?: ChangeHistory
  /** The workspace setting packs.history: false withholds the history pack (slice D, rollback). On when absent. */
  allowHistory?: boolean
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

/** The only place built-in packs are constructed. Plugins are appended by the plugin loader. */
export function createBuiltinPacks(options: BuiltinPackOptions): Pack[] {
  // Each program a pack runs is resolved once, here, and spawned by that path; one found where an agent writes is refused.
  const untrusted = options.untrusted ?? (() => ownRoots(options.paths))
  // On Windows a program on a network share runs only where a mount of this workspace holds it (D84 (1)).
  const shares = options.programSearch?.shares ?? options.paths.shares
  const program = (name: string): ResolvedProgram => resolveProgram(name, { ...untrusted(), ...options.programSearch, shares })
  // And each runs with a PATH that leads to no program an agent wrote, as a script it runs looks its interpreter up there.
  const environment = hostEnvironment(untrusted, options.programSearch?.platform, shares)
  const git = program('git')
  const factories: Record<BuiltinPackId, () => Pack | undefined> = {
    fs: () => createFsPack({
      paths: options.paths, runProcess: options.runProcess, ripgrep: programOrNull(program('rg')), protectedRoots: options.hiddenPaths, environment,
      ...(options.maxTransferBytes === undefined ? {} : { maxTransferBytes: options.maxTransferBytes }),
      ...(options.maxTimeoutMs === undefined ? {} : { maxTimeoutMs: options.maxTimeoutMs }),
    }),
    history: () => createHistoryPack({ paths: options.paths, history: options.history ?? null, unavailableReason: options.allowHistory === false ? HISTORY_OFF : null }),
    web: () => createWebPack({ braveSearchApiKey: options.braveSearchApiKey, approved: options.approvedUrls, privateRanges: options.privateRanges, ...(options.listener === undefined ? {} : { listener: options.listener }) }),
    git: () => createGitPack({ paths: options.paths, runProcess: options.runProcess, stateDirectory: options.stateDirectory, git, environment, ...(options.programSearch?.platform ? { platform: options.programSearch.platform } : {}) }),
    forge: () => createForgePack({
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
    dev: () => createDevPack({ cwd: options.cwd, paths: options.paths, runProcess: options.runProcess, allowHostLsp: options.allowHostLsp, resolveProgram: program, environment }),
    browser: () => createBrowserPack({
      cwd: options.cwd,
      paths: options.paths,
      runProcess: options.runProcess,
      agentBrowserCommand: options.agentBrowserCommand,
      sessionDirectory: options.browserStateDirectory,
      headed: options.browserHeaded,
      // A profile folder is judged as the agent-browser program is, against every root an agent can write, and Buckle's state.
      browser: chooseBrowser({ cdp: options.browserCdp, profile: options.browserProfile, args: options.browserArgs, headed: options.browserHeaded, ...(options.browserSettingNames ? { names: options.browserSettingNames } : {}), untrusted: untrusted(), protectedRoots: options.hiddenPaths, ...(options.programSearch?.platform ? { platform: options.programSearch.platform } : {}) }),
      ...(options.browserArgs ? { launchArgs: options.browserArgs } : {}),
      agentBrowser: program(options.agentBrowserCommand),
      environment,
      approvedLists: options.approvedLists,
      protectedRoots: options.hiddenPaths,
      ...(options.maxTimeoutMs === undefined ? {} : { maxTimeoutMs: options.maxTimeoutMs }),
      ...(options.browserIdleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.browserIdleTimeoutMs }),
      ...(options.browserHeldBy ? { heldBy: options.browserHeldBy } : {}),
      ...(options.serviceInstalled ? { serviceInstalled: options.serviceInstalled } : {}),
      ...(options.programSearch?.platform ? { platform: options.programSearch.platform } : {}),
      ...(options.browserInstance ? { instance: options.browserInstance } : {}),
      ...(options.workspaceName ? { workspaceName: options.workspaceName } : {}),
    }),

    // Always present, so `buckle manifest` explains an absent shell rather than silently omitting it.
    shell: () => createShellPack({
      paths: options.paths,
      runProcess: options.runProcess,
      sandbox: options.sandbox,
      writableRoots: options.writableRoots,
      hiddenPaths: options.hiddenPaths,
      settingsFiles: options.settingsFiles,
      readOnlyPaths: options.mountReadOnlyPaths,
      mounts: options.sandboxMounts,
      unavailableReason: shellUnavailableReason(options),
      ...(options.commandEnvironment ? { commandEnvironment: options.commandEnvironment } : {}),
      isolation: options.shellIsolation,
      filesystemPolicy: options.filesystemPolicy,
      // The shell's network is all or nothing, so a workspace with a URL list keeps its shell off the network.
      allowNetwork: options.shellNetwork === true && !options.approvedUrls,
      untrusted,
      programSearch: { ...options.programSearch, shares },
    }),

    // Built whether or not it may run, so `buckle manifest` explains a withheld one. Never withheld for want of an
    // operating-system sandbox: its VM has no files, network, processes, timers, or modules (owner decision D82).
    code: () => createCodePack({
      vm: options.scriptVm ?? createPiCodemodeVm({ workspace: workspaceStateKey(options.cwd) }),
      reachableTools: options.reachableTools ?? (() => []),
      ...(options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes }),
      journalDirectory: journalDirectory({ stateDirectory: options.stateDirectory, cwd: options.cwd }),
      unavailableReason: options.allowCode === false ? CODE_OFF : null,
    }),

    environment: () => {
      const validator = options.environmentValidator
      if (validator === undefined) return undefined
      // Named by its setting in a refusal the agent reads, never by its path, which may lie outside the workspace.
      const resolved = resolveProgram(validator, { ...untrusted(), ...options.programSearch, shares, shownAs: 'The validator BUCKLE_ENV_VALIDATOR_COMMAND names' })
      return createEnvironmentPack({ command: validator, validator: resolved, cwd: options.cwd, runProcess: options.runProcess, environment })
    },
  }
  const packs = BUILTIN_PACKS.flatMap(({ id }) => {
    if (unmetPackPrerequisite(id, options) !== null) return []
    const pack = factories[id]()
    return pack === undefined ? [] : [pack]
  })
  if (!options.allowHostGit) for (const pack of packs) {
    if (pack.id === 'git' || pack.id === 'forge') pack.unavailableReason = 'Host Git can read repository data outside per-file approval checks; the workspace setting packs.hostGit, on, explicitly trusts repository access outside the shell sandbox'
  }
  const restricted = options.filesystemPolicy?.policy.filesystem?.rules.some(rule => rule.read === 'deny' || rule.read === 'ask' || rule.write === 'deny' || rule.write === 'ask')
  if (restricted) for (const pack of packs) {
    if (pack.id === 'git' || pack.id === 'dev' || pack.id === 'forge') pack.unavailableReason = 'Host Git and language-server tools do not enforce per-path policy; use the sandboxed shell or filesystem tools'
  }
  return packs
}

const CODE_OFF = 'Code mode is turned off in this workspace: its setting packs.code is off'
const HISTORY_OFF = 'The change history tools are turned off in this workspace: its setting packs.history is off'

function forgeUnavailableReason(options: BuiltinPackOptions, git: ResolvedProgram): string | null {
  if (!options.forge.token) return 'BUCKLE_FORGE_GITHUB_TOKEN is not set, so this node holds no forge credential and cannot commit, push or open a pull request'
  return git.path === null ? git.reason : null
}

function shellUnavailableReason(options: BuiltinPackOptions): string | null {
  // Where no sandbox could be had, such as a bwrap refused where an agent writes, that is the reason, not the mounts.
  if (options.sandboxMounts?.length && options.sandbox.mode !== 'bubblewrap') return options.sandboxUnavailableReason ?? 'The workspace\'s mounts need bubblewrap; shell tools are withheld rather than shown a different view'
  if (!options.enableShell) return 'Shell tools are turned off in this workspace: its setting packs.shell is off'
  if (options.shellIsolation && options.sandbox.mode !== 'bubblewrap') return 'Isolated shell execution requires bubblewrap; the workspace setting shell.isolation, off, opts into shared-workspace checkpoints'
  if (options.sandboxUnavailableReason) return options.sandboxUnavailableReason
  if (options.paths.mount && !options.sandbox.supportsMount) {
    return `The workspace is mounted at ${options.paths.mount}, which needs bubblewrap; shell tools are withheld under the ${options.sandbox.mode} sandbox rather than shown a different view`
  }
  return null
}
