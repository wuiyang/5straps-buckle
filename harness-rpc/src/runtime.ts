import { createWorkbenchManager } from './services/workbench/manager.js'
import { WorkbenchError, workbenchHash } from './services/workbench/storage.js'
import { spawnPtyProcess } from './adapters/pty-process.js'
import { buildChildEnvironment } from './domain/environment.js'
import { hasExecutable } from './domain/executable.js'
import { isInside } from './domain/paths.js'
import { collectShellHiddenPaths } from './services/shell-filesystem.js'
import { createFilesystemPolicyRule, filesystemPathDecision, projectFilesystemSandbox, resolveFilesystemPermission } from './domain/filesystem-policy.js'
import { createShellWorkspaceRecovery } from './services/isolated-shell.js'
import { join, dirname } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { createChangeHistory, type ChangeHistory } from './services/history/journal.js'
import { mkdirSync } from 'node:fs'
import { arch, hostname, platform } from 'node:os'
import { PROTOCOL_VERSION, isWorkspaceToolAllowed, type HarnessManifest, type InvokeRequest, type InvokeResponse, type WorkspacePolicy, type ToolCapability } from '@5straps/protocol'
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
import { compilePolicy, mergePolicies, policyRevision, PolicyConflictError, type CompiledPolicy, type SkippedEntry } from './domain/policy.js'
import { loadSkills } from './domain/skill-registry.js'
import { toDescriptor, type LoadedSkill } from './domain/skill.js'
import { createToolRegistry, type ToolRegistry } from './domain/tool-registry.js'
import { intersectUrlMatchers, type UrlMatcher } from './domain/url-pattern.js'
import type { PermissionRule } from './domain/permission/decision.js'
import { workspaceStateKey } from './domain/workspace-key.js'
import { logger } from './logger.js'
import { createBuiltinPacks, unmetPackPrerequisite } from './packs/index.js'
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
 * `buckle policy` or a push through setup. Managed children replace their initial policy;
 * the separate immutable installation ceiling always applies. Legacy default policy merges.
 */
export interface PolicyHandle {
  base(): WorkspacePolicy
  stored(): WorkspacePolicy | null
  effective(): WorkspacePolicy
  /** The node's own policy over a registered workspace, which every call also meets. Null on the node's workspace. */
  ceiling(): WorkspacePolicy | null
  /** A fresh egress rule and approved list, built by the same construction the engine and packs use, for `buckle check-url`. */
  network(): { rule: PermissionRule; approved: UrlMatcher | null }
  /** Approved-list entries in force that the host grammar refuses, skipped at load; `buckle policy migrate --write` drops the stored ones. */
  skipped(): SkippedEntry[]
  /** Validates against the base, stores, and rebuilds the rules and packs. Throws PolicyError. */
  revision(): string
  apply(policy: WorkspacePolicy, expectedRevision?: string): Promise<WorkspacePolicy>
  /** Drops the stored policy, leaving the environment's. */
  clear(expectedRevision?: string): Promise<WorkspacePolicy>
}

export interface BuckleRuntime {
  readonly workspaceId: string
  workbenches: ReturnType<typeof createWorkbenchManager>
  hasActiveWork(): boolean
  manifest(): HarnessManifest
  toolCatalog(): { tools: ToolCapability[]; unavailable: Array<{ name: string; reason: string }> }
  registry(): ToolRegistry
  skills(): LoadedSkill[]
  paths(): PathView
  policy: PolicyHandle
  grants: GrantStore
  approvals: ApprovalRegistry
  history: ChangeHistory
  shellWorkspaces: ReturnType<typeof createShellWorkspaceRecovery>
  actions: ActionLog
  plugins: PluginRegistry
  reporter: Reporter
  invoke(input: { request: InvokeRequest; sessionId: string; channel?: ApprovalChannel }): Promise<InvokeResponse>
  reload(): Promise<void>
  onToolsChanged(listener: () => void): void
}

