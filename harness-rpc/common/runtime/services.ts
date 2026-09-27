import { defineSingleton, type AnyServiceDefinition, type RuntimeOwner, type SingletonDefinition } from '@5straps/runtime'
import type { ApprovalRegistry } from '../services/approvals/approval-registry.js'
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
}

export interface BuckleServiceDefinitions {
  workspaceRuntime: SingletonDefinition<BuckleRuntime>
}

export function defineBuckleServices(input: { config: BuckleConfig; adapters: CommonAdapters }): BuckleServiceDefinitions {
  return {
    workspaceRuntime: defineSingleton<BuckleRuntime>({
      name: 'WorkspaceRuntime',
      create: () => createRuntime({ config: input.config, channel: input.adapters.approvalChannel }),
    }),
  }
}

export function serviceList(definitions: BuckleServiceDefinitions): AnyServiceDefinition[] {
  return Object.values(definitions)
}

export function createServiceAccessors(input: { owner: RuntimeOwner; definitions: BuckleServiceDefinitions }): BuckleServices {
  const { registry } = input.owner
  return {
    getWorkspaceRuntime: () => registry.useSingleton(input.definitions.workspaceRuntime),
  }
}
