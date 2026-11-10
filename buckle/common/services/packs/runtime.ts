import { join } from 'pathe'
import type { ToolCapability } from '@5straps/protocol'
import type { PluginRegistry } from '../../adapters/plugin-registry.js'
import { runProcess } from '../../adapters/process-runner.js'
import type { SandboxResolution } from '../../adapters/sandbox/create-sandbox.js'
import type { UntrustedRoots } from '../../domain/executable.js'
import type { Pack } from '../../domain/pack.js'
import type { PathView } from '../../domain/path-view.js'
import type { CompiledPolicy } from '../../domain/policy.js'
import { WorkspaceError } from '../../domain/workspace-error.js'
import { workspaceStateKey } from '../../domain/workspace-key.js'
import { protectedSettingsFiles, protectedStateRoots, sandboxBinds, scratchSources, type BuckleConfig } from '../../runtime/config.js'
import { logger } from '../../runtime/log.js'
import { listenerOf, privateRangesOf } from '../../runtime/network-settings.js'
import type { ChangeHistory } from '../history/journal.js'
import { serviceInstalled } from '../node-service/installed.js'
import { browserInputs, type BrowserMounts, type BrowserReuseInputs } from './browser/inputs.js'
import { unmetPackPrerequisite } from './catalogue.js'
import { createBuiltinPacks } from './index.js'

const BROWSER_PACK = 'browser'

interface PackRuntimeInput {
  config: BuckleConfig
  sandbox: SandboxResolution
  plugins: PluginRegistry
  compiled: CompiledPolicy
  paths: PathView
  browserStateDirectory: string
  history: ChangeHistory
  untrusted: () => UntrustedRoots
  reachableTools: () => ToolCapability[]
  browserHeldBy?: (() => string | null) | undefined
  browserInstance: string
  /** The workspace's name as the runtime holds it, which a rename changes in place. */
  workspaceName: () => string
  mounts: BrowserMounts
}

interface PackGeneration {
  packs: Pack[]
  // The browser pack packs.enabled leaves out, kept for the owner's buckle browser close and this runtime's shutdown
  // alone, as the browsers the workspace recorded outlive the setting that turned the pack off (Codex review L7).
  offBrowser?: Pack
}

interface PreparedGeneration extends PackGeneration {
  input: PackRuntimeInput
  replaced: Pack[]
}

export async function createPackRuntime(input: PackRuntimeInput) {
  let current = await buildPacks(input)
  let currentInput = input
  /** Packs a rebuild replaced while calls ran on them, closed when the last of those calls ends. */
  const retiring: Pack[] = []
  return {
    get packs(): Pack[] { return current.packs },
    async prepare(nextInput: PackRuntimeInput): Promise<PreparedGeneration> {
      const built = await buildPacks(nextInput)
      const carried = carryBrowserPack({ built: built.packs, current: current.packs, next: nextInput, previous: currentInput })
      return { ...built, packs: carried.packs, replaced: carried.replaced, input: nextInput }
    },
    install(next: PreparedGeneration): void {
      current = next
      currentInput = next.input
    },
    retire,
    settled(): void {
      if (retiring.length > 0) void closePacks(retiring.splice(0), 'retire')
    },
    close: () => closePacks([...current.packs, ...retiring.splice(0), ...(current.offBrowser ? [current.offBrowser] : [])]),
    async closeBrowsers() {
      const browser = current.packs.find(pack => pack.id === BROWSER_PACK) ?? current.offBrowser
      if (!browser?.closeBrowsers) throw new WorkspaceError(`Workspace ${currentInput.workspaceName()} has no browser pack, so it recorded no browsers`, 409)
      return browser.closeBrowsers()
    },
    filledSecrets() {
      // The values this workspace's browsers were filled with, by file and NAME, as its browser packs record them beside
      // their sessions, so every Buckle process on the workspace masks by them, after a restart too (docs/user/how-to/secrets.md).
      return current.packs.find(pack => pack.id === BROWSER_PACK)?.filled
    },
  }

  /** Packs replaced retire once no call still runs on them: a script started before keeps its own tools to its end. */
  async function retire(replaced: Pack[], deferred: boolean): Promise<void> {
    if (!deferred) await closePacks(replaced, 'retire')
    else retiring.push(...replaced)
  }
}

/**
 * Each pack closes what it opened; one that fails to is logged, and the rest still close. A pack replaced by one
 * built from other settings retires instead, where it tells the two apart: what its successor carries on stays.
 */
async function closePacks(closing: Pack[], step: 'close' | 'retire' = 'close'): Promise<void> {
  const results = await Promise.allSettled(closing.map(async pack => (step === 'retire' ? pack.retire ?? pack.close : pack.close)?.call(pack)))
  for (const result of results) if (result.status === 'rejected') logger.warn('A pack could not close what it opened', { error: result.reason })
}

