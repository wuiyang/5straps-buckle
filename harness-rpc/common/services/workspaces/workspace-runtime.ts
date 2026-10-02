import { validateSandboxMounts } from '../../domain/sandbox-mounts.js'
import { protectedStateRoots } from '../../runtime/config.js'
import { createWorkbenchManager } from '../workbench/manager.js'
import { WorkbenchError, workbenchesDirectory, workbenchHash } from '../workbench/storage.js'
import { spawnPtyProcess } from '../../adapters/pty-process.js'
import { buildChildEnvironment } from '../../domain/environment.js'
import { hasExecutable } from '../../domain/executable.js'
import { isInside } from '../../domain/paths.js'
import { collectShellHiddenPaths } from '../shell/shell-filesystem.js'
import { createFilesystemPolicyRule, filesystemPathDecision, projectFilesystemSandbox, resolveFilesystemPermission } from '../../domain/filesystem-policy.js'
import { createShellWorkspaceRecovery } from '../shell/isolated-shell.js'
import { join, dirname } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { openChangeHistory, type ChangeHistory } from '../history/journal.js'
import { mkdirSync } from 'node:fs'
import { arch, hostname, platform } from 'node:os'
import { PROTOCOL_VERSION, isWorkspaceToolAllowed, type HarnessManifest, type InvokeResponse, type WorkspacePolicy, type ToolCapability } from '@5straps/protocol'
import { createFileActionLog } from '../../adapters/action-log/file-action-log.js'
import { createPluginRegistry, type PluginRegistry } from '../../adapters/plugin-registry.js'
import { createFileGrantStore } from '../../adapters/grant-store/file-grant-store.js'
import { createFilePolicyStore } from '../../adapters/policy-store/file-policy-store.js'
import { runProcess } from '../../adapters/process-runner.js'
import { createWebhookReporter } from '../../adapters/report/webhook-reporter.js'
import { resolveSandbox, type SandboxResolution } from '../../adapters/sandbox/create-sandbox.js'
import { actionsPath, approvalNoncesPath, approvalsPath, dangerouslyAllowPath, grantsPath, pluginsPath, policyPath, type BuckleConfig } from '../../runtime/config.js'
import { createFileDangerouslyAllowStore } from '../../adapters/policy-store/file-dangerously-allow-store.js'
import { createMemoryNonceClaims, openFileNonceStore } from '../../adapters/approval/file-nonce-store.js'
import { availableSkills, availableTools, packDescriptor, type Pack } from '../../domain/pack.js'
import { createPathView, type PathView } from '../../domain/path-view.js'
import { createPermissionEngine, type PermissionEngine } from '../../domain/permission/engine.js'
import { createCommandPolicyRule } from '../../domain/permission/rules/command-policy-rule.js'
import { createDestructiveCommandRule } from '../../domain/permission/rules/destructive-command-rule.js'
import { createNetworkEgressRule } from '../../domain/permission/rules/network-egress-rule.js'
import { createProcessProbeRule } from '../../domain/permission/rules/process-probe-rule.js'
import { createReadScopeRule } from '../../domain/permission/rules/read-scope-rule.js'
import { createSensitivePathRule } from '../../domain/permission/rules/sensitive-path-rule.js'
import { createWriteScopeRule } from '../../domain/permission/rules/write-scope-rule.js'
import { compilePolicy, mergePolicies, policyRevision, PolicyConflictError, PolicyError, StoredPolicyError, type CompiledPolicy } from '../../domain/policy.js'
import { withDangerouslyAllow } from '../../domain/permission/rules/dangerously-allow.js'
import { loadSkills } from '../../domain/skill-registry.js'
import { toDescriptor, type LoadedSkill } from '../../domain/skill.js'
import { createToolRegistry, type ToolRegistry } from '../../domain/tool-registry.js'
import { intersectUrlMatchers, type UrlMatcher } from '../../domain/url-pattern.js'
import type { PermissionRule } from '../../domain/permission/decision.js'
import { workspaceStateKey } from '../../domain/workspace-key.js'
import { createBuiltinPacks, unmetPackPrerequisite } from '../packs/index.js'
import { loadRootSkill } from '../packs/pack-skill.js'
import type { ActionLog, AuditHealth } from '../../types/ports/action-log.js'
import type { GrantStore } from '../../types/ports/grant-store.js'
import { nullReporter, type Reporter } from '../../types/ports/reporter.js'
import { createApprovalRegistry, type ApprovalRegistry } from '../approvals/approval-registry.js'
import { createApprovalService, type ApprovalService } from '../approvals/approval-service.js'
import type { InteractionSource } from '../approvals/interaction.js'
import { createApprovalNoticeSender, createWebhookNotifier } from '../../adapters/approval/webhook-notifier.js'
import { createApprovalNotices, type ApprovalNotices } from '../approvals/approval-notices.js'
import { createExecutionBudget, createExecutions, type ExecutionBudget } from '../invocation/executions.js'
import { createInvoker, InvocationsClosedError, type InvokeInput } from '../invocation/invoker.js'
import { createAuditHealth } from '../audit/audit-health.js'
import { logger } from '../../runtime/log.js'
import { auditOperation } from '../audit/audit-operation.js'
import { BUCKLE_VERSION } from '../../runtime/version.js'

