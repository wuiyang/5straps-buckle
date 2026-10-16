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
import { dirname, join } from 'pathe'
import { existsSync, realpathSync, watch, type FSWatcher } from 'node:fs'
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
import { actionsPath, approvalNoncesPath, approvalsPath, dangerouslyAllowPath, grantsPath, pluginsPath, workspaceFields, type BuckleConfig } from '../../runtime/config.js'
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
import { allowedDomainsKey, browserAllowedDomains } from '../packs/browser/allowed-domains.js'
import { FRESH_BROWSER, modeFingerprint, type BrowserMode } from '../packs/browser/mode.js'
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
import { openSettingsFile, ownMount, policySources, resolveSettings, settingsPath, scopeOf, withMount, withPolicy, WorkspaceSettingsSchema, type PolicySources, type ResolvedSettings, type WorkspaceSettings } from './workspace-settings.js'
import { WorkspaceError } from './registry.js'
import { activeWorkDirectory, createActiveWorkMark } from './active-work.js'

const TOOL_DISABLED = 'Disabled by workspace tool policy'

/** What a call runs under, captured as it starts. */
interface InForce {
  registry: ToolRegistry
  permissions: PermissionEngine
  paths: PathView
  toolDenial(tool: string): string | null
}

/** Said where a change that rebuilds the tools waits for active work: no path, as an agent reads it (Q2). */
const RESHAPE_WAITS = 'This workspace\'s settings changed in a way that rebuilds its tools; the change takes effect once its active work is resolved, so call again then'

/** Said where a change read but would not apply: the call is refused, never answered under the old settings (fix brief 4, finding 1). No path. */
const SETTINGS_RETRY = 'This workspace\'s settings changed and could not be taken up yet; retry the call, and if it keeps failing, the owner\'s log says why'

/** Said where the owner's mount change meets work in progress, wherever it runs: a mount reshapes the tools. */
const POLICY_WAITS = 'Resolve active work and staged changes before changing workspace policy'

/** Said where a policy write meets an open workbench: taking the new policy up would stop its terminals. */
const POLICY_WAITS_FOR_WORKBENCH = 'Close the open workbenches of this workspace before changing its policy'

/**
 * The workspace's policy as the runtime holds it: its own lists, in its workspace.json, which `buckle policy` and the
 * setup face write (D83 addendum (7)), and the policy in force, where the node's allow-type lists stand for a list it
 * has not got and the node's deny-type lists are a floor over its own (D85, Q14; resolveSettings). `mount` is where its
 * mount table shows the folder. The dangerously-allow switch is stored apart and never touches it (review H1 of B20-B22).
 */
export interface PolicyHandle {
  /** The workspace's own lists, as workspace.json holds them, read now. */
  stored(): WorkspacePolicy
  /** The policy in force: its own lists, else the node's, with the node's deny-type lists over them. */
  effective(): WorkspacePolicy
  /** Where each part of the policy in force comes from: the workspace's own, the node's default, or Buckle's (D85, Q3). */
  sources(): PolicySources
  /** A fresh egress rule and approved list, built by the same construction the engine and packs use, for `buckle check-url`. */
  network(): { rule: PermissionRule; approved: UrlMatcher | null }
  revision(): string
  /**
   * Validates, stores, and rebuilds the rules and packs. Where the folder shows is not the policy's to change: `mount`
   * keeps the mount table's, which `setMount` alone changes, from the owner's CLI. Throws PolicyError.
   */
  apply(policy: WorkspacePolicy, expectedRevision?: string): Promise<WorkspacePolicy>
  /** Empties every list of its own, so the node's apply, keeping where the folder shows. The switch is left as it is. */
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
  /** The workspace's name as the registry holds it now. */
  workspaceName(): string
  /** Takes up a write to workspace.json now, as the next call would (Q2); `buckle serve` calls it when the settings change. */
  takeUpSettings(): Promise<void>
  workbenches: ReturnType<typeof createWorkbenchManager>
  /** Work this process would disrupt: its calls running, the workbenches it holds still open, and shell work staged for review. */
  hasActiveWork(): Promise<boolean>
  /**
   * Work wherever it runs, read without taking workbench ownership (review L4 of B15-B17): an open workbench another
   * process holds counts here too.
   */
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
  /** Shutdown's watcher step: closes the settings-folder watcher (Q2). Idempotent. */
  closeWatchers(): void
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
  /** Whether the workspace serves calls now (online); a call to it is refused otherwise, and its log's failures count toward readiness only then. */
  serving?: () => boolean
  /** Every root the node knows, where no program run here may come from (NodeRoots); this workspace's own alone when absent. */
  nodeRoots?: NodeRoots
}

