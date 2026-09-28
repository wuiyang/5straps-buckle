import { defineSingleton, useScopeSafe, type AnyServiceDefinition, type CloseStage, type Closer, type OperationScope, type RequestCli, type RuntimeOwner, type ScopedDefinition, type SingletonDefinition } from '@5straps/runtime'
import { InteractionService, NO_INTERACTION, type InteractionPort, type InteractionSource } from '../services/approvals/interaction.js'
import { createSetupViews, type SetupViews } from '../services/setup/setup-views.js'
import { createWorkspaceManager, type WorkspaceManager } from '../services/workspaces/workspace-manager.js'
import { createRuntime, type BuckleRuntime } from '../services/workspaces/workspace-runtime.js'
import { createRequestVerifier, type RequestVerifier } from '../services/access/signed-requests.js'
import { createFileClientKeys } from '../adapters/keys/file-client-keys.js'
import { openFileNonceStore } from '../adapters/approval/file-nonce-store.js'
import { clientKeysPath, requestNoncesPath, type BuckleConfig } from './config.js'

// Typed accessors over the runtime owner's registry (nitro/runtime.md, Lifetimes).
export interface BuckleServices {
  /** The node's own workspace: policy, tool registry, stores, audit and history. */
  getWorkspaceRuntime(): Promise<BuckleRuntime>
  /** The registered child workspaces, opened on first use. */
  getWorkspaces(): Promise<WorkspaceManager>
  /** Scoped: how this operation reaches a person. Its transport binds it once, as the operation opens. */
  getInteraction(scope?: OperationScope): Promise<InteractionPort>
  /** What /health reports, from configuration alone: known before startup, so liveness answers while the node starts. */
  nodeIdentity(): NodeIdentity
  /** What the owner's setup face reads and parses; stateless. */
  getSetupViews(): SetupViews
  /** Verifies the requests an enrolled client key signed, for the setup and approval guards (owner ruling H4). */
  getRequestVerifier(): Promise<RequestVerifier>
}

export interface NodeIdentity {
  readonly serverId: string
}

export interface BuckleServiceDefinitions {
  workspaceRuntime: SingletonDefinition<BuckleRuntime>
  workspaces: SingletonDefinition<WorkspaceManager>
  requestVerifier: SingletonDefinition<RequestVerifier>
  interaction: ScopedDefinition<InteractionPort>
}

type OnClose = (stage: CloseStage, name: string, closer: Closer) => void

/**
 * What each workspace runtime closes at shutdown, stage by stage (runtime.md, Lifecycle; B19): open
 * approval waits settle at 'waiters', keeping their asks; tool calls still running (a shell among
 * them) are cancelled at 'jobs' and answer before connections close; PTY terminals, language servers
 * and browser sessions end at 'streams'; the ownership lock goes at 'locks' and the history database
 * at 'databases', after the services that use them; queued action reports flush at 'sinks', before
 * the logger.
 */
function closeWithOwner(input: { onClose: OnClose; registered: boolean; runtimes: () => Promise<BuckleRuntime[]> }): void {
  const each = (step: (runtime: BuckleRuntime) => Promise<unknown>) => async () => { for (const runtime of await input.runtimes()) await step(runtime) }
  // Browser sessions and language servers close for every workspace at once, inside the step's one limit (review L14 of B20-B22).
  const all = (step: (runtime: BuckleRuntime) => Promise<unknown>) => async () => {
    const results = await Promise.allSettled((await input.runtimes()).map(step))
    const failures = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (failures.length > 0) throw new AggregateError(failures, 'Some workspaces could not close their sessions')
  }
  const named = (name: string) => (input.registered ? `registered workspace ${name.replace(/^workspace /, '')}` : name)
  input.onClose('waiters', named('approval waits'), each(runtime => runtime.approvalService.close()))
  input.onClose('jobs', named('tool calls'), each(runtime => runtime.cancelInvocations()))
  input.onClose('streams', named('workbench terminals'), each(runtime => runtime.workbenches.stopTerminals()))
  input.onClose('streams', named('language servers and browser sessions'), all(runtime => runtime.closeSessions()))
  input.onClose('locks', named('workbench ownership'), each(runtime => runtime.workbenches.close()))
  input.onClose('databases', named('workspace history'), each(runtime => runtime.history.close()))
  input.onClose('sinks', named('action reports'), each(runtime => runtime.reporter.flush()))
}

export function defineBuckleServices(input: { config: BuckleConfig; interaction: InteractionSource; onClose: OnClose }): BuckleServiceDefinitions {
  const workspaceRuntime = defineSingleton<BuckleRuntime>({
    name: 'WorkspaceRuntime',
    create: async () => {
      const runtime = await createRuntime({ config: input.config, interaction: input.interaction })
      closeWithOwner({ onClose: input.onClose, registered: false, runtimes: async () => [runtime] })
      return runtime
    },
  })
  const workspaces = defineSingleton<WorkspaceManager>({
    name: 'WorkspaceManager',
    dependencies: [workspaceRuntime],
    create: async ({ get }) => {
      const manager = createWorkspaceManager({ config: input.config, runtime: await get(workspaceRuntime), interaction: input.interaction })
      closeWithOwner({ onClose: input.onClose, registered: true, runtimes: () => manager.opened() })
      return manager
    },
  })
  const requestVerifier = defineSingleton<RequestVerifier>({
    name: 'RequestVerifier',
    create: async () => createRequestVerifier({
      keys: createFileClientKeys({ filePath: clientKeysPath(input.config), lockDeadlineMs: input.config.stateLockDeadlineMs }),
      nonces: await openFileNonceStore({ filePath: requestNoncesPath(input.config) }),
      serverId: input.config.serverId,
    }),
  })
  return { workspaceRuntime, workspaces, requestVerifier, interaction: InteractionService }
}

export function serviceList(definitions: BuckleServiceDefinitions): AnyServiceDefinition[] {
  return Object.values(definitions)
}

export function createServiceAccessors(input: { owner: RuntimeOwner; definitions: BuckleServiceDefinitions; config: BuckleConfig }): BuckleServices {
  const { registry } = input.owner
  const identity: NodeIdentity = Object.freeze({ serverId: input.config.serverId })
  const setupViews = createSetupViews()
  return {
    getWorkspaceRuntime: () => registry.useSingleton(input.definitions.workspaceRuntime),
    getWorkspaces: () => registry.useSingleton(input.definitions.workspaces),
    getInteraction: scope => registry.useScoped(input.definitions.interaction, scope),
    nodeIdentity: () => identity,
    getSetupViews: () => setupViews,
    getRequestVerifier: () => registry.useSingleton(input.definitions.requestVerifier),
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
