import { mountSourceState, refuseChangedFolder, validateSandboxMounts } from '../../domain/sandbox-mounts.js'
import { protectedStateRoots } from '../../runtime/config.js'
import { serviceInstalled } from '../node-service/installed.js'
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
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, watch, type FSWatcher } from 'node:fs'
import { openChangeHistory, type ChangeHistory } from '../history/journal.js'
import { mkdirSync } from 'node:fs'
import { arch, hostname, platform } from 'node:os'
import { PROTOCOL_VERSION, emptyWorkspacePolicy, type HarnessManifest, type InvokeResponse, type WorkspacePolicy, type ToolCapability } from '@5straps/protocol'
import { createFileActionLog } from '../../adapters/action-log/file-action-log.js'
import { createPluginRegistry, type PluginRegistry } from '../../adapters/plugin-registry.js'
import { createFileGrantStore } from '../../adapters/grant-store/file-grant-store.js'
import { runProcess } from '../../adapters/process-runner.js'
import { createWebhookReporter } from '../../adapters/report/webhook-reporter.js'
import { resolveSandbox, type SandboxResolution } from '../../adapters/sandbox/create-sandbox.js'
import { actionsPath, approvalNoncesPath, approvalsPath, dangerouslyAllowPath, grantsPath, pluginsPath, sandboxBinds, scratchSources, workspaceFields, type BuckleConfig } from '../../runtime/config.js'
import { createFileDangerouslyAllowStore } from '../../adapters/policy-store/file-dangerously-allow-store.js'
import type { DangerouslyAllowLevel } from '../../types/ports/dangerously-allow-store.js'
import { openFileNonceStore } from '../../adapters/approval/file-nonce-store.js'
import { createMemoryNonceClaims } from '../../adapters/approval/memory-nonce-claims.js'
import { NO_DECISION_AUDIT } from '../../adapters/approval/no-decision-audit.js'
import { availableSkills, availableTools, packDescriptor, type BrowserCloseCounts, type Pack } from '../../domain/pack.js'
import type { DeletePolicy } from '../../domain/delete-policy.js'
import { createPathView, type PathView, type ViewMount } from '../../domain/path-view.js'
import { ToolInputError, type FilledSecrets } from '../../domain/tool.js'
import { isToolAllowed } from '../../domain/tool-policy.js'
import { createPermissionEngine, type PermissionEngine } from '../../domain/permission/engine.js'
import { createCommandPolicyRule } from '../../domain/permission/rules/command-policy-rule.js'
import { createDestructiveCommandRule } from '../../domain/permission/rules/destructive-command-rule.js'
import { createDestructivePathRule } from '../../domain/permission/rules/destructive-path-rule.js'
import { createSessionReads } from '../invocation/session-reads.js'
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
import type { GrantLookup } from '../../domain/permission/decision.js'
import { createProviderJudge } from '../../adapters/judge/providers.js'
import { createProviderQuickJudge } from '../../adapters/judge/quick-providers.js'
import type { QuickJudge, QuickJudgeProvider } from '../../types/ports/quick-judge.js'
import type { Judge, JudgeProvider } from '../../types/ports/judge.js'
import { createCodeView } from '../judge/code-reader.js'
import { judgeCachePath, openJudgeCache, type JudgeCache } from '../judge/judge-cache.js'
import { openSocketCache, socketCachePath } from '../judge/socket-cache.js'
import { createSocketScanner } from '../../adapters/package-scan/socket.js'
import { nullPackageScanner, type PackageScanner } from '../../types/ports/package-scan.js'
import { createJudgeGate, JUDGE_OFF, type JudgedAsk, type JudgeGate } from '../judge/judge-gate.js'
import { resolveEffects } from '../invocation/resolve-effects.js'
import type { PendingAsk } from '../approvals/approval-registry.js'
import { createBuiltinPacks, unmetPackPrerequisite } from '../packs/index.js'
import { allowedDomainsKey, browserAllowedDomains } from '../packs/browser/allowed-domains.js'
import { FRESH_BROWSER, modeFingerprint, type BrowserMode } from '../packs/browser/mode.js'
import { journalDirectory, scriptOfAsk } from '../packs/code/journal.js'
import { loadRootSkill } from '../packs/pack-skill.js'
import type { ActionLog, AuditHealth } from '../../types/ports/action-log.js'
import type { GrantStore } from '../../types/ports/grant-store.js'
import { nullReporter, type Reporter } from '../../types/ports/reporter.js'
import { createApprovalRegistry, type ApprovalRegistry } from '../approvals/approval-registry.js'
import { approvalFaceOf, createApprovalService, type ApprovalService } from '../approvals/approval-service.js'
import type { CoreApprovalApi } from '../approvals/core-approval-api.js'
import type { ApprovalBackend } from '../../types/ports/approval-backend.js'
import { createApprovalGate, type ApprovalGate } from '../approvals/approval-gate.js'
import type { InteractionSource } from '../../runtime/interaction.js'
import { createApprovalNoticeSender, createWebhookNotifier } from '../../adapters/approval/webhook-notifier.js'
import { createTerminalBackend } from '../../adapters/approval/terminal-backend.js'
import { createApprovalNotices, type ApprovalNotices } from '../approvals/approval-notices.js'
import { createExecutionBudget, createExecutions, requestFingerprint, type ExecutionBudget } from '../invocation/executions.js'
import { createInvoker, InvocationsClosedError, recordRefusedCall, type InvokeInput } from '../invocation/invoker.js'
import { createAuditHealth } from '../audit/audit-health.js'
import { logger } from '../../runtime/log.js'
import { auditOperation } from '../audit/audit-operation.js'
import { BUCKLE_BUILD, BUCKLE_VERSION } from '../../runtime/version.js'
import { workspaceUntrusted, type NodeRoots } from './node-roots.js'
import { mountRows, openSettingsFile, ownMount, policySources, resolveSettings, settingsPath, scopeOf, withMount, withPolicy, WorkspaceSettingsSchema, type PolicySources, type ResolvedSettings, type WorkspaceSettings } from './workspace-settings.js'
import type { MountRow } from '../../domain/mount-table.js'
import { WorkspaceError } from './registry.js'
import { activeWorkDirectory, createActiveWorkMark } from './active-work.js'
import type { SecretSettings } from '../secrets/places.js'
import { logCallFeedback } from '../invocation/call-feedback.js'
import { unavailableToolReason } from '../invocation/owner-remediation.js'
import { listedSecretFile } from '../secrets/secret-file.js'

