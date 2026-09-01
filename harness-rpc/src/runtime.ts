import { arch, hostname, platform } from 'node:os'
import { PROTOCOL_VERSION, type HarnessManifest, type InvokeRequest, type InvokeResponse } from '@5straps/protocol'
import { createFileActionLog } from './adapters/action-log/file-action-log.js'
import { createPluginRegistry, type PluginRegistry } from './adapters/plugin-registry.js'
import { createFileGrantStore } from './adapters/grant-store/file-grant-store.js'
import { runProcess } from './adapters/process-runner.js'
import { resolveSandbox, type SandboxResolution } from './adapters/sandbox/create-sandbox.js'
import { actionsPath, approvalsPath, grantsPath, pluginsPath, type BuckleConfig } from './config.js'
import { availableSkills, availableTools, packDescriptor, type Pack } from './domain/pack.js'
import { createPermissionEngine } from './domain/permission/engine.js'
import { createDestructiveCommandRule } from './domain/permission/rules/destructive-command-rule.js'
import { createNetworkEgressRule } from './domain/permission/rules/network-egress-rule.js'
import { createProcessProbeRule } from './domain/permission/rules/process-probe-rule.js'
import { createReadScopeRule } from './domain/permission/rules/read-scope-rule.js'
import { createSensitivePathRule } from './domain/permission/rules/sensitive-path-rule.js'
import { createWriteScopeRule } from './domain/permission/rules/write-scope-rule.js'
import { loadSkills } from './domain/skill-registry.js'
import { toDescriptor, type LoadedSkill } from './domain/skill.js'
import { createToolRegistry, type ToolRegistry } from './domain/tool-registry.js'
import { createBuiltinPacks } from './packs/index.js'
import { loadRootSkill } from './packs/pack-skill.js'
import type { ActionLog } from './ports/action-log.js'
import type { ApprovalChannel } from './ports/approval-channel.js'
import type { GrantStore } from './ports/grant-store.js'
import { createApprovalRegistry, type ApprovalRegistry } from './services/approval-registry.js'
import { createInvoker } from './services/invoker.js'
import { BUCKLE_VERSION } from './version.js'

export interface BuckleRuntime {
  manifest(): HarnessManifest
  registry(): ToolRegistry
  skills(): LoadedSkill[]
  grants: GrantStore
  approvals: ApprovalRegistry
  actions: ActionLog
  plugins: PluginRegistry
  invoke(input: { request: InvokeRequest; sessionId: string; channel?: ApprovalChannel }): Promise<InvokeResponse>
  reload(): Promise<void>
  onToolsChanged(listener: () => void): void
}

export async function createRuntime(input: {
  config: BuckleConfig
  channel: ApprovalChannel
}): Promise<BuckleRuntime> {
  const { config } = input
  const sandbox = resolveSandbox({
    requested: config.sandboxMode,
    acknowledgedUnsandboxed: config.acknowledgedUnsandboxed,
  })

  const grants = createFileGrantStore({ filePath: grantsPath(config), workspace: config.cwd })
  const approvals = createApprovalRegistry(grants, approvalsPath(config))
  const actions = createFileActionLog(actionsPath(config))
  const permissions = buildPermissionEngine(config)
  const plugins = createPluginRegistry({
    filePath: pluginsPath(config),
    packOptions: { cwd: config.cwd, sandboxMode: sandbox.sandbox.mode },
  })

  const localSkills = [loadRootSkill(), ...await loadSkills(config.skillDirectories)]
  const listeners: Array<() => void> = []
  let packs = await buildPacks({ config, sandbox, plugins })
  let registry = createToolRegistry(availableTools(packs))

  const runtime: BuckleRuntime = {
    manifest: () => buildManifest({ config, packs, registry, sandbox, skills: allSkills() }),
    registry: () => registry,
    skills: allSkills,
    grants,
    approvals,
    actions,
    plugins,

    invoke: ({ request, sessionId, channel }) => createInvoker({
      registry,
      permissions,
      approvals,
      grants,
      actions,
      channel: channel ?? input.channel,
      cwd: config.cwd,
      defaultTimeoutMs: config.defaultTimeoutMs,
      maxTimeoutMs: config.maxTimeoutMs,
    }).invoke({ request, sessionId }),

    async reload() {
      packs = await buildPacks({ config, sandbox, plugins })
      registry = createToolRegistry(availableTools(packs))
      for (const listener of listeners) listener()
    },

    onToolsChanged: listener => void listeners.push(listener),
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
}): Promise<Pack[]> {
  const builtin = createBuiltinPacks({
    cwd: input.config.cwd,
    runProcess,
    sandbox: input.sandbox.sandbox,
    sandboxUnavailableReason: input.sandbox.unavailableReason,
    writableRoots: [input.config.cwd, ...input.config.scratchRoots],
    braveSearchApiKey: input.config.braveSearchApiKey,
    allowedHosts: input.config.allowedHosts,
    agentBrowserCommand: input.config.agentBrowserCommand,
    browserHeaded: input.config.browserHeaded,
    enableShell: input.config.enableShell,
  })
  return [...builtin, ...await input.plugins.load()]
}

/**
 * Order is the security model: floor rules run before scope rules, so a granted directory
 * can never unlock a credential file or a destructive command inside it.
 */
function buildPermissionEngine(config: BuckleConfig) {
  return createPermissionEngine([
    createSensitivePathRule(),
    createDestructiveCommandRule(),
    createNetworkEgressRule(),
    createProcessProbeRule(),
    createReadScopeRule([config.cwd]),
    createWriteScopeRule({ scratchRoots: config.scratchRoots, strict: config.strictWrites }),
  ])
}

function buildManifest(input: {
  config: BuckleConfig
  packs: Pack[]
  registry: ToolRegistry
  sandbox: SandboxResolution
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
    workspaceRoots: [input.config.cwd, ...input.config.scratchRoots],
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
