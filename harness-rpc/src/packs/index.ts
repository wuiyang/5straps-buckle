import { hasExecutable } from '../domain/executable.js'
import type { Pack } from '../domain/pack.js'
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
  runProcess: ProcessRunner
  sandbox: Sandbox
  writableRoots: string[]
  braveSearchApiKey?: string
  allowedHosts: string[]
  agentBrowserCommand: string
  enableShell: boolean
  /** Why commands cannot be sandboxed here, if they cannot. */
  sandboxUnavailableReason: string | null
}

/** The only place built-in packs are constructed. Plugins are appended by the plugin loader. */
export function createBuiltinPacks(options: BuiltinPackOptions): Pack[] {
  const packs: Pack[] = [
    createFsPack({ cwd: options.cwd, runProcess: options.runProcess, hasRipgrep: hasExecutable('rg') }),
    createWebPack({ braveSearchApiKey: options.braveSearchApiKey, allowedHosts: options.allowedHosts }),
    createGitPack({ cwd: options.cwd, runProcess: options.runProcess, hasGit: hasExecutable('git') }),
    createDevPack({ cwd: options.cwd, runProcess: options.runProcess }),
    createBrowserPack({
      cwd: options.cwd,
      runProcess: options.runProcess,
      agentBrowserCommand: options.agentBrowserCommand,
      available: hasExecutable(options.agentBrowserCommand),
    }),
  ]

  // Always present, so `buckle manifest` explains an absent shell rather than silently omitting it.
  packs.push(createShellPack({
    cwd: options.cwd,
    runProcess: options.runProcess,
    sandbox: options.sandbox,
    writableRoots: options.writableRoots,
    unavailableReason: options.enableShell
      ? options.sandboxUnavailableReason
      : 'Shell tools are turned off by BUCKLE_ALLOW_SHELL=false',
  }))

  return packs
}
