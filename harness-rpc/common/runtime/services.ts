import { defineSingleton, useScopeSafe, type AnyServiceDefinition, type CloseStage, type Closer, type OperationScope, type RequestCli, type RuntimeOwner, type ScopedDefinition, type SingletonDefinition } from '@5straps/runtime'
import { InteractionService, NO_INTERACTION, type InteractionPort, type InteractionSource } from '../services/approvals/interaction.js'
import { createWorkspaceManager, type WorkspaceManager } from '../services/workspaces/workspace-manager.js'
import { createRuntime, type BuckleRuntime } from '../services/workspaces/workspace-runtime.js'
import type { BuckleConfig } from './config.js'

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
}

export interface NodeIdentity {
  readonly serverId: string
}

export interface BuckleServiceDefinitions {
  workspaceRuntime: SingletonDefinition<BuckleRuntime>
  workspaces: SingletonDefinition<WorkspaceManager>
  interaction: ScopedDefinition<InteractionPort>
}

type OnClose = (stage: CloseStage, name: string, closer: Closer) => void

// Open approval waits settle at 'waiters', keeping their asks; each workspace's ownership lock goes in
// 'locks' and its history database in 'databases', after the services that use them (runtime.md, Lifecycle).
export function defineBuckleServices(input: { config: BuckleConfig; interaction: InteractionSource; onClose: OnClose }): BuckleServiceDefinitions {
  const workspaceRuntime = defineSingleton<BuckleRuntime>({
    name: 'WorkspaceRuntime',
    create: async () => {
      const runtime = await createRuntime({ config: input.config, interaction: input.interaction })
      input.onClose('waiters', 'approval waits', () => runtime.approvalService.close())
      input.onClose('locks', 'workbench ownership', () => runtime.workbenches.close())
      input.onClose('databases', 'workspace history', () => runtime.history.close())
      return runtime
    },
  })
  const workspaces = defineSingleton<WorkspaceManager>({
    name: 'WorkspaceManager',
    dependencies: [workspaceRuntime],
    create: async ({ get }) => {
      const manager = createWorkspaceManager({ config: input.config, runtime: await get(workspaceRuntime), interaction: input.interaction })
      input.onClose('waiters', 'registered workspace approval waits', async () => { for (const child of await manager.opened()) await child.approvalService.close() })
      input.onClose('locks', 'registered workspace workbenches', async () => { for (const child of await manager.opened()) await child.workbenches.close() })
      input.onClose('databases', 'registered workspace history', async () => { for (const child of await manager.opened()) await child.history.close() })
      return manager
    },
  })
  return { workspaceRuntime, workspaces, interaction: InteractionService }
}

export function serviceList(definitions: BuckleServiceDefinitions): AnyServiceDefinition[] {
  return Object.values(definitions)
}

export function createServiceAccessors(input: { owner: RuntimeOwner; definitions: BuckleServiceDefinitions; config: BuckleConfig }): BuckleServices {
  const { registry } = input.owner
  const identity: NodeIdentity = Object.freeze({ serverId: input.config.serverId })
  return {
    getWorkspaceRuntime: () => registry.useSingleton(input.definitions.workspaceRuntime),
    getWorkspaces: () => registry.useSingleton(input.definitions.workspaces),
    getInteraction: scope => registry.useScoped(input.definitions.interaction, scope),
    nodeIdentity: () => identity,
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
