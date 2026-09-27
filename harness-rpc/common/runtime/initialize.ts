import { createRuntimeOwner, type Logger, type RuntimeOwner } from '@5straps/runtime'
import type { BuckleConfig } from './config.js'
import { createServiceAccessors, defineBuckleServices, serviceList, type BuckleServices, type CommonAdapters } from './services.js'

export type RuntimeRole = 'server' | 'mcp' | 'cli'

export interface BuckleCommon {
  readonly role: RuntimeRole
  readonly owner: RuntimeOwner
  readonly services: BuckleServices
  /** Resolves every singleton, so none is first built inside a file lock or a request. */
  start(): Promise<void>
}

export interface InitializeCommonInput {
  config: BuckleConfig
  role: RuntimeRole
  adapters: CommonAdapters
  /** Receives the owner's close-step lines; a CLI command leaves it out and prints no diagnostics. */
  logger?: Logger
}

// One common runtime per process owner (nitro/runtime.md, Lifetimes); nothing runs until start().
export function initializeCommon(input: InitializeCommonInput): BuckleCommon {
  const definitions = defineBuckleServices({ config: input.config, adapters: input.adapters })
  const owner = createRuntimeOwner({ name: `buckle-${input.role}`, services: serviceList(definitions), logger: input.logger })
  const services = createServiceAccessors({ owner, definitions })
  return {
    role: input.role,
    owner,
    services,
    start: () => owner.start(() => startCommon(services)),
  }
}

// Opening the workspace runtime recovers interrupted audit and loads policy, packs and history.
async function startCommon(services: BuckleServices): Promise<void> {
  await services.getWorkspaceRuntime()
}