/** The settings watcher's debounce (Q2): a change is taken up this long after the last write, within the 100 to 250 ms the brief allows. */
export const SETTINGS_WATCH_DEBOUNCE_MS = 150

export async function createRuntime(input: RuntimeInput): Promise<BuckleRuntime> {
  const { config } = input
  // The sandbox masks this directory by path, so it has to exist before the first command runs.
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 })
  const history = await openChangeHistory({ directory: join(config.stateDirectory, 'history', workspaceStateKey(config.cwd)), excluded: protectedStateRoots(config), maxBytes: config.historyMaxBytes, retentionDays: config.historyRetentionDays, label: `history:${input.workspaceId ?? config.workspaceId}` })
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
  const workspaceId = input.workspaceId ?? config.workspaceId
  // Keyed by the workspace's id, so they stay its own whatever its folder is called.
  const grants = createFileGrantStore({ filePath: grantsPath(config), workspace: workspaceId, lockDeadlineMs })
  // Every notification names its workspace, whose `buckle approve --workspace` answers it, by id and by its name as it
  // stands at each post, so a rename shows.
  const webhook = config.approvalWebhook ? { url: config.approvalWebhook, serverId: config.serverId, workspaceId, get workspaceName() { return config.serverName }, token: config.reportToken, approvalKey: config.ringsApprovalKey } : null
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
  // Each entry carries the workspace's name as it stands, beside its id (D85, Q15).
  const actions = createFileActionLog(actionsPath(config), { lockDeadlineMs, health: auditHealth, workspaceId, workspaceName: () => config.serverName, ...(input.serving ? { serving: input.serving } : {}) })
  await actions.recoverInterrupted()
  // Replay protection for sealed decisions from Rings: on disk once a key is paired.
  const approvalNonces = config.ringsApprovalKey ? await openFileNonceStore({ filePath: approvalNoncesPath(config) }) : createMemoryNonceClaims()
  const approvalService = createApprovalService({
    registry: approvals, workspaceId, serverId: config.serverId,
    // Read at each ask, so a change to approvalWaitMs applies from the next call (Q2), and a rename shows at once.
    get graceMs() { return config.approvalTimeoutMs },
    get workspaceName() { return config.serverName },
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
  // What this runtime last took up from workspace.json, and the file's version then, read first so a write landing
  // meanwhile is seen at the next call (Q2: a stat per call, no watcher).
  let appliedVersion = settingsFile.version()
  let applied = settingsFile.read()
  // A version that would not read, so it is reported once and the settings in force stay.
  let unreadVersion: string | undefined
  // A version that read but would not apply, reported once; unlike one that would not read, it is tried again.
  let failedVersion: string | undefined
  let pickingUp: Promise<void> | undefined

  let compiled = compileStartupPolicy(applied)
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
  /** Packs a rebuild replaced while calls ran on them, closed when the last of those calls ends. */
  const retiring: Pack[] = []
  // Marked on disk while any call runs, so `buckle workspace disable` and `remove` in another process see it (finding 9).
  const activity = createActiveWorkMark({ directory: activeWorkDirectory(config.nodeStateDirectory ?? config.stateDirectory, workspaceId), workspaceId })
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
    policyHash: () => policyHash(compiled),
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
    workspaceName: () => config.serverName,
    takeUpSettings: () => pickUp(),
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
      sources: () => policySources(applied, config.workspaceDefaults),
      network: () => ({ rule: networkEgressRule(compiled), approved: compiled.network }),
      revision: () => policyRevision(storedPolicy(settingsFile.read())),
      async apply(policy, expectedRevision) {
        compilePolicy(policy)
        await writePolicy(current => ({ ...policy, mount: current.mount, updatedAt: new Date().toISOString() }), expectedRevision)
        await runtime.reload()
        return compiled.policy
      },
      async setMount(mount) {
        refuseWhileWorking()
        compilePolicy({ ...emptyWorkspacePolicy(), mount })
        await settingsFile.update(current => withMount(current, mount))
        await runtime.reload()
        return compiled.policy
      },
      async clear(expectedRevision) {
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
      if (input.serving && !input.serving()) throw new WorkspaceError('Workspace is offline', 409)
      await pickUp()
      return invokeNow(call, inForce())
    },

    async cancelInvocations() {
      stopping.abort(new InvocationsClosedError())
      await Promise.allSettled([...inFlight])
    },

    closeSessions: () => closePacks([...packs, ...retiring.splice(0)]),

    /** The owner's own write (a policy, a plugin): every pack rebuilt from workspace.json as it stands, with no wait. */
    async reload() {
      const version = settingsFile.version()
      await apply({ version, settings: settingsFile.read(), rebuildPacks: true, waitForWork: false })
    },

    onToolsChanged: listener => void listeners.push(listener),
    closeWatchers: () => { watcherClosed = true; if (watcherPending) clearTimeout(watcherPending); watcherPending = undefined; settingsWatcher?.close(); settingsWatcher = undefined },
  }

  // Q2: a watcher on the settings folder takes a change up at once when the workspace is idle; the per-call pickUp is the
  // fallback, so a watcher that cannot start (unsupported, EMFILE) is logged once and nothing else changes.
  let settingsWatcher: FSWatcher | undefined
  let watcherPending: ReturnType<typeof setTimeout> | undefined
  let watcherClosed = false
  try {
    settingsWatcher = watch(dirname(settingsFile.filePath), { persistent: false }, () => {
      if (watcherPending || watcherClosed) return
      watcherPending = setTimeout(() => {
        watcherPending = undefined
        // The runtime may have closed (its state folder gone) between the write and this timer, so the read is guarded.
        try {
          // A refusal (a change waiting for work, or one that will not apply) is the next call's to answer, and takeUp logs the latter.
          if (!watcherClosed && settingsFile.version() !== appliedVersion && !runtime.inspectActiveWork()) void pickUp().catch((error: unknown) => { if (!(error instanceof WorkspaceError)) logger.error('A settings change could not be taken up; the per-call check will retry it', { workspaceId, error }) })
        } catch (error) {
          logger.warn('The workspace settings watcher could not read the change; the per-call check carries on', { workspaceId, error })
        }
      }, SETTINGS_WATCH_DEBOUNCE_MS)
      watcherPending.unref?.()
    })
    settingsWatcher.on('error', (error: unknown) => logger.warn('The workspace settings watcher stopped; the per-call check carries on', { workspaceId, error }))
  } catch (error) {
    logger.warn('The workspace settings watcher could not start; the per-call check carries on', { workspaceId, error })
  }

  /**
   * Takes up a write to workspace.json at a call's start (Q2 of the workspace-model brief): the change applies from
   * this call on (apply), and a call already running keeps the rules and tools it started with. A file that will not
   * read leaves the settings in force, said once in the owner's log. One that reads but will not apply refuses the
   * call until it does, so no call is answered under settings the owner has replaced (fix brief 4, finding 1).
   */
  function pickUp(): Promise<void> {
    if (settingsFile.version() === appliedVersion) return Promise.resolve()
    pickingUp ??= takeUp().finally(() => { pickingUp = undefined })
    return pickingUp
  }

  async function takeUp(): Promise<void> {
    const version = settingsFile.version()
    if (version === appliedVersion || version === unreadVersion) return
    let next: WorkspaceSettings
    try { next = settingsFile.read() } catch (error) {
      unreadVersion = version
      logger.error('Workspace settings changed but cannot be read; the ones in force stay', { workspaceId, error })
      return
    }
    try { await apply({ version, settings: next, rebuildPacks: false, waitForWork: true }) } catch (error) {
      if (error instanceof WorkspaceError) throw error
      // Nothing of it was applied (finding 28 of the Phase 1 review), and the next call tries again; until then a call
      // is refused, never answered under the settings the change replaced.
      if (failedVersion !== version) logger.error('Workspace settings changed but cannot be applied; calls are refused until they can be', { workspaceId, error })
      failedVersion = version
      throw new WorkspaceError(SETTINGS_RETRY, 409)
    }
    logger.info('Workspace settings changed and took effect', { workspaceId, revision: applied.revision })
  }

  /**
   * Applies settings whole or not at all (findings 7, 8, and 28 of the Phase 1 review, fix brief 1, D). The approval
   * wait and the variables swap in at once. The packs are rebuilt only where what they are built from changed (the
   * packs, the mounts, the policy, the browser settings, the variables), the browser pack only where its own inputs
   * did (fix brief 2, R2), and workbenches told only where the compiled policy changed; with `waitForWork`, either
   * waits until no work is active, refusing the call meanwhile. Everything is built before anything is assigned, so a
   * failure leaves the settings in force, and packs replaced are retired, so their language servers and browsers end
   * with them.
   */
  async function apply(input: { version: string; settings: WorkspaceSettings; rebuildPacks: boolean; waitForWork: boolean }): Promise<void> {
    const fields = workspaceFields(scopeOf(input.settings, config.workspaceDefaults))
    const nextConfig: BuckleConfig = { ...config, ...fields }
    const nextCompiled = compilePolicy(fields.policy)
    const nextPaths = createPathView({ root: config.cwd, mount: nextCompiled.mount, scratchRoots: config.scratchRoots })
    const [resolved, before] = [resolveSettings(input.settings, config.workspaceDefaults), resolveSettings(applied, config.workspaceDefaults)]
    // The packs, the mounts, or the browser settings changed: the tools themselves are reshaped, which waits until no
    // work is active. A policy list or a variable changed alone is swapped in for the next call without waiting (fix
    // brief 1, D, and its recheck): the packs holding a copy of it are rebuilt, and a call running keeps the ones it started on.
    const reshaped = reshapeInputs(resolved) !== reshapeInputs(before)
    const rebuild = input.rebuildPacks || reshaped || swapInputs(resolved) !== swapInputs(before)
    const policyMoved = policyHash(nextCompiled) !== policyHash(compiled)
    // Taking a new policy up stops the terminals of every open workbench this process holds, so that alone waits for
    // none of them to be open. A process holding no workbenches (another runs them) has none to wait for or stop.
    if (input.waitForWork && (reshaped ? await runtime.hasActiveWork() : policyMoved && await workbenches.hasActiveWork())) throw new WorkspaceError(RESHAPE_WAITS, 409)
    const nextPermissions = buildPermissionEngine({ config: nextConfig, compiled: nextCompiled, paths: nextPaths, dangerouslyAllowed })
    const built = rebuild ? await buildPacks({ config: nextConfig, sandbox, plugins, compiled: nextCompiled, paths: nextPaths, browserStateDirectory, history, untrusted, reachableTools: manifestTools }) : null
    const next = built ? carryPacks({ built, current: packs, carried: id => id === BROWSER_PACK && browserInputs({ config: nextConfig, compiled: nextCompiled, mount: resolved.mount }) === browserInputs({ config, compiled, mount: before.mount }) }) : null
    if (policyMoved) await workbenches.policyChanged()
    Object.assign(config, fields)
    applied = input.settings
    appliedVersion = input.version
    unreadVersion = undefined
    failedVersion = undefined
    compiled = nextCompiled
    paths = nextPaths
    permissions = nextPermissions
    if (next) {
      packs = next.packs
      registry = createToolRegistry(availableTools(packs))
      await retire(next.replaced)
    }
    for (const listener of listeners) listener()
  }

  /** The settings a call runs under: those in force as it starts, which a later pickup does not change for it. */
  function inForce(): InForce {
    const policy = compiled.policy
    return { registry, permissions, paths, toolDenial: tool => (isWorkspaceToolAllowed(policy, tool) ? null : TOOL_DISABLED) }
  }

  /**
   * One call, under the settings it started with. A code_run script's calls run under its own, captured as the
   * script started, however other calls take up a change meanwhile (finding 27 of the Phase 1 review).
   */
  async function invokeNow(call: InvokeInput, settled: InForce): Promise<InvokeResponse> {
    activeInvocations++
    try {
      if (activeInvocations === 1) activity.start()
      const running = createInvoker({
        registry: settled.registry,
        permissions: settled.permissions,
        approvals,
        approvalService,
        executions,
        grants,
        actions,
        history,
        historyRoots: [nativePath(realpathSync(config.cwd)), ...config.scratchRoots.map(root => { let existing = root; while (!existsSync(existing) && parentDirectory(existing) !== existing) existing = parentDirectory(existing); return nativePath(realpathSync(existing)) })],
        reporter,
        paths: settled.paths,
        serverId: config.serverId,
        workspaceId,
        defaultTimeoutMs: config.defaultTimeoutMs,
        maxTimeoutMs: config.maxTimeoutMs,
        toolDenial: settled.toolDenial,
        shutdown: stopping.signal,
        // A script's calls run here too, so they are counted, cancelled at shutdown, and kept to this workspace.
        nested: nestedCall => invokeNow(nestedCall, settled),
      }).invoke(call)
      inFlight.add(running)
      try { return await running } finally { inFlight.delete(running) }
    } finally {
      if (--activeInvocations === 0) {
        activity.stop()
        if (retiring.length > 0) void closePacks(retiring.splice(0), 'retire')
      }
    }
  }

  /** Packs replaced retire once no call still runs on them: a script started before keeps its own tools to its end. */
  async function retire(replaced: Pack[]): Promise<void> {
    if (activeInvocations === 0) await closePacks(replaced, 'retire')
    else retiring.push(...replaced)
  }

  /**
   * Each pack closes what it opened; one that fails to is logged, and the rest still close. A pack replaced by one
   * built from other settings retires instead, where it tells the two apart: what its successor carries on stays.
   */
  async function closePacks(closing: Pack[], step: 'close' | 'retire' = 'close'): Promise<void> {
    const results = await Promise.allSettled(closing.map(async pack => (step === 'retire' ? pack.retire ?? pack.close : pack.close)?.call(pack)))
    for (const result of results) if (result.status === 'rejected') logger.warn('A pack could not close what it opened', { error: result.reason })
  }

  // A stored entry a later grammar refuses names the file and the repair (StoredPolicyError).
  function compileStartupPolicy(settings: WorkspaceSettings): CompiledPolicy {
    try {
      return compilePolicy(workspaceFields(scopeOf(settings, config.workspaceDefaults)).policy)
    } catch (error) {
      if (!(error instanceof PolicyError)) throw error
      throw new StoredPolicyError({ file: settingsFile.filePath, reason: error.message, stored: storedPolicy(settings) })
    }
  }

  /**
   * The owner's mount change meets work in progress wherever it runs, read without taking the workbenches up: an open
   * workbench another process holds still counts, a closed one does not (fix brief 3, H8; fix brief 4, finding 1).
   */
  function refuseWhileWorking(): void {
    if (runtime.inspectActiveWork()) throw new PolicyConflictError(POLICY_WAITS)
  }

  /**
   * The policy write path: through workspace.json, refused when the policy changed since `expectedRevision`. A list
   * swaps in at the next call, so a shell result awaiting review, a call running, and a lock another process holds are
   * no reason to wait (fix brief 3, H14). Every write stamps the policy's updatedAt, which the compiled policy carries,
   * so it moves the compiled policy and stops the terminals of an open workbench; only that waits (fix brief 4,
   * finding 27).
   */
  async function writePolicy(change: (current: WorkspacePolicy) => WorkspacePolicy, expectedRevision?: string): Promise<void> {
    if (workbenches.inspectActive()) throw new PolicyConflictError(POLICY_WAITS_FOR_WORKBENCH)
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
    return isWorkspaceToolAllowed(compiled.policy, tool) ? null : TOOL_DISABLED
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
    commandEnvironment: input.config.commandEnvironment,
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

/** The compiled policy as workbenches record it, so a change to it stops their terminals and nothing else does. */
function policyHash(compiled: CompiledPolicy): string {
  return workbenchHash(JSON.stringify(compiled.policy))
}

/**
 * What reshapes a workspace's tools (fix brief 1, D), as in force: the packs offered and where the folder shows. A change
 * to either rebuilds the packs once no work is active, and refuses calls with a 409 until then. The stored browser block
 * is not among them: no pack reads it yet, so a hand edit of it changes no tool (browserInputs names what the browser
 * pack is handed, the node's settings until a later release reads each workspace's own).
 */
function reshapeInputs(settings: ResolvedSettings): string {
  return JSON.stringify([settings.packs, settings.mount])
}

/**
 * What the packs hold a copy of without reshaping: the policy lists and the variables. A change to either rebuilds the
 * packs for the next call with no wait, as the approval wait swaps in, and a call already running keeps its own.
 */
function swapInputs(settings: ResolvedSettings): string {
  return JSON.stringify([settings.policy, settings.env])
}

const BROWSER_PACK = 'browser'

/**
 * What the browser pack alone is handed (fix brief 2, R2, and its recheck): the allowed domains its approved list
 * comes to as agent-browser reads them, the mode and window settings it launches under (the node's, until a later
 * release reads each workspace's own), and the mounts its paths resolve against. Not the stored list, nor the stored
 * browser block, which the pack does not read: a rebuild for anything else, the variables, or a list changed in
 * order, port, or path only, carries the pack over with the browsers it runs, so an agent's tabs and cookies survive it.
 */
function browserInputs(input: { config: BuckleConfig; compiled: CompiledPolicy; mount: ResolvedSettings['mount'] }): string {
  const { config } = input
  const mode: BrowserMode = config.browserCdp ? { kind: 'attached', endpoint: config.browserCdp } : config.browserProfile ? { kind: 'profile', directory: config.browserProfile } : FRESH_BROWSER
  const domains = browserAllowedDomains(input.compiled.network ? [{ name: 'workspace', entries: input.compiled.network.patterns }] : [])
  return JSON.stringify([allowedDomainsKey(domains), modeFingerprint(mode, { ...(config.browserArgs === undefined ? {} : { launchArgs: config.browserArgs }), headed: config.browserHeaded }), input.mount])
}

/**
 * The packs a rebuild ends with: those built anew, except where `carried` names a pack the current set holds, which
 * keeps its place and what it runs; its twin built beside it ran nothing yet and is dropped. The rest of the current
 * set is what the rebuild replaced.
 */
function carryPacks(input: { built: Pack[]; current: Pack[]; carried: (id: string) => boolean }): { packs: Pack[]; replaced: Pack[] } {
  const packs = input.built.map(pack => (input.carried(pack.id) ? input.current.find(item => item.id === pack.id) : undefined) ?? pack)
  return { packs, replaced: input.current.filter(pack => !packs.includes(pack)) }
}

/** The policy a workspace.json holds, its own lists alone, with its own mount table's target as `mount` (null where it names none). */
function storedPolicy(settings: WorkspaceSettings): WorkspacePolicy {
  return { ...settings.policy, mount: ownMount(settings) ?? null }
}

/** The settings a runtime built without a workspace.json stands on: those its configuration was composed from. */
function settingsOf(config: BuckleConfig): WorkspaceSettings {
  return WorkspaceSettingsSchema.parse({
    ...withMount(withPolicy(WorkspaceSettingsSchema.parse({ version: 1 }), config.policy), config.policy.mount),
    packs: { enabled: config.enabledPacks ?? null, shell: config.enableShell, code: config.allowCode, hostGit: config.allowHostGit, hostLsp: config.allowHostLsp },
    browser: { ...(config.browserCdp ? { cdp: config.browserCdp } : {}), ...(config.browserProfile ? { profile: config.browserProfile } : {}), ...(config.browserArgs ? { args: config.browserArgs } : {}), headed: config.browserHeaded },
    approvalWaitMs: config.approvalTimeoutMs ?? 0,
    env: config.commandEnvironment,
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
