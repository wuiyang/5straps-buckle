import { validateSandboxMounts } from '../../domain/sandbox-mounts.js'
import { protectedStateRoots } from '../../runtime/config.js'
import { createWorkbenchManager } from '../workbench/manager.js'
import { WorkbenchError, workbenchesDirectory, workbenchHash } from '../workbench/storage.js'
import { spawnPtyProcess } from '../../adapters/pty-process.js'
import { buildChildEnvironment, hostEnvironment } from '../../domain/environment.js'
import { resolveProgram, programOrNull, type UntrustedRoots } from '../../domain/executable.js'
import { isInside, nativePath, parentDirectory } from '../../domain/paths.js'
import { collectShellHiddenPaths } from '../shell/shell-filesystem.js'
import { createFilesystemPolicyRule, filesystemPathDecision, projectFilesystemSandbox, resolveFilesystemPermission } from '../../domain/filesystem-policy.js'
import { createShellWorkspaceRecovery } from '../shell/isolated-shell.js'
import { join } from 'pathe'
import { existsSync, realpathSync } from 'node:fs'
import { openChangeHistory, type ChangeHistory } from '../history/journal.js'
import { mkdirSync } from 'node:fs'
import { arch, hostname, platform } from 'node:os'
import { PROTOCOL_VERSION, emptyWorkspacePolicy, isWorkspaceToolAllowed, type HarnessManifest, type InvokeResponse, type WorkspacePolicy, type ToolCapability } from '@5straps/protocol'
import { createFileActionLog } from '../../adapters/action-log/file-action-log.js'
import { createPluginRegistry, type PluginRegistry } from '../../adapters/plugin-registry.js'
import { createFileGrantStore } from '../../adapters/grant-store/file-grant-store.js'
import { runProcess } from '../../adapters/process-runner.js'
import { createWebhookReporter } from '../../adapters/report/webhook-reporter.js'
import { resolveSandbox, type SandboxResolution } from '../../adapters/sandbox/create-sandbox.js'
import { actionsPath, approvalNoncesPath, approvalsPath, dangerouslyAllowPath, grantsPath, NODE_FOLDER_WORKSPACE, pluginsPath, type BuckleConfig } from '../../runtime/config.js'
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
import { compilePolicy, policyRevision, PolicyConflictError, PolicyError, StoredPolicyError, type CompiledPolicy } from '../../domain/policy.js'
import { withDangerouslyAllow } from '../../domain/permission/rules/dangerously-allow.js'
import { loadSkills } from '../../domain/skill-registry.js'
import { toDescriptor, type LoadedSkill } from '../../domain/skill.js'
import { createToolRegistry, type ToolRegistry } from '../../domain/tool-registry.js'
import type { UrlMatcher } from '../../domain/url-pattern.js'
import type { PermissionRule } from '../../domain/permission/decision.js'
import { workspaceStateKey } from '../../domain/workspace-key.js'
import { createBuiltinPacks, unmetPackPrerequisite } from '../packs/index.js'
import { journalDirectory, scriptOfAsk } from '../packs/code/journal.js'
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
import { workspaceUntrusted, type NodeRoots } from './node-roots.js'
import { openSettingsFile, settingsPath, scopeOf, withPolicy, WorkspaceSettingsSchema, type WorkspaceSettings } from './workspace-settings.js'

/**
 * The workspace's policy as the runtime holds it: one document, in its workspace.json, which `buckle policy` and the
 * setup face write (D83 addendum (7)); no node policy sits over it (Q14). `mount` is where its mount table shows the
 * folder. The dangerously-allow switch is stored apart and never touches it (review H1 of B20-B22).
 */
