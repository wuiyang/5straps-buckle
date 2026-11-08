import { defineSingleton, useScopeSafe, type AnyServiceDefinition, type CloseStage, type Closer, type OperationScope, type RequestCli, type RuntimeOwner, type ScopedDefinition, type SingletonDefinition } from '@5straps/runtime'
import { closeLogService } from '../adapters/action-log/log-service.js'
import { LOG_CLOSE_DEADLINE_MS } from './log-budget.js'
import { InteractionService, NO_INTERACTION, type InteractionPort, type InteractionSource } from './interaction.js'
import { createSetupViews, type SetupViews } from '../services/setup/setup-views.js'
import { nodeRootsOf, openWorkspaceManager, type WorkspaceManager } from '../services/workspaces/workspace-manager.js'
import type { BuckleRuntime } from '../services/workspaces/workspace-runtime.js'
import type { ActionLog } from '../types/ports/action-log.js'
import { createRequestVerifier, type RequestVerifier } from '../services/access/signed-requests.js'
import { createNodeSigner, type NodeSigner } from '../services/access/node-signer.js'
import { createSetupSessions, type SetupSessions } from '../services/access/setup-sessions.js'
import { createFileClientKeys } from '../adapters/keys/file-client-keys.js'
import { openFileNonceStore } from '../adapters/approval/file-nonce-store.js'
import { clientKeysPath, nodeKeyPath, requestNoncesPath, setupSessionsPath, type NodeConfig } from './config.js'
import type { AskName } from '../services/workspaces/migration.js'
import type { FaceSession } from '../services/workspaces/face-session.js'

// Typed accessors over the runtime owner's registry (nitro/runtime.md, Lifetimes).
export interface BuckleServices {
  /** The node's workspaces (D83), each opened on first use; migration runs before the first is read. */
  getWorkspaces(): Promise<WorkspaceManager>
  /** The node's own audit log: refusals before any workspace is known, and changes to the registry. */
  getNodeActions(): Promise<ActionLog>
  /** Scoped: how this operation reaches a person. Its transport binds it once, as the operation opens. */
  getInteraction(scope?: OperationScope): Promise<InteractionPort>
  /** What /health reports, from configuration alone: known before startup, so liveness answers while the node starts. */
  nodeIdentity(): NodeIdentity
  /** What the owner's setup face reads and parses; stateless. */
  getSetupViews(): SetupViews
  /** Whether the experimental admin HTTP layer serves at all (owner decision D8); off, its routes answer 404. */
  adminHttp(): boolean
  /** Whether BUCKLE_ADMIN_TOKEN is set: without it the node level has no owner's face, and its admin routes answer 404. */
  nodeAdminCredential(): boolean
  /** Verifies the requests an enrolled client key signed, for the setup and approval guards (owner ruling H4). */
  getRequestVerifier(): Promise<RequestVerifier>
  /** The setup sessions persons' keys opened (B24). */
  getSetupSessions(): Promise<SetupSessions>
  /** The node's own signing key, for the approval challenges it shows (B24). */
  getNodeSigner(): Promise<NodeSigner>
}

export interface NodeIdentity {
  readonly serverId: string
}

export interface BuckleServiceDefinitions {
  workspaces: SingletonDefinition<WorkspaceManager>
  requestVerifier: SingletonDefinition<RequestVerifier>
  setupSessions: SingletonDefinition<SetupSessions>
  nodeSigner: SingletonDefinition<NodeSigner>
  interaction: ScopedDefinition<InteractionPort>
}

type OnClose = (stage: CloseStage, name: string, closer: Closer) => void

/**
 * What each workspace runtime closes at shutdown, stage by stage (runtime.md, Lifecycle): at 'timers', the settings
 * watcher, so a removed folder wakes no closed runtime, and the process's face session, before any wait is settled, so
 * its asks are withdrawn; the other approval waits at 'waiters', keeping their asks; running tool
 * calls at 'jobs', answering before connections close; terminals, language servers, and browser sessions at 'streams';
 * the ownership lock at 'locks' and the history database at 'databases', after the services that use them; queued
 * audit entries and action reports at 'sinks', before the logger and the action log writer.
 */