const TOOL_DISABLED = 'Disabled by workspace tool policy'

/** What a call runs under, captured as it starts. */
interface InForce {
  registry: ToolRegistry
  permissions: PermissionEngine
  /** The delete policy the permission rules were built from, which a script's deletes are counted by (DeleteRun). */
  deletes: DeletePolicy
  paths: PathView
  toolDenial(tool: string): string | null
  unavailableTool(tool: string): string | null
  toolPolicy: Pick<WorkspacePolicy, 'tools'>
  /** The decision AI as the call found the settings (D91). */
  judge: JudgeGate
  /** The secret reference settings as the call found them (docs/user/how-to/secrets.md). */
  secrets: SecretSettings
  /** What the browser pack the call runs on holds from secret references, which a browser call is masked by. */
  filledSecrets: FilledSecrets | undefined
}

/** A waiting ask the decision AI rated at its owner's request, or why it rated nothing. */
export type JudgeAskResult = { kind: 'rated'; ask: PendingAsk; judged: JudgedAsk } | { kind: 'refused'; reason: string }

/** A read the code reader asks the rules about is judged with no grant: only what the policy lets anyone read is read. */
const NO_GRANTS: GrantLookup = { subjectsFor: () => [] }

/** Why the decision AI rates no ask its stages do not cover (D91). */
const NOT_JUDGEABLE = 'The decision AI rates an ask about running a command, an interpreter the policy does not allow or one the quick stage\'s scope covers, and this ask is about something else'
/**
 * Why `buckle approvals judge` rates nothing where the ask's recorded arguments are not the call as sent (fix brief 9, B34):
 * the record keeps them with every credential hidden, and the decision AI rates only the call that runs. The raw
 * arguments are never stored beside the ask.
 */
export const CREDENTIAL_HIDDEN = 'The ask\'s recorded arguments hide a credential, so the decision AI cannot rebuild the call to read it; approve or deny it yourself, or run the workspace in automated mode, which rates the call as sent'
/** Why `buckle approvals judge` rates nothing once the policy refuses the call its token names (fix brief 7, B18). */
const POLICY_NOW_DENIES = 'The policy now denies this call; the decision AI never rates a deny'

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
   * running node at once: `on`, the level it is on at (null while off; owner ruling of 2026-10-25), and the root it is
   * bound to, as the agent names it (owner decision D7). It needs no node switch beside it (Q14).
   */
  dangerouslyAllow(): DangerouslyAllowState
  /**
   * The one switch, for the owner's local CLI only (ruling H1e), audited `policy_dangerously_allow_changed`, on at
   * `level` (`command` unless named) or off. Writes nothing the policy is read from.
   */
  setDangerouslyAllow(on: boolean, level?: DangerouslyAllowLevel): Promise<void>
}

export interface DangerouslyAllowState { on: boolean; level: DangerouslyAllowLevel | null; boundTo: string }

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
  /**
   * The name of another workspace holding this one's profile folder or attached Chrome, so every browser call here is
   * refused (Q10), else null; read at each use. Internal, for the owner's status: the manifest and the protocol carry none.
   */
  browserHeldBy(): string | null
  manifest(): HarnessManifest
  toolCatalog(): { tools: ToolCapability[]; unavailable: Array<{ name: string; reason: string }> }
  registry(): ToolRegistry
  skills(): LoadedSkill[]
  paths(): PathView
  /**
   * The mount table in force, as `buckle workspace mount list` reads it (mountRows): the folder's own entry first, then
   * each mount with where it comes from. For the owner's views alone, as it names host folders.
   */
  mountTable(): MountRow[]
  policy: PolicyHandle
  grants: GrantStore
  /** What the faces (the CLI, the MCP faces, and the setup routes) hold of the approval service. */
  approvalApi: CoreApprovalApi
  /** Settles every open wait as still pending and ends its questions; the asks stay in the durable queue. */
  closeApprovals(): Promise<void>
  /** Opens a stdio MCP host's forms under the forms source, which core holds and rates; the stdio face's alone. */
  openApprovalForms(backend: ApprovalBackend): void
  /** How a call meets approvals: its last check, the grants it holds, and its asks. */
  approvalGate: ApprovalGate
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
  /**
   * Has the decision AI rate one waiting ask at the owner's request (D91, addendum C): the call it came from is prepared
   * again from its kept arguments and judged as a new call would be, its code read afresh. Refused, naming why, where
   * nothing by that token waits, the ask is not about an interpreter the policy does not allow, or the judge is off or not set up.
   */
  judgeAsk(token: string, options?: { signal?: AbortSignal }): Promise<JudgeAskResult>
  /** Whether the decision AI's thorough stage can rate here, so --approve-if-safe can approve (fix brief 9, B37). */
  judgeApproves(): boolean
  invoke(input: InvokeInput): Promise<InvokeResponse>
  /**
   * Shutdown's in-flight tool calls step (B19): cancels every call still running here, a shell among
   * them, and waits for each to answer. Calls that arrive later are refused the same way.
   */
  cancelInvocations(): Promise<void>
  /** Shutdown's language servers and browser sessions step: each pack closes what it opened. */
  closeSessions(): Promise<void>
  /**
   * The owner's buckle browser close (Slice F4, item 6): every browser the workspace recorded, in any Buckle process,
   * closed, and every record and hold forgotten. Refused where the workspace's packs leave the browser out.
   */
  closeBrowsers(): Promise<BrowserCloseCounts>
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
  /** The name of another workspace holding this one's profile folder or attached Chrome, read at each browser call (Q10). */
  browserHeldBy?: () => string | null
  /** The decision AI, for a test; absent, each provider's is built from the node's key (BUCKLE_JUDGE_API_KEY) at its first use. */
  judge?: Judge
  /** Socket's view of packages, for a test; absent, built from the node's BUCKLE_SOCKET_API_KEY, else none. */
  packageScanner?: PackageScanner
  /** The decision AI's quick stage, for a test; absent, each provider's is built from the node's BUCKLE_QUICK_JUDGE_API_KEY. */
  quickJudge?: QuickJudge
}