export interface PolicyHandle {
  /** The policy as workspace.json holds it, read now. */
  stored(): WorkspacePolicy
  effective(): WorkspacePolicy
  /** A fresh egress rule and approved list, built by the same construction the engine and packs use, for `buckle check-url`. */
  network(): { rule: PermissionRule; approved: UrlMatcher | null }
  revision(): string
  /**
   * Validates, stores, and rebuilds the rules and packs. Where the folder shows is not the policy's to change: `mount`
   * keeps the mount table's, which `setMount` alone changes, from the owner's CLI. Throws PolicyError.
   */
  apply(policy: WorkspacePolicy, expectedRevision?: string): Promise<WorkspacePolicy>
  /** Empties every list, keeping where the folder shows. The switch is left as it is. */
  clear(expectedRevision?: string): Promise<WorkspacePolicy>
  /** Where the agent sees the folder; null shows the real path. The owner's `buckle policy mount|unmount` alone calls it. */
  setMount(mount: string | null): Promise<WorkspacePolicy>
  /**
   * The dangerously-allow switch as stored now, read from the store at every call, so the local switch applies in a
   * running node at once: `on`, and the root it is bound to, as the agent names it (owner decision D7). It needs no
   * node switch beside it (Q14).
   */
  dangerouslyAllow(): { on: boolean; boundTo: string }
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
  /** The code mode script that stopped at the ask `token`, kept with its journal for the approver; null when none is (owner decision D82). */
  scriptOfAsk(token: string): string | null
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
  /** For a registered workspace: whether it serves calls now (enabled, not retired); its log's failures count toward readiness only then. */
  serving?: () => boolean
  /** Every root the node knows, where no program run here may come from (NodeRoots); this workspace's own alone when absent. */
  nodeRoots?: NodeRoots
}

export async function createRuntime(input: RuntimeInput): Promise<BuckleRuntime> {
  const { config } = input
  // The sandbox masks this directory by path, so it has to exist before the first command runs.
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 })
  const history = await openChangeHistory({ directory: join(config.stateDirectory, 'history', workspaceStateKey(config.cwd)), excluded: protectedStateRoots(config), maxBytes: config.historyMaxBytes, retentionDays: config.historyRetentionDays, label: `history:${input.workspaceId ?? NODE_FOLDER_WORKSPACE}` })
  let closeApprovals: (() => Promise<void>) | undefined
  try {
    return await assembleRuntime({ ...input, history, onApprovalCleanup: close => { closeApprovals = close } })
  } catch (error) {
    // No close step owns the connection until the runtime exists (runtime.md: clean up after partial initialization).
    try { await closeApprovals?.() } finally { await history.close() }
    throw error
  }
}

