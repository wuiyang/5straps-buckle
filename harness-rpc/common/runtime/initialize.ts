import { createRuntimeOwner, type Logger, type RequestCli, type RuntimeOwner } from '@5straps/runtime'
import { assertOwnerOnlyDirectory } from '@5straps/runtime/sqlite'
import type { BuckleConfig } from './config.js'
import { createServiceAccessors, currentInteraction, defineBuckleServices, serviceList, type BuckleServices } from './services.js'

export type RuntimeRole = 'server' | 'mcp' | 'cli'

export interface BuckleCommon {
  readonly role: RuntimeRole
  readonly owner: RuntimeOwner
  readonly services: BuckleServices
  /**
   * The process's one requester, which every operation's questions go through. Main binds it once,
   * before any request is accepted: the terminal's requester, or under serve the Nitro app's
   * cli:call dispatcher. Process-level on purpose (interaction.ts).
   */
  bindRequester(requestCli: RequestCli): void
  /** Resolves every singleton, so none is first built inside a file lock or a request. */
  start(): Promise<void>
}

export interface InitializeCommonInput {
  config: BuckleConfig
  role: RuntimeRole
  /** Receives the owner's close-step lines; a CLI command leaves it out and prints no diagnostics. */
  logger?: Logger
}

// One common runtime per process owner (nitro/runtime.md, Lifetimes); nothing runs until start().
export function initializeCommon(input: InitializeCommonInput): BuckleCommon {
  let requester: RequestCli | undefined
  // The owner needs the definitions; their factories run after it exists and register close steps on it.
  const interaction = currentInteraction({ owner: () => owner, requester: () => requester })
  const definitions = defineBuckleServices({ config: input.config, interaction, onClose: (stage, name, closer) => owner.onClose(stage, name, closer) })
  const owner = createRuntimeOwner({ name: `buckle-${input.role}`, services: serviceList(definitions), logger: input.logger })
  const services = createServiceAccessors({ owner, definitions })
  return {
    role: input.role,
    owner,
    services,
    bindRequester(requestCli) {
      if (requester) throw new Error('This process already has its requester bound')
      requester = requestCli
    },
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