function closeWithOwner(input: { onClose: OnClose; runtimes: () => Promise<BuckleRuntime[]> }): void {
  const each = (step: (runtime: BuckleRuntime) => Promise<unknown>) => async () => { for (const runtime of await input.runtimes()) await step(runtime) }
  // Every workspace at once, inside the step's one limit, so one that fails stops none of the others.
  const all = (step: (runtime: BuckleRuntime) => Promise<unknown>, failed: string) => async () => {
    const results = await Promise.allSettled((await input.runtimes()).map(step))
    const failures = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (failures.length > 0) throw new AggregateError(failures, failed)
  }
  input.onClose('timers', 'settings watchers', each(async runtime => runtime.closeWatchers()))
  input.onClose('timers', 'face sessions', all(runtime => runtime.endFaceSession(), 'Some workspaces could not end this process\'s session, whose approvals then end at idle or by revoke'))
  input.onClose('waiters', 'approval waits', each(runtime => runtime.closeApprovals()))
  input.onClose('jobs', 'tool calls', each(runtime => runtime.cancelInvocations()))
  input.onClose('streams', 'workbench terminals', each(runtime => runtime.workbenches.stopTerminals()))
  input.onClose('streams', 'language servers and browser sessions', all(runtime => runtime.closeSessions(), 'Some workspaces could not close their sessions'))
  input.onClose('locks', 'workbench ownership', each(runtime => runtime.workbenches.close()))
  input.onClose('databases', 'workspace history', each(runtime => runtime.history.close()))
  input.onClose('sinks', 'action reports', each(runtime => runtime.reporter.flush()))
  input.onClose('sinks', 'audit log queue', async () => { await closeLogService({ deadlineMs: LOG_CLOSE_DEADLINE_MS }) })
}

export function defineBuckleServices(input: { config: NodeConfig; interaction: InteractionSource; onClose: OnClose; faceSession?: FaceSession; askName?: AskName }): BuckleServiceDefinitions {
  // One set of roots for every workspace on the node: a program found in any of them is run by none (NodeRoots).
  const nodeRoots = nodeRootsOf(input.config)
  const workspaces = defineSingleton<WorkspaceManager>({
    name: 'WorkspaceManager',
    create: async () => {
      const manager = await openWorkspaceManager({ config: input.config, interaction: input.interaction, nodeRoots, ...(input.faceSession ? { faceSession: input.faceSession } : {}), ...(input.askName ? { askName: input.askName } : {}) })
      closeWithOwner({ onClose: input.onClose, runtimes: () => manager.opened() })
      return manager
    },
  })
  const nodeSigner = defineSingleton<NodeSigner>({ name: 'NodeSigner', create: async () => createNodeSigner(nodeKeyPath(input.config)) })
  const requestVerifier = defineSingleton<RequestVerifier>({
    name: 'RequestVerifier',
    dependencies: [nodeSigner],
    create: async ({ get }) => createRequestVerifier({
      keys: createFileClientKeys({ filePath: clientKeysPath(input.config), lockDeadlineMs: input.config.stateLockDeadlineMs }),
      nonces: await openFileNonceStore({ filePath: requestNoncesPath(input.config) }),
      serverId: input.config.serverId,
      nodeKeyId: (await get(nodeSigner)).keyId,
    }),
  })
  const setupSessions = defineSingleton<SetupSessions>({
    name: 'SetupSessions',
    create: async () => createSetupSessions({ filePath: setupSessionsPath(input.config), lockDeadlineMs: input.config.stateLockDeadlineMs }),
  })
  return { workspaces, nodeSigner, requestVerifier, setupSessions, interaction: InteractionService }
}

export function serviceList(definitions: BuckleServiceDefinitions): AnyServiceDefinition[] {
  return Object.values(definitions)
}

export function createServiceAccessors(input: { owner: RuntimeOwner; definitions: BuckleServiceDefinitions; config: NodeConfig }): BuckleServices {
  const { registry } = input.owner
  const identity: NodeIdentity = Object.freeze({ serverId: input.config.serverId })
  const setupViews = createSetupViews()
  return {
    getWorkspaces: () => registry.useSingleton(input.definitions.workspaces),
    getNodeActions: async () => (await registry.useSingleton(input.definitions.workspaces)).nodeActions,
    getInteraction: scope => registry.useScoped(input.definitions.interaction, scope),
    nodeIdentity: () => identity,
    getSetupViews: () => setupViews,
    adminHttp: () => input.config.experimentalAdminHttp,
    nodeAdminCredential: () => input.config.adminToken !== '',
    getRequestVerifier: () => registry.useSingleton(input.definitions.requestVerifier),
    getSetupSessions: () => registry.useSingleton(input.definitions.setupSessions),
    getNodeSigner: () => registry.useSingleton(input.definitions.nodeSigner),
  }
}

/**
 * The ALS getter the approval service reads: the hold bound to the operation the call runs in, with
 * the process's requester. A call outside any of this owner's live operations has none, so nobody is
 * asked; a process with no requester bound asks nobody either.
 */
export function currentInteraction(input: { owner: () => RuntimeOwner; requester: () => RequestCli | undefined }): InteractionSource {
  return async () => {
    const scope = useScopeSafe()
    const { registry } = input.owner()
    if (!scope || scope.owner !== registry.owner || (scope.state !== 'active' && scope.state !== 'draining')) return undefined
    const hold = (await registry.useScoped(InteractionService, scope)).current()
    return hold === undefined ? undefined : { requestCli: input.requester() ?? NO_INTERACTION.requestCli, hold }
  }
}
