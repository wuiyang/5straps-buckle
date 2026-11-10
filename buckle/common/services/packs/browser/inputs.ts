import type { HostEnvironment } from '../../../domain/environment.js'
import type { ProgramSearch, ResolvedProgram, UntrustedRoots } from '../../../domain/executable.js'
import type { TableMount } from '../../../domain/mount-table.js'
import type { PathView } from '../../../domain/path-view.js'
import type { CompiledPolicy } from '../../../domain/policy.js'
import type { BrowserSettingNames, BuckleConfig } from '../../../runtime/config.js'
import type { ProcessRunner } from '../../../types/ports/process-runner.js'
import { allowedDomainsKey, browserAllowedDomains, type ApprovedList } from './allowed-domains.js'
import type { BrowserPackOptions } from './index.js'
import { chooseBrowser, FRESH_BROWSER, modeFingerprint, type BrowserMode } from './mode.js'

export interface BrowserSettings {
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
}

export type BrowserMounts = [string | null, readonly TableMount[]]

interface BrowserBuildOptions extends BrowserSettings {
  cwd: string
  paths: PathView
  runProcess: ProcessRunner
  hiddenPaths: string[]
  approvedLists: ApprovedList[]
  programSearch?: ProgramSearch
}

export function browserPackOptions(options: BrowserBuildOptions, input: {
  untrusted: () => UntrustedRoots
  program: (name: string) => ResolvedProgram
  environment: HostEnvironment
}): BrowserPackOptions {
  const { untrusted, program, environment } = input
  return {
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
  }
}

/**
 * What the browser pack alone is handed (fix brief 2, R2, and its recheck): the allowed domains its approved list
 * comes to as agent-browser reads them, the workspace's mode, window, and idle timeout it launches under, and the
 * mounts its paths resolve against. Not the stored list: a rebuild for anything else, the variables, or a list changed
 * in order, port, or path only, carries the pack over with the browsers it runs, so an agent's tabs and cookies survive it.
 */
export interface BrowserReuseInputs { config: BuckleConfig; compiled: CompiledPolicy; mounts: BrowserMounts }

export function browserInputs(input: BrowserReuseInputs): string {
  const { config } = input
  const mode: BrowserMode = config.browserCdp ? { kind: 'attached', endpoint: config.browserCdp } : config.browserProfile ? { kind: 'profile', directory: config.browserProfile } : FRESH_BROWSER
  const domains = browserAllowedDomains(input.compiled.network ? [{ name: 'workspace', entries: input.compiled.network.patterns }] : [])
  return JSON.stringify([allowedDomainsKey(domains), modeFingerprint(mode, { ...(config.browserArgs === undefined ? {} : { launchArgs: config.browserArgs }), headed: config.browserHeaded, idleTimeoutMs: config.browserIdleTimeoutMs }), input.mounts])
}