async function assembleRuntime(input: RuntimeInput & { history: ChangeHistory; onApprovalCleanup: (close: () => Promise<void>) => void }): Promise<BuckleRuntime> {
  const { config, history } = input
  const browserStateDirectory = join(config.stateDirectory, 'browser-sessions', workspaceStateKey(config.cwd))
  mkdirSync(browserStateDirectory, { recursive: true })

  // Where no program run here may come from: this workspace's roots and every root the node knows, read at each resolution.
  const untrusted = (): UntrustedRoots => workspaceUntrusted({ root: config.cwd, scratchRoots: config.scratchRoots }, input.nodeRoots)
  // The sandbox program is refused where an agent writes, as every other program Buckle runs is.
  const sandbox = resolveSandbox({
    requested: config.sandboxMode,
    acknowledgedUnsandboxed: config.acknowledgedUnsandboxed,
    ...untrusted(),
  })

  const lockDeadlineMs = config.stateLockDeadlineMs
  const workspaceId = input.workspaceId ?? NODE_FOLDER_WORKSPACE
  // Keyed by the workspace's id, so they stay its own whatever its folder is called.
  const grants = createFileGrantStore({ filePath: grantsPath(config), workspace: workspaceId, lockDeadlineMs })
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
  const actions = createFileActionLog(actionsPath(config), { lockDeadlineMs, health: auditHealth, workspaceId, ...(input.serving ? { serving: input.serving } : {}) })
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
  // The settings `buckle workspace` writes; until one does, the ones this runtime was built from.
  const settingsFile = openSettingsFile({ filePath: settingsPath(config.nodeStateDirectory ?? config.stateDirectory, workspaceId), fallback: () => settingsOf(config), lockDeadlineMs })
  const switchStore = createFileDangerouslyAllowStore({ filePath: dangerouslyAllowPath(config), workspace: workspaceId, lockDeadlineMs })
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
    return { on, boundTo: paths.displayRoot }
  }
  const dangerouslyAllowed = () => dangerouslyAllow().on
  let permissions = buildPermissionEngine({ config, compiled, paths, dangerouslyAllowed })
  // What a code mode script reaches: this workspace's manifest as it stands at each call, after tool policy (owner
  // decision D82, point 3), and never another workspace's (BUCKLE-D07: a token opens one workspace).
  const manifestTools = (): ToolCapability[] => registry.capabilities().filter(tool => toolDenial(tool.name) === null)
  let packs = await buildPacks({ config, sandbox, plugins, compiled, paths, browserStateDirectory, history, untrusted, reachableTools: manifestTools })
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
    ripgrep: () => programOrNull(resolveProgram('rg', untrusted())), environment: hostEnvironment(untrusted), spawnPty: spawnPtyProcess,
    policyHash: () => workbenchHash(JSON.stringify(compiled.policy)),
    authorizeTool: tool => toolDenial(tool) === null,
    authorizePath: (path, operation) => !['deny', 'ask'].includes(resolveFilesystemPermission({ path, operation, policy: compiled.policy })),
    async prepareTerminal(request) {
      const denial = toolDenial('shell_exec')
      if (denial) throw new WorkbenchError(denial, 403)
      if (!config.enableShell || config.enabledPacks && !config.enabledPacks.includes('shell') || sandbox.sandbox.mode !== 'bubblewrap') throw new WorkbenchError('Interactive terminals require an enabled bubblewrap sandbox', 403)
      const { commands } = compiled.policy
      if (commands.allow.length || commands.deny.length || commands.destructive?.length) throw new WorkbenchError('Interactive shells cannot enforce command allowlists, denylists or command approval rules', 403)
      const mounts = validateSandboxMounts(config.sandboxMounts ?? [], { protectedRoots: protectedStateRoots(config), workspaceRoots: [config.cwd, request.root], workspaceTarget: '/workspace' })
      const signal = AbortSignal.timeout(15_000)
      const projection = await projectFilesystemSandbox({ root: request.root, policy: compiled.policy, signal })
      const hidden = await collectShellHiddenPaths({ roots: [request.root, ...config.mountReadOnlyPaths], protectedPaths: [], signal })
      if (projection.hiddenPaths.some(path => isInside(path, request.cwd))) throw new WorkbenchError('Filesystem restrictions hide this terminal working directory', 403)
      const wrapped = sandbox.sandbox.wrap({ command: 'bash', args: ['--noprofile', '--norc', '-i'], cwd: request.cwd,
        workspaceRoot: request.root, writableRoots: [request.root], mount: { root: request.root, at: '/workspace' }, commandIsPid1: true,
        allowNetwork: config.shellNetwork && !compiled.policy.network.allow.length && config.allowedHosts.length === 0,
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
    manifest: () => ({ ...buildManifest({ config, packs, registry, sandbox, paths, skills: allSkills() }), tools: manifestTools() }),
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
      stored: () => storedPolicy(settingsFile.read()),
      effective: () => compiled.policy,
      network: () => ({ rule: networkEgressRule(compiled), approved: compiled.network }),
      revision: () => policyRevision(storedPolicy(settingsFile.read())),
      async apply(policy, expectedRevision) {
        if (await runtime.hasActiveWork()) throw new PolicyConflictError('Resolve active work and staged changes before changing workspace policy')
        compilePolicy(policy)
        await writePolicy(current => ({ ...policy, mount: current.mount, updatedAt: new Date().toISOString() }), expectedRevision)
        await runtime.reload()
        return compiled.policy
      },
      async setMount(mount) {
        if (await runtime.hasActiveWork()) throw new PolicyConflictError('Resolve active work and staged changes before changing workspace policy')
        await writePolicy(current => compilePolicy({ ...current, mount, updatedAt: new Date().toISOString() }).policy)
        await runtime.reload()
        return compiled.policy
      },
      async clear(expectedRevision) {
        if (await runtime.hasActiveWork()) throw new PolicyConflictError('Resolve active work and staged changes before changing workspace policy')
        await writePolicy(current => ({ ...emptyWorkspacePolicy(), mount: current.mount, updatedAt: new Date().toISOString() }), expectedRevision)
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

    scriptOfAsk: token => scriptOfAsk(journalDirectory({ stateDirectory: config.stateDirectory, cwd: config.cwd }), token),

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
        historyRoots: [nativePath(realpathSync(config.cwd)), ...config.scratchRoots.map(root => { let existing = root; while (!existsSync(existing) && parentDirectory(existing) !== existing) existing = parentDirectory(existing); return nativePath(realpathSync(existing)) })],
        reporter,
        paths,
        serverId: config.serverId,
        workspaceId,
        defaultTimeoutMs: config.defaultTimeoutMs,
        maxTimeoutMs: config.maxTimeoutMs,
        toolDenial,
        shutdown: stopping.signal,
        // A script's calls run here too, so they are counted, cancelled at shutdown, and kept to this workspace.
        nested: nestedCall => runtime.invoke(nestedCall),
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
      permissions = buildPermissionEngine({ config, compiled, paths, dangerouslyAllowed })
      packs = await buildPacks({ config, sandbox, plugins, compiled, paths, browserStateDirectory, history, untrusted, reachableTools: manifestTools })
      registry = createToolRegistry(availableTools(packs))
      for (const listener of listeners) listener()
    },

    onToolsChanged: listener => void listeners.push(listener),
  }

  // A stored entry a later grammar refuses names the file and the repair (StoredPolicyError).
  function compileStartupPolicy(): CompiledPolicy {
    try {
      return compileEffective()
    } catch (error) {
      if (!(error instanceof PolicyError)) throw error
      throw new StoredPolicyError({ file: settingsFile.filePath, reason: error.message, stored: storedPolicy(settingsFile.read()) })
    }
  }

  function compileEffective(): CompiledPolicy {
    return compilePolicy(storedPolicy(settingsFile.read()))
  }

  /** The policy write path: through workspace.json, refused when the policy changed since `expectedRevision`. */
  async function writePolicy(change: (current: WorkspacePolicy) => WorkspacePolicy, expectedRevision?: string): Promise<void> {
    await settingsFile.update((current) => {
      const policy = storedPolicy(current)
      if (expectedRevision !== undefined && policyRevision(policy) !== expectedRevision) throw new PolicyConflictError('Workspace policy changed; reload before saving')
      return withPolicy(current, change(policy))
    })
  }

  function allSkills(): LoadedSkill[] {
    return [...availableSkills(packs), ...localSkills]
  }

  function toolDenial(tool: string): string | null {
    return isWorkspaceToolAllowed(compiled.policy, tool) ? null : 'Disabled by workspace tool policy'
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
  untrusted: () => UntrustedRoots
  reachableTools: () => ToolCapability[]
}): Promise<Pack[]> {
  const builtin = createBuiltinPacks({
    cwd: input.config.cwd,
    paths: input.paths,
    untrusted: input.untrusted,
    runProcess,
    sandbox: input.sandbox.sandbox,
    sandboxUnavailableReason: input.sandbox.unavailableReason,
    writableRoots: [input.config.cwd, ...input.config.scratchRoots],
    hiddenPaths: protectedStateRoots(input.config),
    mountReadOnlyPaths: input.config.mountReadOnlyPaths,
    sandboxMounts: input.config.sandboxMounts,
    approvedUrls: input.compiled.network,
    approvedLists: input.compiled.network ? [{ name: 'workspace' as const, entries: input.compiled.network.patterns }] : [],
    braveSearchApiKey: input.config.braveSearchApiKey,
    forge: { token: input.config.forgeGithubToken, apiUrl: input.config.forgeApiUrl, author: input.config.forgeGitAuthor },
    stateDirectory: input.config.stateDirectory,
    allowedHosts: input.config.allowedHosts,
    agentBrowserCommand: input.config.agentBrowserCommand,
    browserStateDirectory: input.browserStateDirectory,
    maxTimeoutMs: input.config.maxTimeoutMs,
    browserHeaded: input.config.browserHeaded,
    browserCdp: input.config.browserCdp,
    browserProfile: input.config.browserProfile,
    browserArgs: input.config.browserArgs,
    enableShell: input.config.enableShell,
    allowCode: input.config.allowCode,
    reachableTools: input.reachableTools,
    maxRequestBytes: input.config.maxRequestBytes,
    allowHostGit: input.config.allowHostGit,
    allowHostLsp: input.config.allowHostLsp,
    shellNetwork: input.config.shellNetwork,
    filesystemPolicy: { policy: input.compiled.policy },
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
    return builtin.filter(pack => selected.includes(pack.id))
  }
  const filesystemRestricted = Boolean(input.compiled.policy.filesystem?.rules.length)
  return [...builtin, ...(filesystemRestricted ? [] : await input.plugins.load())]
}

/** The policy a workspace.json holds, with its mount table's target as `mount`. */
function storedPolicy(settings: WorkspaceSettings): WorkspacePolicy {
  return { ...settings.policy, mount: scopeOf(settings).mount }
}

/** The settings a runtime built without a workspace.json stands on: those its configuration was composed from. */
function settingsOf(config: BuckleConfig): WorkspaceSettings {
  return WorkspaceSettingsSchema.parse({
    ...withPolicy(WorkspaceSettingsSchema.parse({ version: 1 }), config.policy),
    packs: { enabled: config.enabledPacks ?? null, shell: config.enableShell, code: config.allowCode, hostGit: config.allowHostGit, hostLsp: config.allowHostLsp },
    browser: { ...(config.browserCdp ? { cdp: config.browserCdp } : {}), ...(config.browserProfile ? { profile: config.browserProfile } : {}), ...(config.browserArgs ? { args: config.browserArgs } : {}), headed: config.browserHeaded },
    approvalWaitMs: config.approvalTimeoutMs ?? 0,
  })
}

/** One construction for the engine and `buckle check-url`, so the check cannot drift from the rule. */
function networkEgressRule(compiled: CompiledPolicy): PermissionRule {
  return createNetworkEgressRule({ approved: compiled.network })
}

/**
 * Order is the security model: floor rules run before scope rules, so a granted directory
 * can never unlock a credential file or a destructive command inside it. The owner's command
 * policy sits first among the floors, because its answer is a denial rather than a question.
 */
function buildPermissionEngine(input: { config: BuckleConfig; compiled: CompiledPolicy; paths: PathView; dangerouslyAllowed: () => boolean }): PermissionEngine {
  const { config, compiled, paths } = input
  return withDangerouslyAllow(createPermissionEngine([
    createSensitivePathRule({ protectedRoots: protectedStateRoots(config) }),
    createCommandPolicyRule(compiled),
    createDestructiveCommandRule({ added: compiled.commands.destructive, allowedInterpreters: compiled.commands.allowedInterpreters }),
    networkEgressRule(compiled),
    createProcessProbeRule(),
    createFilesystemPolicyRule({ root: config.cwd, policy: compiled.policy }),
    createReadScopeRule({ paths }),
    createWriteScopeRule({ paths, strict: config.strictWrites, pathDecision: path => filesystemPathDecision({ root: config.cwd, path, operation: 'write', policy: compiled.policy }) }),
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