/** The settings watcher's debounce (Q2): a change is taken up this long after the last write, within the 100 to 250 ms the brief allows. */
export const SETTINGS_WATCH_DEBOUNCE_MS = 150

/**
 * The runtime as core composes it: the face's view, and the approval ledger and service, which no face is handed. Only
 * what builds a runtime (the workspace manager, and tests) holds this type.
 */
export interface CoreRuntime extends BuckleRuntime {
  approvals: ApprovalRegistry
  /** The single answerer: every ask waits here and every verdict is recorded here. */
  approvalService: ApprovalService
}

export async function createRuntime(input: RuntimeInput): Promise<CoreRuntime> {
  const { config } = input
  // The sandbox masks this directory by path, so it has to exist before the first command runs.
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 })
  const history = await openChangeHistory({ directory: join(config.stateDirectory, 'history', workspaceStateKey(config.cwd)), excluded: protectedStateRoots(config), maxBytes: config.historyMaxBytes, allowHostGit: config.allowHostGit, untrusted: () => workspaceProgramTrust(input), ...config.history, label: `history:${input.workspaceId ?? config.workspaceId}` })
  let closeApprovals: (() => Promise<void>) | undefined
  try {
    return await assembleRuntime({ ...input, history, onApprovalCleanup: close => { closeApprovals = close } })
  } catch (error) {
    // No close step owns the connection until the runtime exists (runtime.md: clean up after partial initialization).
    try { await closeApprovals?.() } finally { await history.close() }
    throw error
  }
}