async function buildPacks(input: PackRuntimeInput): Promise<{ packs: Pack[]; offBrowser?: Pack }> {
  const builtin = createBuiltinPacks({
    cwd: input.config.cwd,
    paths: input.paths,
    untrusted: input.untrusted,
    runProcess,
    sandbox: input.sandbox.sandbox,
    sandboxUnavailableReason: input.sandbox.unavailableReason,
    writableRoots: [input.config.cwd, ...scratchSources(input.config.mounts)],
    hiddenPaths: protectedStateRoots(input.config),
    settingsFiles: protectedSettingsFiles(input.config),
    mountReadOnlyPaths: input.config.mountReadOnlyPaths,
    sandboxMounts: sandboxBinds(input.config.mounts),
    approvedUrls: input.compiled.network,
    privateRanges: privateRangesOf(input.config),
    listener: listenerOf(input.config),
    approvedLists: input.compiled.network ? [{ name: 'workspace' as const, entries: input.compiled.network.patterns }] : [],
    braveSearchApiKey: input.config.braveSearchApiKey,
    forge: { token: input.config.forgeGithubToken, apiUrl: input.config.forgeApiUrl, author: input.config.forgeGitAuthor },
    stateDirectory: input.config.stateDirectory,
    agentBrowserCommand: input.config.agentBrowserCommand,
    browserStateDirectory: input.browserStateDirectory,
    maxTimeoutMs: input.config.maxTimeoutMs,
    browserHeaded: input.config.browserHeaded,
    browserCdp: input.config.browserCdp,
    browserProfile: input.config.browserProfile,
    browserArgs: input.config.browserArgs,
    browserIdleTimeoutMs: input.config.browserIdleTimeoutMs,
    browserSettingNames: input.config.browserSettingNames,
    ...(input.browserHeldBy ? { browserHeldBy: input.browserHeldBy } : {}),
    browserInstance: input.browserInstance,
    workspaceName: input.workspaceName,
    serviceInstalled: () => serviceInstalled(input.config.nodeStateDirectory ?? input.config.stateDirectory),
    enableShell: input.config.enableShell,
    allowCode: input.config.allowCode,
    allowHistory: input.config.allowHistory,
    reachableTools: input.reachableTools,
    maxRequestBytes: input.config.maxRequestBytes,
    maxTransferBytes: input.config.maxTransferBytes,
    allowHostGit: input.config.allowHostGit,
    allowHostLsp: input.config.allowHostLsp,
    shellNetwork: input.config.shellNetwork,
    commandEnvironment: input.config.commandEnvironment,
    filesystemPolicy: { policy: input.compiled.policy },
    history: input.history,
    shellIsolation: input.config.isolateShell ? { directory: join(input.config.stateDirectory, 'isolated-shell', workspaceStateKey(input.config.cwd)), maxBytes: input.config.isolationMaxBytes, history: input.history } : undefined,
    environmentValidator: input.config.environmentValidator,
  })
  const selected = input.config.enabledPacks
  if (selected) {
    const unknown = selected.filter(id => !builtin.some(pack => pack.id === id))
    if (unknown.length) {
      const named = unknown.map(id => { const reason = unmetPackPrerequisite(id, input.config); return reason ? `${id} (${reason})` : id })
      throw new Error(`The workspace's packs.enabled names packs this node cannot build: ${named.join(', ')}`)
    }
    const offBrowser = selected.includes(BROWSER_PACK) ? undefined : builtin.find(pack => pack.id === BROWSER_PACK)
    return { packs: builtin.filter(pack => selected.includes(pack.id)), ...(offBrowser ? { offBrowser } : {}) }
  }
  const filesystemRestricted = Boolean(input.compiled.policy.filesystem?.rules.length)
  return { packs: [...builtin, ...(filesystemRestricted ? [] : await input.plugins.load())] }
}


/**
 * A browser with the same inputs keeps its pack and sessions. Its newly built twin is dropped without closing, as
 * both hold the same runtime identity. The rest of the current set is what the rebuild replaced.
 */
function carryBrowserPack(input: { built: Pack[]; current: Pack[]; next: BrowserReuseInputs; previous: BrowserReuseInputs }): { packs: Pack[]; replaced: Pack[] } {
  const packs = input.built.map(pack => (pack.id === BROWSER_PACK && browserInputs(input.next) === browserInputs(input.previous) ? input.current.find(item => item.id === pack.id) : undefined) ?? pack)
  return { packs, replaced: input.current.filter(pack => !packs.includes(pack)) }
}