export async function createRuntime(input: {
  config: BuckleConfig
  workspaceId?: string
  /** Built here because a channel that waits for a decision needs the registry holding it. */
  channel: (approvals: ApprovalRegistry) => ApprovalChannel
  /** Where refusals are announced. Defaults to the configured webhook, or to nothing. */
  reporter?: Reporter
}): Promise<BuckleRuntime> {
  const { config } = input
  const ceiling = config.nodePolicy ? compilePolicy(config.nodePolicy, { tolerated: () => true }) : null
  if (ceiling) warnSkipped(ceiling.skipped)
  // The sandbox masks this directory by path, so it has to exist before the first command runs.
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 })
  const history = createChangeHistory({ directory: join(config.stateDirectory, 'history', workspaceStateKey(config.cwd)), excluded: [config.nodeStateDirectory ?? config.stateDirectory], maxBytes: config.historyMaxBytes, retentionDays: config.historyRetentionDays })
  const browserStateDirectory = join(config.stateDirectory, 'browser-sessions', workspaceStateKey(config.cwd))
  mkdirSync(browserStateDirectory, { recursive: true })

  const sandbox = resolveSandbox({
    requested: config.sandboxMode,
    acknowledgedUnsandboxed: config.acknowledgedUnsandboxed,
  })

  const grants = createFileGrantStore({ filePath: grantsPath(config), workspace: config.cwd })
  const approvals = createApprovalRegistry(grants, approvalsPath(config), config.cwd)
  const actions = createFileActionLog(actionsPath(config))
  await actions.recoverInterrupted()
  const policyStore = createFilePolicyStore({ filePath: policyPath(config), workspace: config.cwd })
  const reporter = input.reporter ?? (config.reportUrl && config.reportToken
    ? createWebhookReporter({ url: config.reportUrl, token: config.reportToken, serverId: config.serverId, approvalKey: config.ringsApprovalKey })
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
  let permissions = buildPermissionEngine({ config, compiled, ceiling, paths })
  let packs = await buildPacks({ config, sandbox, plugins, compiled, ceiling, paths, browserStateDirectory, history })
  let registry = createToolRegistry(availableTools(packs))

  let activeInvocations = 0
  const workbenches = createWorkbenchManager({
    directory: join(config.stateDirectory, 'workbenches', workspaceStateKey(config.cwd)),
    sourceRoot: config.cwd, workspaceId: input.workspaceId ?? 'default', maxBytes: config.isolationMaxBytes,
    protectedRoots: [config.nodeStateDirectory ?? config.stateDirectory], actions, history,
    hasRipgrep: hasExecutable('rg'), spawnPty: spawnPtyProcess,
    policyHash: () => workbenchHash(JSON.stringify([compiled.policy, ceiling?.policy ?? null])),
    authorizeTool: tool => toolDenial(tool) === null,
    authorizePath: (path, operation) => !['deny', 'ask'].includes(resolveFilesystemPermission({ path, operation, policy: compiled.policy, ceiling: ceiling?.policy })),
    async prepareTerminal(request) {
      const denial = toolDenial('shell_exec')
      if (denial) throw new WorkbenchError(denial, 403)
      if (!config.enableShell || config.enabledPacks && !config.enabledPacks.includes('shell') || sandbox.sandbox.mode !== 'bubblewrap') throw new WorkbenchError('Interactive terminals require an enabled bubblewrap sandbox', 403)
      const policies = [compiled.policy, ...(ceiling ? [ceiling.policy] : [])]
      if (policies.some(policy => policy.commands.allow.length || policy.commands.deny.length || policy.commands.destructive?.length)) throw new WorkbenchError('Interactive shells cannot enforce command allowlists, denylists or command approval rules', 403)
      const signal = AbortSignal.timeout(15_000)
      const projection = await projectFilesystemSandbox({ root: request.root, policy: compiled.policy, ceiling: ceiling?.policy, signal })
      const hidden = await collectShellHiddenPaths({ roots: [request.root, ...config.mountReadOnlyPaths], protectedPaths: [], signal })
      if (projection.hiddenPaths.some(path => isInside(path, request.cwd))) throw new WorkbenchError('Filesystem restrictions hide this terminal working directory', 403)
      const wrapped = sandbox.sandbox.wrap({ command: 'bash', args: ['--noprofile', '--norc', '-i'], cwd: request.cwd,
        workspaceRoot: request.root, writableRoots: [request.root], mount: { root: request.root, at: '/workspace' }, commandIsPid1: true,
        allowNetwork: config.shellNetwork && !policies.some(policy => policy.network.allow.length) && config.allowedHosts.length === 0,
        hiddenPaths: [...hidden.directories, ...projection.hiddenPaths], hiddenFiles: [...hidden.files, ...projection.hiddenFiles],
        readOnlyPaths: config.mountReadOnlyPaths, readOnlyWorkspacePaths: projection.readOnlyWorkspacePaths,
      })
      const environment = Object.fromEntries(Object.entries(buildChildEnvironment({ parent: process.env, extra: { TERM: 'xterm-256color' } })).filter((entry): entry is [string, string] => entry[1] !== undefined))
      return { ...wrapped, cwd: request.cwd, environment, cols: request.cols, rows: request.rows }
    },
  })

  const runtime: BuckleRuntime = {
    workspaceId: input.workspaceId ?? 'default',
    workbenches,
    hasActiveWork: () => activeInvocations > 0 || workbenches.hasActiveWork() || runtime.shellWorkspaces.list().some(item => item.status !== 'published'),
    manifest: () => ({ ...buildManifest({ config, packs, registry, sandbox, paths, skills: allSkills() }), tools: registry.capabilities().filter(tool => toolDenial(tool.name) === null) }),
    toolCatalog: () => ({ tools: registry.capabilities(), unavailable: registry.capabilities().flatMap(tool => {
      const reason = toolDenial(tool.name)
      return reason ? [{ name: tool.name, reason }] : []
    }) }),
    registry: () => registry,
    skills: allSkills,
    paths: () => paths,
    grants,
    approvals,
    actions,
    history,
    shellWorkspaces: createShellWorkspaceRecovery({ directory: join(config.stateDirectory, 'isolated-shell', workspaceStateKey(config.cwd)), sourceRoot: config.cwd, maxBytes: config.isolationMaxBytes, retentionDays: config.historyRetentionDays, history }),
    plugins,
    reporter,

    policy: {
      base: () => config.policy,
      stored: () => policyStore.read(),
      effective: () => compiled.policy,
      ceiling: () => ceiling?.policy ?? null,
      skipped: () => compiled.skipped,
      network: () => ({ rule: networkEgressRule(compiled, ceiling), approved: approvedUrls(compiled, ceiling) }),
      revision: () => policyRevision(policyStore.read()),
      async apply(policy, expectedRevision) {
        if (runtime.hasActiveWork()) throw new PolicyConflictError('Resolve active work and staged changes before changing workspace policy')
        const inForce = new Set([...config.policy.network.allow, ...policyStore.read()?.network.allow ?? []])
        compileEffective(policy, entry => inForce.has(entry))
        policyStore.write({ ...policy, updatedAt: new Date().toISOString() }, expectedRevision)
        await runtime.reload()
        return compiled.policy
      },
      async clear(expectedRevision) {
        if (runtime.hasActiveWork()) throw new PolicyConflictError('Resolve active work and staged changes before changing workspace policy')
        policyStore.clear(expectedRevision)
        await runtime.reload()
        return compiled.policy
      },
    },

    async invoke({ request, sessionId, channel }) {
      activeInvocations++
      try { return await createInvoker({
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
      workspaceId: input.workspaceId ?? 'default',
      channel: channel ?? defaultChannel,
      defaultTimeoutMs: config.defaultTimeoutMs,
      maxTimeoutMs: config.maxTimeoutMs,
      toolDenial,
    }).invoke({ request, sessionId }) } finally { activeInvocations-- }
    },

    async reload() {
      await workbenches.policyChanged()
      compiled = compileEffective()
      paths = createPathView({ root: config.cwd, mount: compiled.mount, scratchRoots: config.scratchRoots })
      permissions = buildPermissionEngine({ config, compiled, ceiling, paths })
      packs = await buildPacks({ config, sandbox, plugins, compiled, ceiling, paths, browserStateDirectory, history })
      registry = createToolRegistry(availableTools(packs))
      for (const listener of listeners) listener()
    },

    onToolsChanged: listener => void listeners.push(listener),
  }

  /** At load every entry is already in force, so any the grammar refuses is skipped; `apply` narrows that to the entries it found. */
  function compileEffective(stored = policyStore.read(), tolerated: (entry: string) => boolean = () => true): CompiledPolicy {
    const policy = ceiling
      ? { ...(stored ?? config.policy), mount: config.policy.mount }
      : mergePolicies(config.policy, stored)
    const result = compilePolicy(policy, { tolerated })
    warnSkipped(result.skipped)
    return result
  }

  function allSkills(): LoadedSkill[] {
    return [...availableSkills(packs), ...localSkills]
  }

  function toolDenial(tool: string): string | null {
    if (ceiling && !isWorkspaceToolAllowed(ceiling.policy, tool)) return 'Disabled by node tool policy'
    if (!isWorkspaceToolAllowed(compiled.policy, tool)) return 'Disabled by workspace tool policy'
    return null
  }

  return runtime
}

