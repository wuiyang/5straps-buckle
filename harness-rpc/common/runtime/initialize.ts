import { createRuntimeOwner, type Logger, type RuntimeOwner } from '@5straps/runtime'
import { assertOwnerOnlyDirectory } from '@5straps/runtime/sqlite'
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
  // The owner needs the definitions; their factories run after it exists and register close steps on it.
  const definitions = defineBuckleServices({ config: input.config, adapters: input.adapters, onClose: (stage, name, closer) => owner.onClose(stage, name, closer) })
  const owner = createRuntimeOwner({ name: `buckle-${input.role}`, services: serviceList(definitions), logger: input.logger })
  const services = createServiceAccessors({ owner, definitions })
  return {
    role: input.role,
    owner,
    services,
    start: () => owner.start(() => startCommon({ config: input.config, services })),
  }
}

// Opening the workspace runtime recovers interrupted audit and loads policy, packs and history.
// Every singleton is built here, never first inside a file lock or a request.
async function startCommon(input: { config: BuckleConfig; services: BuckleServices }): Promise<void> {
  const { services } = input
  // workspaces.json there holds workspace credentials (ruling 7).
  assertOwnerOnlyDirectory(input.config.stateDirectory)
  await services.getWorkspaceRuntime()
  await services.getWorkspaces()
}
