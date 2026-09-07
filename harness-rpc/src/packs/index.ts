import { hasExecutable } from '../domain/executable.js'
import type { Pack } from '../domain/pack.js'
import type { PathView } from '../domain/path-view.js'
import type { UrlMatcher } from '../domain/url-pattern.js'
import type { ProcessRunner } from '../ports/process-runner.js'
import type { Sandbox } from '../ports/sandbox.js'
import { createBrowserPack } from './browser/index.js'
import { createDevPack } from './dev/index.js'
import { createFsPack } from './fs/index.js'
import { createGitPack } from './git/index.js'
import { createShellPack } from './shell/index.js'
import { createWebPack } from './web/index.js'

export interface BuiltinPackOptions {
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
  braveSearchApiKey?: string
  allowedHosts: string[]
  agentBrowserCommand: string
  /** The profile directory Buckle owns for this workspace's browser. */
  browserProfile: string
  browserHeaded: boolean
  enableShell: boolean
  /** Why commands cannot be sandboxed here, if they cannot. */
  sandboxUnavailableReason: string | null
}

/** The only place built-in packs are constructed. Plugins are appended by the plugin loader. */
export function createBuiltinPacks(options: BuiltinPackOptions): Pack[] {
  const packs: Pack[] = [
    createFsPack({ paths: options.paths, runProcess: options.runProcess, hasRipgrep: hasExecutable('rg') }),
    createWebPack({ braveSearchApiKey: options.braveSearchApiKey, allowedHosts: options.allowedHosts, approved: options.approvedUrls }),
    createGitPack({ paths: options.paths, runProcess: options.runProcess, hasGit: hasExecutable('git') }),
    createDevPack({ cwd: options.cwd, paths: options.paths, runProcess: options.runProcess }),
    createBrowserPack({
      cwd: options.cwd,
      paths: options.paths,
      runProcess: options.runProcess,
      agentBrowserCommand: options.agentBrowserCommand,
      profileDirectory: options.browserProfile,
      headed: options.browserHeaded,
      available: hasExecutable(options.agentBrowserCommand),
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
    unavailableReason: shellUnavailableReason(options),
  }))

  return packs
}

function shellUnavailableReason(options: BuiltinPackOptions): string | null {
  if (!options.enableShell) return 'Shell tools are turned off by BUCKLE_ALLOW_SHELL=false'
  if (options.sandboxUnavailableReason) return options.sandboxUnavailableReason
  if (options.paths.mount && !options.sandbox.supportsMount) {
    return `The workspace is mounted at ${options.paths.mount}, which needs bubblewrap; shell tools are withheld under the ${options.sandbox.mode} sandbox rather than shown a different view`
  }
  return null
}
