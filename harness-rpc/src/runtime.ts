import { join, dirname } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { createChangeHistory, type ChangeHistory } from './services/history/journal.js'
import { mkdirSync } from 'node:fs'
import { arch, hostname, platform } from 'node:os'
import { PROTOCOL_VERSION, type HarnessManifest, type InvokeRequest, type InvokeResponse, type WorkspacePolicy } from '@5straps/protocol'
import { createFileActionLog } from './adapters/action-log/file-action-log.js'
import { createPluginRegistry, type PluginRegistry } from './adapters/plugin-registry.js'
import { createFileGrantStore } from './adapters/grant-store/file-grant-store.js'
import { createFilePolicyStore } from './adapters/policy-store/file-policy-store.js'
import { runProcess } from './adapters/process-runner.js'
import { createWebhookReporter } from './adapters/report/webhook-reporter.js'
import { resolveSandbox, type SandboxResolution } from './adapters/sandbox/create-sandbox.js'
import { actionsPath, approvalsPath, grantsPath, pluginsPath, policyPath, type BuckleConfig } from './config.js'
import { availableSkills, availableTools, packDescriptor, type Pack } from './domain/pack.js'
import { createPathView, type PathView } from './domain/path-view.js'
import { createPermissionEngine, type PermissionEngine } from './domain/permission/engine.js'
import { createCommandPolicyRule } from './domain/permission/rules/command-policy-rule.js'
import { createDestructiveCommandRule } from './domain/permission/rules/destructive-command-rule.js'
import { createNetworkEgressRule } from './domain/permission/rules/network-egress-rule.js'
import { createProcessProbeRule } from './domain/permission/rules/process-probe-rule.js'
import { createReadScopeRule } from './domain/permission/rules/read-scope-rule.js'
import { createSensitivePathRule } from './domain/permission/rules/sensitive-path-rule.js'
import { createWriteScopeRule } from './domain/permission/rules/write-scope-rule.js'
import { compilePolicy, mergePolicies, type CompiledPolicy } from './domain/policy.js'
import { loadSkills } from './domain/skill-registry.js'
import { toDescriptor, type LoadedSkill } from './domain/skill.js'
import { createToolRegistry, type ToolRegistry } from './domain/tool-registry.js'
import { workspaceStateKey } from './domain/workspace-key.js'
import { createBuiltinPacks } from './packs/index.js'
import { loadRootSkill } from './packs/pack-skill.js'
import type { ActionLog } from './ports/action-log.js'
import type { ApprovalChannel } from './ports/approval-channel.js'
import type { GrantStore } from './ports/grant-store.js'
import type { PolicyStore } from './ports/policy-store.js'
import { nullReporter, type Reporter } from './ports/reporter.js'
import { createApprovalRegistry, type ApprovalRegistry } from './services/approval-registry.js'
import { createInvoker } from './services/invoker.js'
import { BUCKLE_VERSION } from './version.js'

/**
 * The owner's policy as the runtime holds it. `base` came from the environment, `stored` from
 * `buckle policy` or a push through the setup face, and `effective` is their union: what the
 * rules enforce right now.
 */
export interface PolicyHandle {
  base(): WorkspacePolicy
  stored(): WorkspacePolicy | null
  effective(): WorkspacePolicy
  /** Validates against the base, stores, and rebuilds the rules and packs. Throws PolicyError. */
  apply(policy: WorkspacePolicy): Promise<WorkspacePolicy>
  /** Drops the stored policy, leaving the environment's. */
  clear(): Promise<WorkspacePolicy>
}

export interface BuckleRuntime {
  manifest(): HarnessManifest
  registry(): ToolRegistry
  skills(): LoadedSkill[]
  paths(): PathView
  policy: PolicyHandle
  grants: GrantStore
  approvals: ApprovalRegistry
  history: ChangeHistory
  actions: ActionLog
  plugins: PluginRegistry
  reporter: Reporter
  invoke(input: { request: InvokeRequest; sessionId: string; channel?: ApprovalChannel }): Promise<InvokeResponse>
  reload(): Promise<void>
  onToolsChanged(listener: () => void): void
}

