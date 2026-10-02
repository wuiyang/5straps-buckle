import type { SandboxMount } from '../../domain/sandbox-mounts.js'
import type { WorkspacePolicy } from '@5straps/protocol'
import type { IsolatedShellOptions } from '../shell/isolated-shell.js'
import { createEnvironmentPack } from './environment/index.js'
import { hasExecutable } from '../../domain/executable.js'
import type { Pack } from '../../domain/pack.js'
import type { PathView } from '../../domain/path-view.js'
import { forgeGitHost } from '../../domain/forge.js'
import { createGitHubForgeClient } from '../../adapters/forge/github.js'
import type { UrlMatcher } from '../../domain/url-pattern.js'
import type { ProcessRunner } from '../../types/ports/process-runner.js'
import type { Sandbox } from '../../types/ports/sandbox.js'
import type { ApprovedList } from './browser/allowed-domains.js'
import { createBrowserPack } from './browser/index.js'
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
  allowHostGit?: boolean
  allowHostLsp?: boolean
  enableShell: boolean
  shellNetwork?: boolean
  shellIsolation?: IsolatedShellOptions
  environmentValidator?: string
  /** Why commands cannot be sandboxed here, if they cannot. */
  sandboxUnavailableReason: string | null
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
  { id: 'browser', summary: 'drive an isolated agent-browser session' },
  { id: 'shell', summary: 'run commands in the sandbox (needs the shell on)' },
  { id: 'environment', summary: 'validate environment configuration (needs BUCKLE_ENV_VALIDATOR_COMMAND)' },
]

/**
 * Why a built-in pack cannot be built from this configuration, or null when it can. `createBuiltinPacks`
 * builds by this check and `buckle settings` and `buckle init` refuse by it, so a pack the node would
 * call unknown at start is never written to `BUCKLE_PACKS`.
 */
export function unmetPackPrerequisite(id: string, options: Pick<BuiltinPackOptions, 'environmentValidator'>): string | null {
  if (id === 'environment' && !options.environmentValidator) return 'BUCKLE_ENV_VALIDATOR_COMMAND is not set'
  return null
}

/** The only place built-in packs are constructed. Plugins are appended by the plugin loader. */
export function createBuiltinPacks(options: BuiltinPackOptions): Pack[] {
  const packs: Pack[] = [
    createFsPack({ paths: options.paths, runProcess: options.runProcess, hasRipgrep: hasExecutable('rg'), protectedRoots: options.hiddenPaths }),
    createWebPack({ braveSearchApiKey: options.braveSearchApiKey, allowedHosts: options.allowedHosts, approved: options.approvedUrls }),
    createGitPack({ paths: options.paths, runProcess: options.runProcess, stateDirectory: options.stateDirectory, hasGit: hasExecutable('git') }),
    createForgePack({
      paths: options.paths,
      runProcess: options.runProcess,
      stateDirectory: options.stateDirectory,
      forge: {
        client: options.forge.token ? createGitHubForgeClient({ token: options.forge.token, apiUrl: options.forge.apiUrl }) : null,
        apiUrl: options.forge.apiUrl,
        gitHost: forgeGitHost(new URL(options.forge.apiUrl)),
        token: options.forge.token ?? '',
      },
      author: options.forge.author,
      approved: options.approvedUrls,
      unavailableReason: forgeUnavailableReason(options),
    }),
    createDevPack({ cwd: options.cwd, paths: options.paths, runProcess: options.runProcess, allowHostLsp: options.allowHostLsp }),
    createBrowserPack({
      cwd: options.cwd,
      paths: options.paths,
      runProcess: options.runProcess,
      agentBrowserCommand: options.agentBrowserCommand,
      sessionDirectory: options.browserStateDirectory,
      headed: options.browserHeaded,
      available: hasExecutable(options.agentBrowserCommand),
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
  }))

  if (unmetPackPrerequisite('environment', options) === null) packs.push(createEnvironmentPack({ command: options.environmentValidator!, cwd: options.cwd, runProcess: options.runProcess }))
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

function forgeUnavailableReason(options: BuiltinPackOptions): string | null {
  if (!options.forge.token) return 'BUCKLE_FORGE_GITHUB_TOKEN is not set, so this node holds no forge credential and cannot commit, push or open a pull request'
  if (!hasExecutable('git')) return 'git is not installed on this node'
  return null
}

function shellUnavailableReason(options: BuiltinPackOptions): string | null {
  if (options.sandboxMounts?.length && options.sandbox.mode !== 'bubblewrap') return 'Explicit mounts require bubblewrap'
  if (!options.enableShell) return 'Shell tools are turned off by BUCKLE_ALLOW_SHELL=false'
  if (options.shellIsolation && options.sandbox.mode !== 'bubblewrap') return 'Isolated shell execution requires bubblewrap; BUCKLE_SHELL_ISOLATION=false opts into shared-workspace checkpoints'
  if (options.sandboxUnavailableReason) return options.sandboxUnavailableReason
  if (options.paths.mount && !options.sandbox.supportsMount) {
    return `The workspace is mounted at ${options.paths.mount}, which needs bubblewrap; shell tools are withheld under the ${options.sandbox.mode} sandbox rather than shown a different view`
  }
  return null
}
