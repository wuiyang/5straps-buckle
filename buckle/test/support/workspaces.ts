import type { WorkspacePolicy } from '@5straps/protocol'
import type { NodeConfig } from '../../common/runtime/config.js'
import { openWorkspaceManager, type WorkspaceManager } from '../../common/services/workspaces/workspace-manager.js'
import type { InteractionSource } from '../../common/services/approvals/interaction.js'
import type { BuckleCommon } from '../../common/runtime/initialize.js'
import type { BuckleRuntime } from '../../common/services/workspaces/workspace-runtime.js'
import { openRegistry } from '../../common/services/workspaces/registry.js'
import { tokenDigest } from '../../common/services/access/tokens.js'

/** A node's workspaces as its first command opens them: a node described the 0.1 way migrates, its folder workspace default. */
export function workspacesOf(config: NodeConfig, options: { interaction?: InteractionSource; platform?: NodeJS.Platform } = {}): Promise<WorkspaceManager> {
  return openWorkspaceManager({ config, ...options })
}

/** Registers a folder as `buckle workspace init` does, with `policy` as its policy, and answers the token it was given. */
export async function registerWorkspace(manager: WorkspaceManager, input: { id: string; dir: string; name?: string; policy?: WorkspacePolicy }): Promise<string> {
  const { token } = await manager.create({ id: input.id, dir: input.dir, name: input.name ?? input.id, ...(input.policy ? { policy: input.policy } : {}) })
  return token.token
}

/** Workspace default's runtime on a started node: the folder its environment named, as migration made it. */
export async function defaultRuntime(common: BuckleCommon): Promise<BuckleRuntime> {
  return (await (await common.services.getWorkspaces()).resolve('default')).runtime
}

/**
 * Gives a registered workspace one more agent token of the test's choosing, stored by its digest as Buckle stores every
 * token, for a fixture table written before the workspace exists. Buckle itself only mints them (D83 (3)).
 */
export async function holdToken(stateDirectory: string, workspaceId: string, token: string): Promise<void> {
  await openRegistry({ stateDirectory }).update((state) => {
    const workspace = state.workspaces.find(item => item.id === workspaceId)
    if (!workspace) throw new Error(`No workspace ${workspaceId} to hold the token`)
    workspace.tokens.push({ id: `fixture-${workspace.tokens.length}`, sha256: tokenDigest(token), label: 'test fixture', createdAt: new Date().toISOString() })
  })
}