export async function createRuntime(input: {
  config: BuckleConfig
  /** Built here because a channel that waits for a decision needs the registry holding it. */
  channel: (approvals: ApprovalRegistry) => ApprovalChannel
  /** Where refusals are announced. Defaults to the configured webhook, or to nothing. */
  reporter?: Reporter
}): Promise<BuckleRuntime> {
  const { config } = input
  // The sandbox masks this directory by path, so it has to exist before the first command runs.
  mkdirSync(config.stateDirectory, { recursive: true })
  const history = createChangeHistory({ directory: join(config.stateDirectory, 'history', workspaceStateKey(config.cwd)), excluded: [config.stateDirectory], maxBytes: config.historyMaxBytes, retentionDays: config.historyRetentionDays })
  const browserStateDirectory = join(config.stateDirectory, 'browser-sessions', workspaceStateKey(config.cwd))
  mkdirSync(browserStateDirectory, { recursive: true })

  const sandbox = resolveSandbox({
    requested: config.sandboxMode,
    acknowledgedUnsandboxed: config.acknowledgedUnsandboxed,
  })

  const grants = createFileGrantStore({ filePath: grantsPath(config), workspace: config.cwd })
  const approvals = createApprovalRegistry(grants, approvalsPath(config), config.cwd)
  const actions = createFileActionLog(actionsPath(config))
  const policyStore = createFilePolicyStore({ filePath: policyPath(config), workspace: config.cwd })
  const reporter = input.reporter ?? (config.reportUrl && config.reportToken
    ? createWebhookReporter({ url: config.reportUrl, token: config.reportToken })
    : nullReporter)
  const defaultChannel = input.channel(approvals)
  const plugins = createPluginRegistry({
    filePath: pluginsPath(config),
    packOptions: { cwd: config.cwd, sandboxMode: sandbox.sandbox.mode },
  })

  const localSkills = [loadRootSkill(), ...await loadSkills(config.skillDirectories)]
  const listeners: Array<() => void> = []

  let compiled = compileEffective()
  let paths = createPathView({ root: config.cwd, mount: compiled.mount, scratchRoots: config.scratchRoots })
  let permissions = buildPermissionEngine({ config, compiled, paths })
  let packs = await buildPacks({ config, sandbox, plugins, compiled, paths, browserStateDirectory, history })
  let registry = createToolRegistry(availableTools(packs))

  const runtime: BuckleRuntime = {
    manifest: () => buildManifest({ config, packs, registry, sandbox, paths, skills: allSkills() }),
    registry: () => registry,
    skills: allSkills,
    paths: () => paths,
    grants,
    approvals,
    actions,
    history,
    plugins,
    reporter,

    policy: {
      base: () => config.policy,
      stored: () => policyStore.read(),
      effective: () => compiled.policy,
      async apply(policy) {
        // Compiling the union first means a bad pattern is refused before anything is stored.
        compilePolicy(mergePolicies(config.policy, policy))
        policyStore.write({ ...policy, updatedAt: new Date().toISOString() })
        await runtime.reload()
        return compiled.policy
      },
      async clear() {
        policyStore.clear()
        await runtime.reload()
        return compiled.policy
      },
    },

    invoke: ({ request, sessionId, channel }) => createInvoker({
      registry,
      permissions,
      approvals,
      grants,
      actions,
      history,
      historyRoots: [realpathSync(config.cwd), ...config.scratchRoots.map(root => { let existing = root; while (!existsSync(existing)) existing = dirname(existing); return realpathSync(existing) })],
      reporter,
      paths,
      serverId: config.serverId,
      channel: channel ?? defaultChannel,
      defaultTimeoutMs: config.defaultTimeoutMs,
      maxTimeoutMs: config.maxTimeoutMs,
    }).invoke({ request, sessionId }),

    async reload() {
      compiled = compileEffective()
      paths = createPathView({ root: config.cwd, mount: compiled.mount, scratchRoots: config.scratchRoots })
      permissions = buildPermissionEngine({ config, compiled, paths })
      packs = await buildPacks({ config, sandbox, plugins, compiled, paths, browserStateDirectory, history })
      registry = createToolRegistry(availableTools(packs))
      for (const listener of listeners) listener()
    },

    onToolsChanged: listener => void listeners.push(listener),
  }

  function compileEffective(): CompiledPolicy {
    return compilePolicy(mergePolicies(config.policy, policyStore.read()))
  }

  function allSkills(): LoadedSkill[] {
    return [...availableSkills(packs), ...localSkills]
  }

  return runtime
}