async function assembleRuntime(input: RuntimeInput & { history: ChangeHistory; onApprovalCleanup: (close: () => Promise<void>) => void }): Promise<CoreRuntime> {
  const { config, history } = input
  const browserStateDirectory = join(config.stateDirectory, 'browser-sessions', workspaceStateKey(config.cwd))
  mkdirSync(browserStateDirectory, { recursive: true })

  // Where no program run here may come from: this workspace's roots and every root the node knows, read at each resolution.
  const untrusted = (): UntrustedRoots => workspaceProgramTrust(input)
  // The sandbox program is refused where an agent writes, as every other program Buckle runs is.
  const sandbox = resolveSandbox({
    requested: config.sandboxMode,
    acknowledgedUnsandboxed: config.acknowledgedUnsandboxed,
    identityDirectory: join(config.stateDirectory, 'sandbox-etc'),
    ...untrusted(),
  })

  const lockDeadlineMs = config.stateLockDeadlineMs
  const workspaceId = input.workspaceId ?? config.workspaceId
  // Grants and asks are keyed by the workspace's id, so they stay its own whatever its folder is called or wherever it moves.
  const grantFile = createFileGrantStore({ filePath: grantsPath(config), workspace: workspaceId, lockDeadlineMs })
  // Every notification names its workspace, whose `buckle approve --workspace` answers it, by id and by its name as it
  // stands at each post, so a rename shows.
  const webhook = config.approvalWebhook ? { url: config.approvalWebhook, serverId: config.serverId, workspaceId, get workspaceName() { return config.serverName }, token: config.reportToken, approvalKey: config.ringsApprovalKey } : null
  let notices: ApprovalNotices | undefined
  const approvals = createApprovalRegistry(grantFile, approvalsPath(config), config.approvalTimeoutMs, {
    lockDeadlineMs, durableNotices: webhook !== null,
    onExpired: requests => notices?.expired(requests),
    onNoticeQueued: () => { void notices?.flush() },
  })
  // Every revoke goes through the ledger, so a decision's owed mark never writes a revoked grant again.
  const { grants } = approvals
  notices = createApprovalNotices(webhook ? createApprovalNoticeSender(webhook) : undefined, webhook ? { registry: approvals } : {})
  const noticeOwner = notices
  input.onApprovalCleanup(() => noticeOwner.settle())
  // Before any call runs here, so an ask an earlier build kept is answerable and a grant left owed is in force.
  await approvals.recover()
  const auditHealth = input.auditHealth ?? createAuditHealth()
  // Each entry carries the workspace's name as it stands, beside its id (D85, Q15).
  const actions = createFileActionLog(actionsPath(config), { lockDeadlineMs, health: auditHealth, workspaceId, workspaceName: () => config.serverName, ...(input.serving ? { serving: input.serving } : {}) })
  await actions.recoverInterrupted()
  // Replay protection for sealed decisions from Rings: on disk once a key is paired.
  const approvalNonces = config.ringsApprovalKey ? await openFileNonceStore({ filePath: approvalNoncesPath(config) }) : createMemoryNonceClaims()
  const interaction: InteractionSource = input.interaction ?? (async () => undefined)
  const terminal = createTerminalBackend({ requester: async () => (await interaction())?.requestCli, judgeApproves: () => inForce().judge.thoroughReady })
  const approvalService = createApprovalService({
    registry: approvals, workspaceId, serverId: config.serverId,
    // Read at each ask, so a change to approvalWaitMs applies from the next call (Q2), and a rename shows at once.
    get graceMs() { return config.approvalTimeoutMs },
    get workspaceName() { return config.serverName },
    hold: async () => (await interaction())?.hold, terminal,
    announce: webhook ? createWebhookNotifier(webhook) : undefined,
    notices, decisionKey: config.ringsApprovalKey, nonces: approvalNonces, decisionAudit: NO_DECISION_AUDIT,
  })
  input.onApprovalCleanup(() => approvalService.close())
  const approvalGate = createApprovalGate({ ledger: approvals, grants, service: approvalService })
  // The settings `buckle workspace` writes; until one does, the ones this runtime was built from.
  const settingsFile = openSettingsFile({ filePath: settingsPath(config.nodeStateDirectory ?? config.stateDirectory, workspaceId), fallback: () => settingsOf(config), lockDeadlineMs })
  const switchStore = createFileDangerouslyAllowStore({ filePath: dangerouslyAllowPath(config), workspace: workspaceId, lockDeadlineMs })
  const reporter = input.reporter ?? (config.reportUrl && config.reportToken
    ? createWebhookReporter({ url: config.reportUrl, token: config.reportToken, serverId: config.serverId, approvalKey: config.ringsApprovalKey })
    : nullReporter)
  // The decision AI's kept verdicts (D91), in this workspace's own state directory, and one judge per provider named.
  const judgeCache = openJudgeCache({ filePath: judgeCachePath(config.stateDirectory), lockDeadlineMs })
  // Socket's view of the packages the code imports, kept a day beside the verdicts (D91, addendum 2 C).
  const socketScanner = input.packageScanner ?? (config.socketApiKey ? createSocketScanner({ apiKey: config.socketApiKey, ...(config.socketBaseUrl ? { baseUrl: config.socketBaseUrl } : {}) }) : nullPackageScanner)
  const packageScanner = openSocketCache({ scanner: socketScanner, filePath: socketCachePath(config.stateDirectory), lockDeadlineMs })
  const providerJudges = new Map<JudgeProvider, Judge>()
  const judgeOf = (provider: JudgeProvider): Judge | null => {
    if (input.judge) return input.judge
    if (!config.judgeApiKey) return null
    const known = providerJudges.get(provider) ?? createProviderJudge({ provider, apiKey: config.judgeApiKey, ...(config.judgeBaseUrl ? { baseUrl: config.judgeBaseUrl } : {}) })
    providerJudges.set(provider, known)
    return known
  }
  const providerQuickJudges = new Map<QuickJudgeProvider, QuickJudge>()
  const quickJudgeOf = (provider: QuickJudgeProvider): QuickJudge | null => {
    if (input.quickJudge) return input.quickJudge
    if (!config.quickJudgeApiKey) return null
    const known = providerQuickJudges.get(provider) ?? createProviderQuickJudge({ provider, apiKey: config.quickJudgeApiKey, ...(config.quickJudgeBaseUrl ? { baseUrl: config.quickJudgeBaseUrl } : {}) })
    providerQuickJudges.set(provider, known)
    return known
  }
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
  let paths = createPathView({ root: config.cwd, mount: compiled.mount, mounts: config.mounts })
  // Read from the store at each evaluation; an unreadable store, a level it does not know among it, fails closed.
  const dangerouslyAllow = (): DangerouslyAllowState => {
    let level: DangerouslyAllowLevel | null = null
    try { level = switchStore.level() } catch { level = null }
    return { on: level !== null, level, boundTo: paths.displayRoot }
  }
  const dangerouslyAllowLevel = () => dangerouslyAllow().level
  const dangerouslyAllowed = () => dangerouslyAllow().on
  let permissions = buildPermissionEngine({ config, compiled, paths, dangerouslyAllowLevel })
  // What a code mode script reaches: this workspace's manifest as it stands at each call, after tool policy (owner
  // decision D82, point 3), and never another workspace's (BUCKLE-D07: a token opens one workspace).
  const manifestTools = (): ToolCapability[] => registry.capabilities().filter(tool => toolDenial(tool.name) === null)
  const browserHeldBy = input.browserHeldBy
  // Which runtime writes the browser's sessions, beside the pid, so a session a runtime left is told from a live one's.
  const browserInstance = randomUUID()
  const workspaceName = () => config.serverName
  const initial = await buildPacks({ config, sandbox, plugins, compiled, paths, browserStateDirectory, history, untrusted, reachableTools: manifestTools, browserHeldBy, browserInstance, workspaceName })
  let packs = initial.packs
  // The browser pack packs.enabled leaves out, kept for the owner's buckle browser close and this runtime's shutdown
  // alone, as the browsers the workspace recorded outlive the setting that turned the pack off (Codex review L7).
  let offBrowser = initial.offBrowser
  let registry = createToolRegistry(availableTools(packs))

  let activeInvocations = 0
  /** Packs a rebuild replaced while calls ran on them, closed when the last of those calls ends. */
  const retiring: Pack[] = []
  // Marked on disk while any call runs, so `buckle workspace disable` and `remove` in another process see it (finding 9).
  const activity = createActiveWorkMark({ directory: activeWorkDirectory(config.nodeStateDirectory ?? config.stateDirectory, workspaceId), workspaceId })
  const executionBudget = input.executionBudget ?? createExecutionBudget()
  const executions = createExecutions({ budget: executionBudget })
  // What each session read or wrote lately, in memory alone, for the destructive-write check: a restart forgets it.
  const sessionReads = createSessionReads()
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
      // A terminal works in the workbench's own copy, so a mount the owner shares writable is read-only there, as under shell isolation (Q6).
      // The node's scratch roots outside the folder are bound read-only too, as an isolated shell binds them: checked as a
      // mount is, and one not made yet (or gone since) holds nothing to bind or to scan, so it is left out of both.
      // Credentials inside one are masked where it shows them.
      const scratchRoots = scratchSources(config.mounts).filter(root => !isInside(config.cwd, root) && existsSync(root))
      const binds = [...sandboxBinds(config.mounts), ...scratchRoots.map(root => ({ source: root, target: root, readOnly: true }))]
      const mounts = refusedAsWorkbench(() => validateSandboxMounts(binds.map(mount => ({ ...mount, readOnly: true })), { protectedRoots: protectedStateRoots(config), workspaceRoots: [config.cwd, request.root], workspaceTarget: '/workspace' }))
      const signal = AbortSignal.timeout(15_000)
      const projection = await projectFilesystemSandbox({ root: request.root, policy: compiled.policy, signal })
      const hidden = await collectShellHiddenPaths({ roots: [request.root, ...scratchRoots, ...config.mountReadOnlyPaths], protectedPaths: [], signal })
      if (projection.hiddenPaths.some(path => isInside(path, request.cwd))) throw new WorkbenchError('Filesystem restrictions hide this terminal working directory', 403)
      const wrapped = sandbox.sandbox.wrap({ command: 'bash', args: ['--noprofile', '--norc', '-i'], cwd: request.cwd,
        workspaceRoot: request.root, writableRoots: [request.root], mount: { root: request.root, at: '/workspace' }, commandIsPid1: true,
        allowNetwork: config.shellNetwork && !compiled.policy.network.allow.length,
        hiddenPaths: [...hidden.directories, ...projection.hiddenPaths], hiddenFiles: [...hidden.files, ...projection.hiddenFiles],
        mounts, readOnlyPaths: config.mountReadOnlyPaths, readOnlyWorkspacePaths: projection.readOnlyWorkspacePaths,
      })
      // The variables a shell command gets (Q11): Buckle's, then the workspace's, then a terminal's TERM.
      const environment = Object.fromEntries(Object.entries(buildChildEnvironment({ parent: process.env, extra: { ...sandbox.sandbox.environment?.(config.mountReadOnlyPaths), ...config.commandEnvironment, TERM: 'xterm-256color' } })).filter((entry): entry is [string, string] => entry[1] !== undefined))
      return { ...wrapped, cwd: request.cwd, environment, cols: request.cols, rows: request.rows }
    },
  })

  const runtime: CoreRuntime = {
    workspaceId,
    workspaceName: () => config.serverName,
    takeUpSettings: () => pickUp(),
    workbenches,
    auditHealth,
    executionBudget,
    hasActiveWork: async () => activeInvocations > 0 || await workbenches.hasActiveWork() || runtime.shellWorkspaces.list().some(item => item.status !== 'published'),
    browserHeldBy: () => browserHeldBy?.() ?? null,
    inspectActiveWork: () => activeInvocations > 0 || workbenches.inspectActive() || runtime.shellWorkspaces.list().some(item => item.status !== 'published'),
    manifest: () => ({ history: history.capability(), ...buildManifest({ config, packs, registry, sandbox, paths, skills: allSkills(), copies: toolDenial('fs_receive') === null, searches: toolDenial('fs_search_content') === null }), tools: manifestTools() }),
    toolCatalog: () => ({ tools: registry.capabilities(), unavailable: registry.capabilities().flatMap(tool => {
      const reason = toolDenial(tool.name)
      return reason ? [{ name: tool.name, reason }] : []
    }) }),
    registry: () => registry,
    skills: allSkills,
    paths: () => paths,
    // The settings this runtime took up, as the policy's sources are read: what is in force, not a write still to apply.
    mountTable: () => mountRows(config.cwd, resolveSettings(applied, config.workspaceDefaults)),
    grants,
    approvals,
    approvalService,
    approvalApi: approvalFaceOf(approvalService),
    closeApprovals: () => approvalService.close(),
    openApprovalForms: backend => approvalService.openFormsBackend(backend),
    approvalGate,
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
      async setDangerouslyAllow(on, level = 'command') {
        const next = on ? level : null
        // No active-work check and no reload: turning it off must apply at once, and the rules read it per call.
        await auditOperation({
          actions, workspaceId, tool: 'policy_dangerously_allow_changed', sessionId: 'local-owner', describe: () => (next === null ? 'off' : `on ${next}`),
          operation: () => switchStore.set(next),
        })
        logger.warn(next === null ? 'Dangerously allow is off' : `Dangerously allow is on at level ${next}: every ask in this workspace${next === 'all' ? ', a secret reference\'s file included,' : ' but a secret reference\'s file'} is allowed without a person, and each use is audited`, { workspaceId })
      },
    },

    scriptOfAsk: token => scriptOfAsk(journalDirectory({ stateDirectory: config.stateDirectory, cwd: config.cwd }), token),

    judgeApproves: () => inForce().judge.thoroughReady,

    async judgeAsk(token, options = {}) {
      const refused = (reason: string): JudgeAskResult => ({ kind: 'refused', reason })
      const ask = approvalService.waitingAsk(token)
      if (!ask) return refused(`Nothing named ${token} is waiting for a decision in workspace ${config.serverName}`)
      const settled = inForce()
      if (settled.judge.mode === 'off') return refused(`The decision AI is off in workspace ${config.serverName}: buckle workspace set approval.judge on-request turns it on`)
      if (!settled.judge.ready) return refused(`The decision AI is not set up in workspace ${config.serverName}: the node holds no key for a stage its settings use (BUCKLE_JUDGE_API_KEY, or BUCKLE_QUICK_JUDGE_API_KEY with approval.quickJudge on)`)
      const call = ask.call
      const args = call?.complete && call.arguments !== null && typeof call.arguments === 'object' && !Array.isArray(call.arguments) ? call.arguments : null
      if (ask.request.rule !== 'destructive_command' || args === null || !settled.registry.has(ask.request.tool)) return refused(NOT_JUDGEABLE)
      // The record keeps the arguments with credentials hidden: where they no longer name the call the ask was made for,
      // the call cannot be rebuilt to rate (fix brief 9, B34).
      if (ask.fingerprint !== undefined && requestFingerprint({ tool: ask.request.tool, args }) !== ask.fingerprint) return refused(CREDENTIAL_HIDDEN)
      // Prepared again from the arguments the ask kept, as an approver saw them, and judged as a new call would be.
      let effects
      // A tool that takes the write lock itself runs its program in a copy of the folder, which the stages are told.
      let fromCopy = false
      try {
        const prepared = settled.registry.get(ask.request.tool).prepare(args)
        fromCopy = prepared.managesHistory === true
        effects = await resolveEffects({ effects: prepared.effects, paths: settled.paths })
      } catch { return refused(NOT_JUDGEABLE) }
      const outcome = settled.permissions.evaluate({ tool: ask.request.tool, effects, grants: NO_GRANTS })
      // A deny is never rated, so no stage is asked about a call the policy now refuses (fix brief 7, B18).
      if (outcome.kind === 'deny') return refused(POLICY_NOW_DENIES)
      const asks = outcome.kind === 'ask' ? outcome.asks.filter(item => settled.judge.covers(item)) : []
      // The ask the token names; an allowed command the quick stage flagged is no rule's ask, and is rated as one.
      const chosen = asks.find(item => item.subject === ask.request.subject) ?? null
      const judged = await settled.judge.rateOnRequest({ subject: ask.request.subject, ask: chosen, effects, tool: ask.request.tool, args, fromCopy, ...(options.signal ? { signal: options.signal } : {}) })
      return judged ? { kind: 'rated', ask, judged } : refused(NOT_JUDGEABLE)
    },

    async invoke(call) {
      const started = performance.now()
      try {
        if (input.serving && !input.serving()) throw new WorkspaceError('Workspace is offline', 409)
        await pickUp()
      } catch (error) {
        // Refused before the invoker, so it records nothing: the refusal is audited here, as a call refused inside it is.
        try {
          if (error instanceof WorkspaceError) await recordRefusedCall({ actions, workspaceId, call, code: error.code })
        } finally {
          logCallFeedback({ tool: call.request.tool, knownTool: registry.has(call.request.tool), code: error instanceof WorkspaceError ? error.code : 'TOOL_EXECUTION_FAILED', durationMs: performance.now() - started })
        }
        throw error
      }
      return invokeNow(call, inForce())
    },

    async cancelInvocations() {
      stopping.abort(new InvocationsClosedError())
      await Promise.allSettled([...inFlight])
    },

    closeSessions: () => closePacks([...packs, ...retiring.splice(0), ...(offBrowser ? [offBrowser] : [])]),

    async closeBrowsers() {
      const browser = packs.find(pack => pack.id === BROWSER_PACK) ?? offBrowser
      if (!browser?.closeBrowsers) throw new WorkspaceError(`Workspace ${config.serverName} has no browser pack, so it recorded no browsers`, 409)
      return browser.closeBrowsers()
    },

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
    const nextPaths = createPathView({ root: config.cwd, mount: nextCompiled.mount, mounts: nextConfig.mounts })
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
    const nextPermissions = buildPermissionEngine({ config: nextConfig, compiled: nextCompiled, paths: nextPaths, dangerouslyAllowLevel })
    const built = rebuild ? await buildPacks({ config: nextConfig, sandbox, plugins, compiled: nextCompiled, paths: nextPaths, browserStateDirectory, history, untrusted, reachableTools: manifestTools, browserHeldBy, browserInstance, workspaceName }) : null
    const next = built ? carryPacks({ built: built.packs, current: packs, carried: id => id === BROWSER_PACK && browserInputs({ config: nextConfig, compiled: nextCompiled, mounts: [resolved.mount, resolved.mounts] }) === browserInputs({ config, compiled, mounts: [before.mount, before.mounts] }) }) : null
    if (policyMoved) await workbenches.policyChanged()
    // A verdict was given under the policy in force, which its key names too; a new policy rates every call afresh.
    if (policyMoved) await judgeCache.clear().catch((error: unknown) => { logger.warn('The decision AI\'s kept verdicts could not be cleared after a policy change', { workspaceId, error }) })
    Object.assign(config, fields)
    history.configure({ ...config.history, allowHostGit: config.allowHostGit })
    applied = input.settings
    appliedVersion = input.version
    unreadVersion = undefined
    failedVersion = undefined
    compiled = nextCompiled
    paths = nextPaths
    permissions = nextPermissions
    if (next) {
      packs = next.packs
      offBrowser = built?.offBrowser
      registry = createToolRegistry(availableTools(packs))
      await retire(next.replaced)
    }
    for (const listener of listeners) listener()
  }

  /** The settings a call runs under: those in force as it starts, which a later pickup does not change for it. */
  function inForce(): InForce {
    const policy = compiled.policy
    const packView = packs.map(packDescriptor)
    const features = { enabledPacks: config.enabledPacks, enableShell: config.enableShell, allowCode: config.allowCode, allowHistory: config.allowHistory, allowHostGit: config.allowHostGit, allowHostLsp: config.allowHostLsp }
    // The values this workspace's browsers were filled with, by file and NAME, as its browser packs record them beside
    // their sessions, so every Buckle process on the workspace masks by them, after a restart too (docs/user/how-to/secrets.md).
    const filledSecrets = packs.find(pack => pack.id === BROWSER_PACK)?.filled
    return { toolPolicy: policy, unavailableTool: tool => unavailableToolReason({ tool, workspaceId, packs: packView, config: features }), registry, permissions, deletes: deletePolicyOf(config), paths, toolDenial: tool => (isToolAllowed(policy, tool) ? null : TOOL_DISABLED), judge: judgeGate({ compiled, paths, permissions, cache: judgeCache }), secrets: { enabled: config.secretsEnabled ?? true }, filledSecrets }
  }

  /**
   * The decision AI for a call (D91): the workspace's mode, each stage's provider and model, the quick stage's scope, and the standard scripts as they stand, the
   * policy and view it started under, and a code reader that reads only what the rules let anyone read.
   */
  function judgeGate(settled: { compiled: CompiledPolicy; paths: PathView; permissions: PermissionEngine; cache: JudgeCache }): JudgeGate {
    if (config.approvalJudge === 'off') return JUDGE_OFF
    const canRead = (real: string) => settled.permissions.evaluate({ tool: 'fs_read', effects: [{ kind: 'read_path', path: real, directory: dirname(real) }], grants: NO_GRANTS }).kind === 'allow'
    return createJudgeGate({
      judge: judgeOf(config.approvalJudgeProvider),
      quickJudge: config.approvalQuickJudge === 'off' ? null : quickJudgeOf(config.approvalQuickJudgeProvider),
      settings: {
        mode: config.approvalJudge, provider: config.approvalJudgeProvider, model: config.approvalJudgeModel, standardScripts: config.approvalJudgeStandardScripts,
        quick: config.approvalQuickJudge, quickProvider: config.approvalQuickJudgeProvider, quickModel: config.approvalQuickJudgeModel,
      },
      policy: settled.compiled.policy, allowedInterpreters: settled.compiled.commands.allowedInterpreters, paths: settled.paths,
      view: createCodeView({ paths: settled.paths, canRead, protectedRoots: protectedStateRoots(config) }),
      cache: settled.cache,
      scanner: packageScanner,
      screening: !dangerouslyAllowed(),
    })
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
        deletes: settled.deletes,
        approvals: approvalGate,
        executions,
        actions,
        history,
        historyRoots: () => checkpointRoots(config.cwd, settled.paths.mounts, settled.paths.mount),
        checkFolder: () => refuseChangedFolder(config.cwd, settled.paths.mount),
        reporter,
        paths: settled.paths,
        serverId: config.serverId,
        workspaceId,
        defaultTimeoutMs: config.defaultTimeoutMs,
        maxTimeoutMs: config.maxTimeoutMs,
        toolDenial: settled.toolDenial,
        unavailableTool: settled.unavailableTool,
        toolPolicy: settled.toolPolicy,
        judge: settled.judge,
        secrets: settled.secrets,
        ...(settled.filledSecrets ? { filledSecrets: settled.filledSecrets } : {}),
        protectedRoots: protectedStateRoots(config),
        reads: sessionReads,
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
    return isToolAllowed(compiled.policy, tool) ? null : TOOL_DISABLED
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
  browserHeldBy?: (() => string | null) | undefined
  browserInstance: string
  /** The workspace's name as the runtime holds it, which a rename changes in place. */
  workspaceName: () => string
}): Promise<{ packs: Pack[]; offBrowser?: Pack }> {
  const builtin = createBuiltinPacks({
    cwd: input.config.cwd,
    paths: input.paths,
    untrusted: input.untrusted,
    runProcess,
    sandbox: input.sandbox.sandbox,
    sandboxUnavailableReason: input.sandbox.unavailableReason,
    writableRoots: [input.config.cwd, ...scratchSources(input.config.mounts)],
    hiddenPaths: protectedStateRoots(input.config),
    mountReadOnlyPaths: input.config.mountReadOnlyPaths,
    sandboxMounts: sandboxBinds(input.config.mounts),
    approvedUrls: input.compiled.network,
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

/** The compiled policy as workbenches record it, so a change to it stops their terminals and nothing else does. */
function policyHash(compiled: CompiledPolicy): string {
  return workbenchHash(JSON.stringify(compiled.policy))
}

/**
 * What reshapes a workspace's tools (fix brief 1, D), as in force: the packs offered, where the folder shows, the mount
 * table, and the shell's network and isolation (Q2: the sandbox layout changes only when no work is active). A change to
 * any rebuilds the packs once no work is active, and refuses calls with a 409 until then. The browser settings are no
 * layout: they swap in (swapInputs).
 */
function reshapeInputs(settings: ResolvedSettings): string {
  return JSON.stringify([settings.packs, settings.mount, settings.mounts, settings.shell])
}

/**
 * What the packs hold a copy of without reshaping: the policy lists, the variables, and the browser settings. A change to
 * any rebuilds the packs for the next call with no wait, as the approval wait swaps in, and a call already running keeps
 * its own; the browser pack is carried over unless what it is handed changed (browserInputs).
 */
function swapInputs(settings: ResolvedSettings): string {
  return JSON.stringify([settings.policy, settings.env, settings.browser])
}

const BROWSER_PACK = 'browser'

/**
 * What the browser pack alone is handed (fix brief 2, R2, and its recheck): the allowed domains its approved list
 * comes to as agent-browser reads them, the workspace's mode, window, and idle timeout it launches under, and the
 * mounts its paths resolve against. Not the stored list: a rebuild for anything else, the variables, or a list changed
 * in order, port, or path only, carries the pack over with the browsers it runs, so an agent's tabs and cookies survive it.
 */
function browserInputs(input: { config: BuckleConfig; compiled: CompiledPolicy; mounts: [ResolvedSettings['mount'], ResolvedSettings['mounts']] }): string {
  const { config } = input
  const mode: BrowserMode = config.browserCdp ? { kind: 'attached', endpoint: config.browserCdp } : config.browserProfile ? { kind: 'profile', directory: config.browserProfile } : FRESH_BROWSER
  const domains = browserAllowedDomains(input.compiled.network ? [{ name: 'workspace', entries: input.compiled.network.patterns }] : [])
  return JSON.stringify([allowedDomainsKey(domains), modeFingerprint(mode, { ...(config.browserArgs === undefined ? {} : { launchArgs: config.browserArgs }), headed: config.browserHeaded, idleTimeoutMs: config.browserIdleTimeoutMs }), input.mounts])
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
    packs: { enabled: config.enabledPacks ?? null, shell: config.enableShell, code: config.allowCode, history: config.allowHistory, hostGit: config.allowHostGit, hostLsp: config.allowHostLsp },
    browser: { ...(config.browserCdp ? { cdp: config.browserCdp } : {}), ...(config.browserProfile ? { profile: config.browserProfile } : {}), ...(config.browserArgs ? { args: config.browserArgs } : {}), headed: config.browserHeaded, idleTimeoutMs: config.browserIdleTimeoutMs },
    approvalWaitMs: config.approvalTimeoutMs ?? 0,
    shell: { network: config.shellNetwork, isolation: config.isolateShell },
    approval: { judge: config.approvalJudge, judgeProvider: config.approvalJudgeProvider, judgeModel: config.approvalJudgeModel, judgeStandardScripts: [...config.approvalJudgeStandardScripts], quickJudge: config.approvalQuickJudge, quickJudgeProvider: config.approvalQuickJudgeProvider, quickJudgeModel: config.approvalQuickJudgeModel },
    ...(config.secretsEnabled === undefined && config.secretFiles === undefined ? {} : { secrets: { ...(config.secretsEnabled === undefined ? {} : { enabled: config.secretsEnabled }), ...(config.secretFiles === undefined ? {} : { files: [...config.secretFiles] }) } }),
    files: { deleteInWorkspace: config.deleteInWorkspace, massDeleteLimit: config.massDeleteLimit },
    env: config.commandEnvironment,
  })
}

/**
 * Whether secrets.files lists the real file a reference names (docs/user/how-to/secrets.md): each listed path names the regular file
 * that stands at it now, reached through no link, so a link at a listed name or a folder above it lists nothing.
 */
function secretFileListed(listed: readonly string[], paths: PathView, real: string): boolean {
  return listed.some(written => listedSecretFile(written, paths) === real)
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
function buildPermissionEngine(input: { config: BuckleConfig; compiled: CompiledPolicy; paths: PathView; dangerouslyAllowLevel: () => DangerouslyAllowLevel | null }): PermissionEngine {
  const { config, compiled, paths } = input
  // One policy for both rules, so a delete the floor leaves to the write scope is always judged there (relievedDelete).
  const deletes = deletePolicyOf(config)
  return withDangerouslyAllow(createPermissionEngine([
    createSensitivePathRule({ protectedRoots: protectedStateRoots(config), strict: config.strictWrites, secretListed: path => secretFileListed(config.secretFiles ?? [], paths, path) }),
    createCommandPolicyRule(compiled),
    createDestructiveCommandRule({ added: compiled.commands.destructive, allowedInterpreters: compiled.commands.allowedInterpreters, allow: compiled.commands.allow }),
    createDestructivePathRule({ paths, strict: config.strictWrites, deletes }),
    networkEgressRule(compiled),
    createProcessProbeRule(),
    createFilesystemPolicyRule({ root: config.cwd, policy: compiled.policy }),
    createReadScopeRule({ paths }),
    createWriteScopeRule({ paths, strict: config.strictWrites, deletes, pathDecision: path => filesystemPathDecision({ root: config.cwd, path, operation: 'write', policy: compiled.policy }) }),
  ]), { level: input.dangerouslyAllowLevel, root: () => paths.root })
}

/** The delete settings in force, as the rules and a script's delete count read them. */
function deletePolicyOf(config: BuckleConfig): DeletePolicy {
  return { inWorkspace: config.deleteInWorkspace, massLimit: config.massDeleteLimit }
}

function buildManifest(input: {
  config: BuckleConfig
  packs: Pack[]
  registry: ToolRegistry
  sandbox: SandboxResolution
  paths: PathView
  skills: LoadedSkill[]
  /** Whether the tool policy lets fs_receive run, which a copy into the workspace needs. */
  copies: boolean
  /** Whether the tool policy lets fs_search_content run, which the manifest's `searcher` says what runs. */
  searches: boolean
}): HarnessManifest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverId: input.config.serverId,
    name: input.config.serverName,
    description: input.config.description,
    usage: input.config.usage,
    version: BUCKLE_VERSION,
    build: BUCKLE_BUILD,
    platform: { os: platform(), arch: arch(), hostname: hostname() },
    sandbox: {
      mode: input.sandbox.sandbox.mode,
      acknowledgedUnsandboxed: input.config.acknowledgedUnsandboxed,
    },
    workspaceRoots: input.paths.displayRoots,
    tools: input.registry.capabilities(),
    skills: input.skills.map(toDescriptor),
    packs: input.packs.map(packDescriptor),
    limits: {
      maxRequestBytes: input.config.maxRequestBytes,
      defaultTimeoutMs: input.config.defaultTimeoutMs,
      maxTimeoutMs: input.config.maxTimeoutMs,
      // What `buckle cp` moves at most, where the fs pack serves fs_receive and fs_send (PUT and GET /v1/files) and the
      // tool policy lets a copy in; a node that refuses every copy offers no limit.
      ...(input.copies && input.registry.has('fs_receive') ? { maxTransferBytes: input.config.maxTransferBytes } : {}),
      // What runs a content search here, so Rings can tell a node without ripgrep (the fs-verbs brief).
      ...searcherOf(input),
    },
    generatedAt: new Date().toISOString(),
  }
}