const warnedSkipped = new Set<string>()

function warnSkipped(skipped: SkippedEntry[]): void {
  for (const { entry, reason } of skipped) {
    if (warnedSkipped.has(entry)) continue
    warnedSkipped.add(entry)
    logger.warn('Approved list entry skipped: it covers nothing. Remove it with buckle policy migrate --write or buckle policy remove; if it is the only entry, add a valid one first with buckle policy allow-url, because an empty list is no list and lets the default rules reach public hosts', { entry, reason })
  }
}

async function buildPacks(input: {
  config: BuckleConfig
  sandbox: SandboxResolution
  plugins: PluginRegistry
  compiled: CompiledPolicy
  ceiling: CompiledPolicy | null
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
    hiddenPaths: [input.config.nodeStateDirectory ?? input.config.stateDirectory],
    mountReadOnlyPaths: input.config.mountReadOnlyPaths,
    approvedUrls: approvedUrls(input.compiled, input.ceiling),
    approvedLists: [
      ...(input.ceiling?.network ? [{ name: 'node' as const, entries: input.ceiling.network.patterns }] : []),
      ...(input.compiled.network ? [{ name: 'workspace' as const, entries: input.compiled.network.patterns }] : []),
    ],
    braveSearchApiKey: input.config.braveSearchApiKey,
    forge: { token: input.config.forgeGithubToken, apiUrl: input.config.forgeApiUrl, author: input.config.forgeGitAuthor },
    stateDirectory: input.config.stateDirectory,
    allowedHosts: input.config.allowedHosts,
    agentBrowserCommand: input.config.agentBrowserCommand,
    browserStateDirectory: input.browserStateDirectory,
    browserHeaded: input.config.browserHeaded,
    enableShell: input.config.enableShell,
    allowHostGit: input.config.allowHostGit,
    allowHostLsp: input.config.allowHostLsp,
    shellNetwork: input.config.shellNetwork,
    filesystemPolicy: { policy: input.compiled.policy, ceiling: input.ceiling?.policy },
    shellIsolation: input.config.isolateShell ? { directory: join(input.config.stateDirectory, 'isolated-shell', workspaceStateKey(input.config.cwd)), maxBytes: input.config.isolationMaxBytes, history: input.history } : undefined,
    environmentValidator: input.config.environmentValidator,
  })
  const selected = input.config.enabledPacks
  if (selected) {
    const unknown = selected.filter(id => !builtin.some(pack => pack.id === id))
    if (unknown.length) {
      const named = unknown.map(id => { const reason = unmetPackPrerequisite(id, input.config); return reason ? `${id} (${reason})` : id })
      throw new Error(`Unknown BUCKLE_PACKS: ${named.join(', ')}`)
    }
    return builtin.filter(pack => selected.includes(pack.id))
  }
  const filesystemRestricted = Boolean(input.compiled.policy.filesystem?.rules.length || input.ceiling?.policy.filesystem?.rules.length)
  return [...builtin, ...(filesystemRestricted ? [] : await input.plugins.load())]
}