/**
 * The owner's policy as the runtime holds it. `base` came from the environment, or for a registered
 * workspace from its registration; `stored` from `buckle policy` or a push through setup. A stored
 * policy replaces a registered workspace's registration policy until it is cleared; the node's own
 * policy over it always applies. The default workspace merges both. The dangerously-allow switch is
 * stored apart and never touches either (review H1 of B20-B22).
 */
export interface PolicyHandle {
  base(): WorkspacePolicy
  stored(): WorkspacePolicy | null
  effective(): WorkspacePolicy
  /** The node's own policy over a registered workspace, which every call also meets. Null on the node's workspace. */
  ceiling(): WorkspacePolicy | null
  /** A fresh egress rule and approved list, built by the same construction the engine and packs use, for `buckle check-url`. */
  network(): { rule: PermissionRule; approved: UrlMatcher | null }
  /** Validates against the base, stores, and rebuilds the rules and packs. Throws PolicyError. */
  revision(): string
  apply(policy: WorkspacePolicy, expectedRevision?: string): Promise<WorkspacePolicy>
  /** Drops the stored policy, leaving the environment's, or a registered workspace's registration policy. The switch is left as it is. */
  clear(expectedRevision?: string): Promise<WorkspacePolicy>
  /**
   * The dangerously-allow switch as stored now, read from the store at every call, so the local
   * switch applies in a running node at once: `on`, whether the node's own switch allows it over a
   * registered workspace (null on the node's workspace), whether calls here are allowed by it, and
   * the root it is bound to, as the agent names it (owner decision D7).
   */
  dangerouslyAllow(): { on: boolean; allowedByNode: boolean | null; effective: boolean; boundTo: string }
  /** The one switch, for the owner's local CLI only (ruling H1e), audited `policy_dangerously_allow_changed`. Writes nothing the policy is read from. */
  setDangerouslyAllow(on: boolean): Promise<void>
}