/** The manifest's `searcher`, where the registry offers fs_search_content, the tool policy lets it run, and the fs pack names what runs it. */
function searcherOf(input: { packs: Pack[]; registry: ToolRegistry; searches: boolean }): { searcher?: 'rg' | 'builtin' } {
  const searcher = input.packs.find(pack => pack.searcher !== undefined && pack.tools.some(tool => tool.capability.name === 'fs_search_content'))?.searcher
  return searcher !== undefined && input.searches && input.registry.has('fs_search_content') ? { searcher } : {}
}

/**
 * The roots a call's checkpoint and the workspace's execution lock cover (Phase 2 item 2): the folder as it was stored,
 * and each writable mount at its stored source. A folder swapped for a link since it was registered, or gone, is refused
 * (fix brief 6, item 2), naming where it shows: history never follows the link. A mount whose source was swapped for a
 * link since it was added is left out, so nothing is snapshotted where the link lands, and so is one of the owner's
 * whose source is gone: there is nothing to checkpoint, and the folder above it is never taken in its place. A scratch
 * root not made yet is covered from the nearest folder that is, as it always was, since its first write may make it.
 */
export function checkpointRoots(folder: string, mounts: readonly ViewMount[], shownAt: string | null = null): string[] {
  refuseChangedFolder(folder, shownAt)
  const roots = [nativePath(folder)]
  for (const mount of mounts) {
    if (mount.access !== 'rw') continue
    const state = mountSourceState(mount.source)
    if (state === 'present') roots.push(nativePath(mount.source))
    else if (state === 'missing' && mount.scratch) {
      let existing = mount.source
      while (!existsSync(existing) && parentDirectory(existing) !== existing) existing = parentDirectory(existing)
      roots.push(nativePath(realpathSync(existing)))
    }
  }
  return roots
}

/** A refusal of the mounts said to the owner's terminal as the workbench says its own. */
function refusedAsWorkbench<T>(check: () => T): T {
  try { return check() } catch (error) {
    if (error instanceof ToolInputError) throw new WorkbenchError(error.message, 403)
    throw error
  }
}

function workspaceProgramTrust(input: RuntimeInput): UntrustedRoots { return workspaceUntrusted({ root: input.config.cwd, scratchRoots: scratchSources(input.config.mounts), mounts: input.config.mounts }, input.nodeRoots) }