/** The approved list every call meets: the node's over a registered workspace, then the workspace's own. */
function approvedUrls(compiled: CompiledPolicy, ceiling: CompiledPolicy | null): UrlMatcher | null {
  return intersectUrlMatchers(ceiling?.network, compiled.network)
}

/** One construction for the engine and `buckle check-url`, so the check cannot drift from the rule. */
function networkEgressRule(compiled: CompiledPolicy, ceiling: CompiledPolicy | null): PermissionRule {
  return createNetworkEgressRule({ approved: approvedUrls(compiled, ceiling) })
}

/**
 * Order is the security model: floor rules run before scope rules, so a granted directory
 * can never unlock a credential file or a destructive command inside it. The owner's command
 * policy sits first among the floors, because its answer is a denial rather than a question.
 */
function buildPermissionEngine(input: { config: BuckleConfig; compiled: CompiledPolicy; ceiling: CompiledPolicy | null; paths: PathView }): PermissionEngine {
  const { config, compiled, ceiling, paths } = input
  return createPermissionEngine([
    createSensitivePathRule({ protectedRoots: [config.nodeStateDirectory ?? config.stateDirectory] }),
    ...(ceiling ? [createCommandPolicyRule(ceiling, { enforceWrapperAllow: false })] : []),
    createCommandPolicyRule(compiled, { enforceWrapperAllow: !ceiling?.commands.allow.length }),
    createDestructiveCommandRule({ added: [...(ceiling?.commands.destructive ?? []), ...compiled.commands.destructive] }),
    networkEgressRule(compiled, ceiling),
    createProcessProbeRule(),
    createFilesystemPolicyRule({ root: config.cwd, policy: compiled.policy, ceiling: ceiling?.policy }),
    createReadScopeRule({ paths }),
    createWriteScopeRule({ paths, strict: config.strictWrites, pathDecision: path => filesystemPathDecision({ root: config.cwd, path, operation: 'write', policy: compiled.policy, ceiling: ceiling?.policy }) }),
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