async function buildPacks(input: {
  config: BuckleConfig
  sandbox: SandboxResolution
  plugins: PluginRegistry
  compiled: CompiledPolicy
  paths: PathView
  browserStateDirectory: string
  history: ChangeHistory
}): Promise<Pack[]> {
  const builtin = createBuiltinPacks({
    cwd: input.config.cwd,
    paths: input.paths,
    runProcess,
    sandbox: input.sandbox.sandbox,
    sandboxUnavailableReason: input.sandbox.unavailableReason,
    writableRoots: [input.config.cwd, ...input.config.scratchRoots],
    hiddenPaths: [input.config.stateDirectory],
    mountReadOnlyPaths: input.config.mountReadOnlyPaths,
    approvedUrls: input.compiled.network,
    braveSearchApiKey: input.config.braveSearchApiKey,
    allowedHosts: input.config.allowedHosts,
    agentBrowserCommand: input.config.agentBrowserCommand,
    browserStateDirectory: input.browserStateDirectory,
    browserHeaded: input.config.browserHeaded,
    enableShell: input.config.enableShell,
    shellNetwork: input.config.shellNetwork,
    shellIsolation: input.config.isolateShell ? { directory: join(input.config.stateDirectory, 'isolated-shell', workspaceStateKey(input.config.cwd)), maxBytes: input.config.isolationMaxBytes, history: input.history } : undefined,
    environmentValidator: input.config.environmentValidator,
  })
  const selected = input.config.enabledPacks
  if (selected) {
    const unknown = selected.filter(id => !builtin.some(pack => pack.id === id))
    if (unknown.length) throw new Error(`Unknown BUCKLE_PACKS: ${unknown.join(', ')}`)
    return builtin.filter(pack => selected.includes(pack.id))
  }
  return [...builtin, ...await input.plugins.load()]
}

/**
 * Order is the security model: floor rules run before scope rules, so a granted directory
 * can never unlock a credential file or a destructive command inside it. The owner's command
 * policy sits first among the floors, because its answer is a denial rather than a question.
 */
function buildPermissionEngine(input: { config: BuckleConfig; compiled: CompiledPolicy; paths: PathView }): PermissionEngine {
  const { config, compiled, paths } = input
  return createPermissionEngine([
    createSensitivePathRule({ protectedRoots: [config.stateDirectory] }),
    createCommandPolicyRule(compiled),
    createDestructiveCommandRule({ added: compiled.commands.destructive }),
    createNetworkEgressRule({ approved: compiled.network }),
    createProcessProbeRule(),
    createReadScopeRule({ paths }),
    createWriteScopeRule({ paths, strict: config.strictWrites }),
  ])
}

function buildManifest(input: {
  config: BuckleConfig
  packs: Pack[]
  registry: ToolRegistry
  sandbox: SandboxResolution
  paths: PathView
  skills: LoadedSkill[]
}): HarnessManifest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverId: input.config.serverId,
    name: input.config.serverName,
    description: input.config.description,
    usage: input.config.usage,
    version: BUCKLE_VERSION,
    platform: { os: platform(), arch: arch(), hostname: hostname() },
    sandbox: {
      mode: input.sandbox.sandbox.mode,
      acknowledgedUnsandboxed: input.config.acknowledgedUnsandboxed,
    },
    workspaceRoots: [input.paths.displayRoot, ...input.config.scratchRoots],
    tools: input.registry.capabilities(),
    skills: input.skills.map(toDescriptor),
    packs: input.packs.map(packDescriptor),
    limits: {
      maxRequestBytes: input.config.maxRequestBytes,
      defaultTimeoutMs: input.config.defaultTimeoutMs,
      maxTimeoutMs: input.config.maxTimeoutMs,
    },
    generatedAt: new Date().toISOString(),
  }
}
