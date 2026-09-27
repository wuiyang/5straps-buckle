import { defineSingleton, type AnyServiceDefinition, type CloseStage, type Closer, type RuntimeOwner, type SingletonDefinition } from '@5straps/runtime'
import type { ApprovalRegistry } from '../services/approvals/approval-registry.js'
import { createWorkspaceManager, type WorkspaceManager } from '../services/workspaces/workspace-manager.js'
import { createRuntime, type BuckleRuntime } from '../services/workspaces/workspace-runtime.js'
import type { ApprovalChannel } from '../types/ports/approval-channel.js'
import type { BuckleConfig } from './config.js'

// Supplied by the entry point, because how a gated call reaches a person depends on the transport.
export interface CommonAdapters {
  approvalChannel: (approvals: ApprovalRegistry) => ApprovalChannel
}

// Typed accessors over the runtime owner's registry (nitro/runtime.md, Lifetimes). Every Buckle
// service is a singleton today: per-operation state travels in the operation scope.
export interface BuckleServices {
  /** The node's own workspace: policy, tool registry, stores, audit and history. */
  getWorkspaceRuntime(): Promise<BuckleRuntime>
  /** The registered child workspaces, opened on first use. */
  getWorkspaces(): Promise<WorkspaceManager>
}

export interface BuckleServiceDefinitions {
  workspaceRuntime: SingletonDefinition<BuckleRuntime>
  workspaces: SingletonDefinition<WorkspaceManager>
}

type OnClose = (stage: CloseStage, name: string, closer: Closer) => void

// Each workspace's ownership lock goes in the owner's 'locks' stage and its history database in
// 'databases', after the services that use them (runtime.md, Lifecycle).
export function defineBuckleServices(input: { config: BuckleConfig; adapters: CommonAdapters; onClose: OnClose }): BuckleServiceDefinitions {
  const workspaceRuntime = defineSingleton<BuckleRuntime>({
    name: 'WorkspaceRuntime',
    create: async () => {
      const runtime = await createRuntime({ config: input.config, channel: input.adapters.approvalChannel })
      input.onClose('locks', 'workbench ownership', () => runtime.workbenches.close())
      input.onClose('databases', 'workspace history', () => runtime.history.close())
      return runtime
    },
  })
  const workspaces = defineSingleton<WorkspaceManager>({
    name: 'WorkspaceManager',
    dependencies: [workspaceRuntime],
    create: async ({ get }) => {
      const manager = createWorkspaceManager({ config: input.config, runtime: await get(workspaceRuntime) })
      input.onClose('locks', 'registered workspace workbenches', async () => { for (const child of await manager.opened()) await child.workbenches.close() })
      input.onClose('databases', 'registered workspace history', async () => { for (const child of await manager.opened()) await child.history.close() })
      return manager
    },
  })
  return { workspaceRuntime, workspaces }
}

export function serviceList(definitions: BuckleServiceDefinitions): AnyServiceDefinition[] {
  return Object.values(definitions)
}

export function createServiceAccessors(input: { owner: RuntimeOwner; definitions: BuckleServiceDefinitions }): BuckleServices {
  const { registry } = input.owner
  return {
    getWorkspaceRuntime: () => registry.useSingleton(input.definitions.workspaceRuntime),
    getWorkspaces: () => registry.useSingleton(input.definitions.workspaces),
  }
}
