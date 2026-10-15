import { createRuntimeOwner, type Logger, type RequestCli, type RuntimeOwner } from '@5straps/runtime'
import { requireOwnerOnly } from '../adapters/file-modes.js'
import type { NodeConfig } from './config.js'
import { logger } from './log.js'
import type { WorkspaceManager } from '../services/workspaces/workspace-manager.js'
import type { AskName } from '../services/workspaces/migration.js'
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
  config: NodeConfig
  role: RuntimeRole
  /** Receives the owner's close-step lines; a CLI command leaves it out and prints no diagnostics. */
  logger?: Logger
  /** Asks the owner at a terminal where the move onto workspaces needs a name (D85, Q15); a command with no terminal leaves it out. */
  askName?: AskName
}

// One common runtime per process owner (nitro/runtime.md, Lifetimes); nothing runs until start().
export function initializeCommon(input: InitializeCommonInput): BuckleCommon {
  let requester: RequestCli | undefined
  // The owner needs the definitions; their factories run after it exists and register close steps on it.
  const interaction = currentInteraction({ owner: () => owner, requester: () => requester })
  const definitions = defineBuckleServices({ config: input.config, interaction, onClose: (stage, name, closer) => owner.onClose(stage, name, closer), ...(input.askName ? { askName: input.askName } : {}) })
  const owner = createRuntimeOwner({ name: `buckle-${input.role}`, services: serviceList(definitions), logger: input.logger })
  const services = createServiceAccessors({ owner, definitions, config: input.config })
  return {
    role: input.role,
    owner,
    services,
    bindRequester(requestCli) {
      if (requester) throw new Error('This process already has its requester bound')
      requester = requestCli
    },
    start: () => owner.start(() => startCommon({ config: input.config, services, role: input.role })),
  }
}

// Opening the workspace manager migrates a node set up before the workspace model and recovers interrupted audit.
// Every singleton the process uses is built here, never first inside a file lock or a request.
async function startCommon(input: { config: NodeConfig; services: BuckleServices; role: RuntimeRole }): Promise<void> {
  const { services } = input
  // workspaces.json there holds workspace token digests and every workspace's settings (ruling 7).
  requireOwnerOnly(input.config.stateDirectory, 'directory')
  const workspaces = await services.getWorkspaces()
  // serve opens every online workspace before it is ready, so a broken one is reported at start, not at its first call
  // (the workspace-model brief, item 6); the rest still serve.
  if (input.role === 'server') await openOnline(workspaces)
  // Only the admin HTTP layer uses the node key, the seen nonces and the setup sessions, so only a
  // serve with it switched on makes or reads their files; a CLI command or MCP never does (review L11 of B23-B25).
  if (input.role !== 'server' || !input.config.experimentalAdminHttp) return
  await services.getNodeSigner()
  await services.getRequestVerifier()
  await services.getSetupSessions()
}

async function openOnline(workspaces: WorkspaceManager): Promise<void> {
  for (const workspace of workspaces.list().filter(item => item.online)) {
    try { await workspaces.resolve(workspace.id) } catch (error) {
      logger.error('A workspace could not open; it answers each call with the reason until the owner repairs it', { workspaceId: workspace.id, error })
    }
  }
}