export interface BuckleRuntime {
  readonly workspaceId: string
  workbenches: ReturnType<typeof createWorkbenchManager>
  hasActiveWork(): Promise<boolean>
  /** The same question for inspection, read without taking workbench ownership (review L4 of B15-B17). */
  inspectActiveWork(): boolean
  manifest(): HarnessManifest
  toolCatalog(): { tools: ToolCapability[]; unavailable: Array<{ name: string; reason: string }> }
  registry(): ToolRegistry
  skills(): LoadedSkill[]
  paths(): PathView
  policy: PolicyHandle
  grants: GrantStore
  approvals: ApprovalRegistry
  /** The single answerer: every ask waits here and every verdict is recorded here. */
  approvalService: ApprovalService
  history: ChangeHistory
  shellWorkspaces: ReturnType<typeof createShellWorkspaceRecovery>
  actions: ActionLog
  /** Whether the audit log takes its writes; shared by the node's workspaces, read by readiness. */
  readonly auditHealth: AuditHealth
  /** The node's byte budget for the responses kept for re-sends, shared the same way. */
  readonly executionBudget: ExecutionBudget
  plugins: PluginRegistry
  reporter: Reporter
  invoke(input: InvokeInput): Promise<InvokeResponse>
  /**
   * Shutdown's in-flight tool calls step (B19): cancels every call still running here, a shell among
   * them, and waits for each to answer. Calls that arrive later are refused the same way.
   */
  cancelInvocations(): Promise<void>
  /** Shutdown's language servers and browser sessions step: each pack closes what it opened. */
  closeSessions(): Promise<void>
  reload(): Promise<void>
  onToolsChanged(listener: () => void): void
}

interface RuntimeInput {
  config: BuckleConfig
  workspaceId?: string
  /** The current operation's interaction; without one no question is asked and a gated call reports back at once. */
  interaction?: InteractionSource
  /** Where refusals are announced. Defaults to the configured webhook, or to nothing. */
  reporter?: Reporter
  /** The process's audit health, shared with the node's other workspaces; a fresh one when absent. */
  auditHealth?: AuditHealth
  /** The node's budget for kept responses, shared with its other workspaces; a fresh one when absent. */
  executionBudget?: ExecutionBudget
  /** For a registered workspace: whether the node's own dangerously-allow switch is on, the ceiling it needs too. */
  nodeDangerouslyAllowed?: () => boolean
  /** For a registered workspace: whether it serves calls now (enabled, not retired); its log's failures count toward readiness only then. */
  serving?: () => boolean
}

export async function createRuntime(input: RuntimeInput): Promise<BuckleRuntime> {
  const { config } = input
  const ceiling = config.nodePolicy ? compilePolicy(config.nodePolicy) : null
  // The sandbox masks this directory by path, so it has to exist before the first command runs.
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 })
  const history = await openChangeHistory({ directory: join(config.stateDirectory, 'history', workspaceStateKey(config.cwd)), excluded: protectedStateRoots(config), maxBytes: config.historyMaxBytes, retentionDays: config.historyRetentionDays, label: `history:${input.workspaceId ?? 'default'}` })
  let closeApprovals: (() => Promise<void>) | undefined
  try {
    return await assembleRuntime({ ...input, ceiling, history, onApprovalCleanup: close => { closeApprovals = close } })
  } catch (error) {
    // No close step owns the connection until the runtime exists (runtime.md: clean up after partial initialization).
    try { await closeApprovals?.() } finally { await history.close() }
    throw error
  }
}

async function assembleRuntime(input: RuntimeInput & { ceiling: CompiledPolicy | null; history: ChangeHistory; onApprovalCleanup: (close: () => Promise<void>) => void }): Promise<BuckleRuntime> {
  const { config, ceiling, history } = input
  const browserStateDirectory = join(config.stateDirectory, 'browser-sessions', workspaceStateKey(config.cwd))
  mkdirSync(browserStateDirectory, { recursive: true })

  const sandbox = resolveSandbox({
    requested: config.sandboxMode,
    acknowledgedUnsandboxed: config.acknowledgedUnsandboxed,
  })

  const lockDeadlineMs = config.stateLockDeadlineMs
  const grants = createFileGrantStore({ filePath: grantsPath(config), workspace: config.cwd, lockDeadlineMs })
  const workspaceId = input.workspaceId ?? 'default'
  // Every notification names its workspace, whose `buckle approve --workspace` answers it.
  const webhook = config.approvalWebhook ? { url: config.approvalWebhook, serverId: config.serverId, workspaceId, token: config.reportToken, approvalKey: config.ringsApprovalKey } : null
  let notices: ApprovalNotices | undefined
  const approvals = createApprovalRegistry(grants, approvalsPath(config), config.cwd, config.approvalTimeoutMs, {
    lockDeadlineMs, durableNotices: webhook !== null,
    onExpired: requests => notices?.expired(requests),
    onNoticeQueued: () => { void notices?.flush() },
  })
  notices = createApprovalNotices(webhook ? createApprovalNoticeSender(webhook) : undefined, webhook ? { registry: approvals } : {})
  const noticeOwner = notices
  input.onApprovalCleanup(() => noticeOwner.settle())
  const auditHealth = input.auditHealth ?? createAuditHealth()
  const actions = createFileActionLog(actionsPath(config), { lockDeadlineMs, health: auditHealth, workspaceId: input.workspaceId ?? 'default', ...(input.serving ? { serving: input.serving } : {}) })
  await actions.recoverInterrupted()
  // Replay protection for sealed decisions from Rings: on disk once a key is paired.
  const approvalNonces = config.ringsApprovalKey ? await openFileNonceStore({ filePath: approvalNoncesPath(config) }) : createMemoryNonceClaims()
  const approvalService = createApprovalService({
    registry: approvals, workspaceId, serverId: config.serverId, graceMs: config.approvalTimeoutMs,
    interaction: input.interaction ?? (async () => undefined),
    announce: webhook ? createWebhookNotifier(webhook) : undefined,
    notices, decisionKey: config.ringsApprovalKey, nonces: approvalNonces,
  })
  input.onApprovalCleanup(() => approvalService.close())
  const policyStore = createFilePolicyStore({ filePath: policyPath(config), workspace: config.cwd, lockDeadlineMs })
  const switchStore = createFileDangerouslyAllowStore({ filePath: dangerouslyAllowPath(config), workspace: config.cwd, lockDeadlineMs })
  const reporter = input.reporter ?? (config.reportUrl && config.reportToken
    ? createWebhookReporter({ url: config.reportUrl, token: config.reportToken, serverId: config.serverId, approvalKey: config.ringsApprovalKey })
    : nullReporter)
  const plugins = createPluginRegistry({
    filePath: pluginsPath(config),
    packOptions: { cwd: config.cwd, sandboxMode: sandbox.sandbox.mode },
    lockDeadlineMs,
  })

  const localSkills = [loadRootSkill(), ...await loadSkills(config.skillDirectories)]
  const listeners: Array<() => void> = []

  let compiled = compileStartupPolicy()
  let paths = createPathView({ root: config.cwd, mount: compiled.mount, scratchRoots: config.scratchRoots })
  // Read from the store at each evaluation; an unreadable store fails closed.
  const dangerouslyAllow = () => {
    let on = false
    try { on = switchStore.isOn() } catch { on = false }
    const allowedByNode = input.nodeDangerouslyAllowed ? input.nodeDangerouslyAllowed() : null
    return { on, allowedByNode, effective: on && allowedByNode !== false, boundTo: paths.displayRoot }
  }
  const dangerouslyAllowed = () => dangerouslyAllow().effective
  let permissions = buildPermissionEngine({ config, compiled, ceiling, paths, dangerouslyAllowed })
  let packs = await buildPacks({ config, sandbox, plugins, compiled, ceiling, paths, browserStateDirectory, history })
  let registry = createToolRegistry(availableTools(packs))

  let activeInvocations = 0
  const executionBudget = input.executionBudget ?? createExecutionBudget()
  const executions = createExecutions({ budget: executionBudget })
  // Every call running here, so shutdown can cancel them and wait for each to answer.
  const inFlight = new Set<Promise<unknown>>()
  const stopping = new AbortController()
  const workbenches = createWorkbenchManager({
    directory: workbenchesDirectory({ stateDirectory: config.stateDirectory, root: config.cwd }),
    sourceRoot: config.cwd, workspaceId, maxBytes: config.isolationMaxBytes,
    protectedRoots: protectedStateRoots(config), actions, history,
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
      const mounts = validateSandboxMounts(config.sandboxMounts ?? [], { protectedRoots: protectedStateRoots(config), workspaceRoots: [config.cwd, request.root], workspaceTarget: '/workspace' })
      const signal = AbortSignal.timeout(15_000)
      const projection = await projectFilesystemSandbox({ root: request.root, policy: compiled.policy, ceiling: ceiling?.policy, signal })
      const hidden = await collectShellHiddenPaths({ roots: [request.root, ...config.mountReadOnlyPaths], protectedPaths: [], signal })
      if (projection.hiddenPaths.some(path => isInside(path, request.cwd))) throw new WorkbenchError('Filesystem restrictions hide this terminal working directory', 403)
      const wrapped = sandbox.sandbox.wrap({ command: 'bash', args: ['--noprofile', '--norc', '-i'], cwd: request.cwd,
        workspaceRoot: request.root, writableRoots: [request.root], mount: { root: request.root, at: '/workspace' }, commandIsPid1: true,
        allowNetwork: config.shellNetwork && !policies.some(policy => policy.network.allow.length) && config.allowedHosts.length === 0,
        hiddenPaths: [...hidden.directories, ...projection.hiddenPaths], hiddenFiles: [...hidden.files, ...projection.hiddenFiles],
        mounts, readOnlyPaths: config.mountReadOnlyPaths, readOnlyWorkspacePaths: projection.readOnlyWorkspacePaths,
      })
      const environment = Object.fromEntries(Object.entries(buildChildEnvironment({ parent: process.env, extra: { TERM: 'xterm-256color' } })).filter((entry): entry is [string, string] => entry[1] !== undefined))
      return { ...wrapped, cwd: request.cwd, environment, cols: request.cols, rows: request.rows }
    },
  })

  const runtime: BuckleRuntime = {
    workspaceId,
    workbenches,
    auditHealth,
    executionBudget,
    hasActiveWork: async () => activeInvocations > 0 || await workbenches.hasActiveWork() || runtime.shellWorkspaces.list().some(item => item.status !== 'published'),
    inspectActiveWork: () => activeInvocations > 0 || workbenches.inspectActive() || runtime.shellWorkspaces.list().some(item => item.status !== 'published'),
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
    approvalService,
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
      network: () => ({ rule: networkEgressRule(compiled, ceiling), approved: approvedUrls(compiled, ceiling) }),
      revision: () => policyRevision(policyStore.read()),
      async apply(policy, expectedRevision) {
        if (await runtime.hasActiveWork()) throw new PolicyConflictError('Resolve active work and staged changes before changing workspace policy')
        compileEffective(policy)
        await policyStore.write({ ...policy, updatedAt: new Date().toISOString() }, expectedRevision)
        await runtime.reload()
        return compiled.policy
      },
      async clear(expectedRevision) {
        if (await runtime.hasActiveWork()) throw new PolicyConflictError('Resolve active work and staged changes before changing workspace policy')
        await policyStore.update(() => null, expectedRevision)
        await runtime.reload()
        return compiled.policy
      },
      dangerouslyAllow,
      async setDangerouslyAllow(on) {
        // No active-work check and no reload: turning it off must apply at once, and the rules read it per call.
        await auditOperation({
          actions, workspaceId, tool: 'policy_dangerously_allow_changed', sessionId: 'local-owner', describe: () => (on ? 'on' : 'off'),
          operation: () => switchStore.set(on),
        })
        logger.warn(on ? 'Dangerously allow is on: every ask in this workspace is allowed without a person, and each use is audited' : 'Dangerously allow is off', { workspaceId })
      },
    },

    async invoke(call) {
      activeInvocations++
      const running = createInvoker({
        registry,
        permissions,
        approvals,
        approvalService,
        executions,
        grants,
        actions,
        history,
        historyRoots: [realpathSync(config.cwd), ...config.scratchRoots.map(root => { let existing = root; while (!existsSync(existing)) existing = dirname(existing); return realpathSync(existing) })],
        reporter,
        paths,
        serverId: config.serverId,
        workspaceId,
        defaultTimeoutMs: config.defaultTimeoutMs,
        maxTimeoutMs: config.maxTimeoutMs,
        toolDenial,
        shutdown: stopping.signal,
      }).invoke(call)
      inFlight.add(running)
      try { return await running } finally {
        inFlight.delete(running)
        activeInvocations--
      }
    },

    async cancelInvocations() {
      stopping.abort(new InvocationsClosedError())
      await Promise.allSettled([...inFlight])
    },

    async closeSessions() {
      const results = await Promise.allSettled(packs.map(async pack => pack.close?.()))
      for (const result of results) if (result.status === 'rejected') logger.warn('A pack could not close what it opened', { error: result.reason })
    },

    async reload() {
      await workbenches.policyChanged()
      compiled = compileEffective()
      paths = createPathView({ root: config.cwd, mount: compiled.mount, scratchRoots: config.scratchRoots })
      permissions = buildPermissionEngine({ config, compiled, ceiling, paths, dangerouslyAllowed })
      packs = await buildPacks({ config, sandbox, plugins, compiled, ceiling, paths, browserStateDirectory, history })
      registry = createToolRegistry(availableTools(packs))
      for (const listener of listeners) listener()
    },

    onToolsChanged: listener => void listeners.push(listener),
  }

  // Blames the stored policy only when the environment's share loads on its own.
  function compileStartupPolicy(): CompiledPolicy {
    try {
      return compileEffective()
    } catch (error) {
      const stored = policyStore.read()
      if (!(error instanceof PolicyError) || !stored || !compilesAlone(config.policy)) throw error
      throw new StoredPolicyError({ file: policyPath(config), reason: error.message, stored, environment: config.policy })
    }
  }

  function compileEffective(stored = policyStore.read()): CompiledPolicy {
    const policy = ceiling
      ? { ...(stored ?? config.policy), mount: config.policy.mount }
      : mergePolicies(config.policy, stored)
    return compilePolicy(policy)
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
    hiddenPaths: protectedStateRoots(input.config),
    mountReadOnlyPaths: input.config.mountReadOnlyPaths,
    sandboxMounts: input.config.sandboxMounts,
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
    maxTimeoutMs: input.config.maxTimeoutMs,
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

function compilesAlone(policy: WorkspacePolicy): boolean {
  try {
    compilePolicy(policy)
    return true
  } catch {
    return false
  }
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
function buildPermissionEngine(input: { config: BuckleConfig; compiled: CompiledPolicy; ceiling: CompiledPolicy | null; paths: PathView; dangerouslyAllowed: () => boolean }): PermissionEngine {
  const { config, compiled, ceiling, paths } = input
  return withDangerouslyAllow(createPermissionEngine([
    createSensitivePathRule({ protectedRoots: protectedStateRoots(config) }),
    ...(ceiling ? [createCommandPolicyRule(ceiling, { enforceWrapperAllow: false, source: 'node ceiling' })] : []),
    createCommandPolicyRule(compiled, { enforceWrapperAllow: !ceiling?.commands.allow.length }),
    createDestructiveCommandRule({ added: [...(ceiling?.commands.destructive ?? []), ...compiled.commands.destructive] }),
    networkEgressRule(compiled, ceiling),
    createProcessProbeRule(),
    createFilesystemPolicyRule({ root: config.cwd, policy: compiled.policy, ceiling: ceiling?.policy }),
    createReadScopeRule({ paths }),
    createWriteScopeRule({ paths, strict: config.strictWrites, pathDecision: path => filesystemPathDecision({ root: config.cwd, path, operation: 'write', policy: compiled.policy, ceiling: ceiling?.policy }) }),
  ]), { enabled: input.dangerouslyAllowed, root: () => paths.root })
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
